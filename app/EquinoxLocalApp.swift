import AppKit
import Darwin
import Foundation
import WebKit

private let controlCenterURL = URL(string: "http://127.0.0.1:24891/")!
private let allowedHost = "127.0.0.1"
private let allowedPort = 24891

private func runtimeWrapperURL() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Equinox Local/equinox-local-app-runtime")
}

private func shouldRunAsRuntimeHost() -> Bool {
    let environment = ProcessInfo.processInfo.environment
    return CommandLine.arguments.contains("--runtime-host")
        || environment["EQUINOX_LOCAL_RUNTIME_HOST"] == "1"
}

private func runRuntimeHost() -> Never {
    let wrapper = runtimeWrapperURL()
    let process = Process()
    process.executableURL = wrapper
    process.environment = ProcessInfo.processInfo.environment
    do {
        try process.run()
        process.waitUntilExit()
        exit(process.terminationStatus)
    } catch {
        fputs("Equinox Local runtime host failed: \(error.localizedDescription)\n", stderr)
        exit(70)
    }
}

private enum NativeControlError: LocalizedError {
    case invalidResponse
    case httpStatus(Int, String)
    case oversizedResponse
    case invalidPayload

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Equinox Local Control Center returned an invalid response."
        case let .httpStatus(status, message):
            return message.isEmpty ? "Equinox Local Control Center returned HTTP \(status)." : message
        case .oversizedResponse:
            return "Equinox Local Control Center response exceeded the native menu limit."
        case .invalidPayload:
            return "Equinox Local Control Center returned an invalid JSON payload."
        }
    }
}

private final class ControlCenterClient {
    private let baseURL = URL(string: "http://127.0.0.1:24891")!
    private let origin = "http://127.0.0.1:24891"
    private let maxResponseBytes = 2 * 1024 * 1024

    func get(_ path: String, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        request(path: path, method: "GET", body: nil, csrfToken: nil, completion: completion)
    }

    func mutate(_ path: String, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        get("/api/v1/session") { [weak self] sessionResult in
            guard let self else { return }
            switch sessionResult {
            case let .success(session):
                guard let csrfToken = session["csrfToken"] as? String, !csrfToken.isEmpty else {
                    completion(.failure(NativeControlError.invalidPayload))
                    return
                }
                request(
                    path: path,
                    method: "POST",
                    body: Data("{}".utf8),
                    csrfToken: csrfToken,
                    completion: completion
                )
            case let .failure(error):
                completion(.failure(error))
            }
        }
    }

    private func request(
        path: String,
        method: String,
        body: Data?,
        csrfToken: String?,
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        guard path.hasPrefix("/"), let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            completion(.failure(NativeControlError.invalidPayload))
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 2.5
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if method != "GET" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(origin, forHTTPHeaderField: "Origin")
            if let csrfToken {
                request.setValue(csrfToken, forHTTPHeaderField: "X-Equinox-CSRF")
            }
        }

        URLSession.shared.dataTask(with: request) { [maxResponseBytes] data, response, error in
            let result: Result<[String: Any], Error>
            if let error {
                result = .failure(error)
            } else if let http = response as? HTTPURLResponse, let data {
                if data.count > maxResponseBytes {
                    result = .failure(NativeControlError.oversizedResponse)
                } else {
                    do {
                        guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                            throw NativeControlError.invalidPayload
                        }
                        if (200..<300).contains(http.statusCode) {
                            result = .success(payload)
                        } else {
                            result = .failure(NativeControlError.httpStatus(http.statusCode, payload["error"] as? String ?? ""))
                        }
                    } catch {
                        result = .failure(error)
                    }
                }
            } else {
                result = .failure(NativeControlError.invalidResponse)
            }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }
}


private enum RuntimeLaunchAgentError: LocalizedError {
    case noTrustedLaunchAgent
    case ambiguousLaunchAgents
    case invalidLaunchAgent(String)
    case launchctlFailed(String)
    case launchctlTimedOut
    case runtimeStillReachable

    var errorDescription: String? {
        switch self {
        case .noTrustedLaunchAgent:
            return "No trusted Equinox Local LaunchAgent is available on this Mac."
        case .ambiguousLaunchAgents:
            return "More than one Equinox Local LaunchAgent is available and the active runtime cannot be selected safely."
        case let .invalidLaunchAgent(reason):
            return "Equinox Local refused an unsafe LaunchAgent: \(reason)"
        case let .launchctlFailed(action):
            return "Equinox Local could not \(action) its LaunchAgent."
        case .launchctlTimedOut:
            return "The macOS LaunchAgent operation timed out."
        case .runtimeStillReachable:
            return "Equinox Local stopped its LaunchAgent, but the local runtime is still reachable."
        }
    }
}

private struct TrustedLaunchAgent {
    let label: String
    let plistPath: String
}

private final class RuntimeLaunchAgentController {
    private let supportedLabels = ["dev.equinox.local.dev", "dev.equinox.local"]
    private let preferenceKey = "EquinoxLocalPreferredRuntimeLaunchAgent"
    private let maxPlistBytes = 64 * 1024
    private let queue = DispatchQueue(label: "dev.equinox.local.native-runtime-lifecycle", qos: .userInitiated)
    private let uid = getuid()

    private var domain: String { "gui/\(uid)" }
    private var expectedExecutablePath: String {
        if let executableURL = Bundle.main.executableURL {
            return executableURL.standardizedFileURL.path
        }
        return URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
    }

    func ensureStarted(completion: @escaping (Result<String, Error>) -> Void) {
        queue.async { [self] in
            let result: Result<String, Error>
            do {
                let loaded = try loadedLabels()
                if loaded.count > 1 { throw RuntimeLaunchAgentError.ambiguousLaunchAgents }
                if let label = loaded.first {
                    _ = try validateLaunchAgent(label)
                    remember(label)
                    result = .success(label)
                } else if controlCenterReachable() {
                    // Never create a second runtime beside an orphan/unmanaged listener.
                    throw RuntimeLaunchAgentError.runtimeStillReachable
                } else {
                    let candidate = try preferredCandidate()
                    let bootstrap = try runLaunchctl(["bootstrap", domain, candidate.plistPath], timeout: 3.0)
                    if bootstrap != 0, !(try isLoaded(candidate.label)) {
                        throw RuntimeLaunchAgentError.launchctlFailed("bootstrap")
                    }
                    let kickstart = try runLaunchctl(["kickstart", "\(domain)/\(candidate.label)"], timeout: 3.0)
                    if kickstart != 0, !(try isLoaded(candidate.label)) {
                        throw RuntimeLaunchAgentError.launchctlFailed("start")
                    }
                    guard try waitUntil(timeout: 3.0, condition: { try isLoaded(candidate.label) }) else {
                        throw RuntimeLaunchAgentError.launchctlFailed("start")
                    }
                    remember(candidate.label)
                    result = .success(candidate.label)
                }
            } catch {
                result = .failure(error)
            }
            DispatchQueue.main.async { completion(result) }
        }
    }

    func hardStop(completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async { [self] in
            let result: Result<Void, Error>
            do {
                let loaded = try loadedLabels()
                if loaded.count == 1, let label = loaded.first { remember(label) }
                for label in loaded {
                    _ = try validateLaunchAgent(label)
                }
                for label in loaded {
                    let status = try runLaunchctl(["bootout", "\(domain)/\(label)"], timeout: 3.0)
                    if status != 0, try isLoaded(label) {
                        throw RuntimeLaunchAgentError.launchctlFailed("stop")
                    }
                }
                guard try waitUntil(timeout: 4.0, condition: { try loadedLabels().isEmpty }) else {
                    throw RuntimeLaunchAgentError.launchctlFailed("fully stop")
                }
                guard waitForControlCenterOffline(timeout: 12.0) else {
                    throw RuntimeLaunchAgentError.runtimeStillReachable
                }
                result = .success(())
            } catch {
                result = .failure(error)
            }
            DispatchQueue.main.async { completion(result) }
        }
    }

    private func remember(_ label: String) {
        guard supportedLabels.contains(label) else { return }
        UserDefaults.standard.set(label, forKey: preferenceKey)
    }

    private func preferredCandidate() throws -> TrustedLaunchAgent {
        if let preferred = UserDefaults.standard.string(forKey: preferenceKey), supportedLabels.contains(preferred),
           let trusted = try? validateLaunchAgent(preferred) {
            return trusted
        }
        let trusted = supportedLabels.compactMap { try? validateLaunchAgent($0) }
        if trusted.count == 1, let only = trusted.first { return only }
        if trusted.isEmpty { throw RuntimeLaunchAgentError.noTrustedLaunchAgent }
        throw RuntimeLaunchAgentError.ambiguousLaunchAgents
    }

    private func launchAgentPath(_ label: String) -> String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
            .standardizedFileURL.path
    }

    private func validateLaunchAgent(_ label: String) throws -> TrustedLaunchAgent {
        guard supportedLabels.contains(label) else {
            throw RuntimeLaunchAgentError.invalidLaunchAgent("unsupported label")
        }
        let path = launchAgentPath(label)
        let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
        guard resolved == path else {
            throw RuntimeLaunchAgentError.invalidLaunchAgent("symlinked path")
        }

        var info = stat()
        let fd = path.withCString { Darwin.open($0, O_RDONLY | O_NOFOLLOW) }
        guard fd >= 0 else { throw RuntimeLaunchAgentError.invalidLaunchAgent("missing plist") }
        defer { Darwin.close(fd) }
        guard Darwin.fstat(fd, &info) == 0 else {
            throw RuntimeLaunchAgentError.invalidLaunchAgent("unreadable plist")
        }
        guard (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG), info.st_uid == uid else {
            throw RuntimeLaunchAgentError.invalidLaunchAgent("ownership or file type")
        }
        guard (info.st_mode & mode_t(0o777)) == mode_t(0o600) else {
            throw RuntimeLaunchAgentError.invalidLaunchAgent("permissions")
        }
        guard info.st_size > 0, info.st_size <= off_t(maxPlistBytes) else {
            throw RuntimeLaunchAgentError.invalidLaunchAgent("size")
        }

        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        var data = Data()
        while data.count <= maxPlistBytes {
            let remaining = maxPlistBytes + 1 - data.count
            guard remaining > 0 else { break }
            let chunk = try handle.read(upToCount: min(8192, remaining)) ?? Data()
            if chunk.isEmpty { break }
            data.append(chunk)
        }
        guard !data.isEmpty, data.count <= maxPlistBytes else {
            throw RuntimeLaunchAgentError.invalidLaunchAgent("size changed while reading")
        }
        guard let plist = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
              plist["Label"] as? String == label,
              let arguments = plist["ProgramArguments"] as? [String],
              arguments == [expectedExecutablePath],
              let environment = plist["EnvironmentVariables"] as? [String: Any],
              environment["EQUINOX_LOCAL_RUNTIME_HOST"] as? String == "1",
              plist["KeepAlive"] as? Bool == true,
              plist["RunAtLoad"] as? Bool == true else {
            throw RuntimeLaunchAgentError.invalidLaunchAgent("content")
        }
        return TrustedLaunchAgent(label: label, plistPath: path)
    }

    private func loadedLabels() throws -> [String] {
        var labels: [String] = []
        for label in supportedLabels where try isLoaded(label) {
            labels.append(label)
        }
        return labels
    }

    private func isLoaded(_ label: String) throws -> Bool {
        try runLaunchctl(["print", "\(domain)/\(label)"], timeout: 1.5) == 0
    }

    private func runLaunchctl(_ arguments: [String], timeout: TimeInterval) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.04)
        }
        if process.isRunning {
            process.terminate()
            let terminateDeadline = Date().addingTimeInterval(0.4)
            while process.isRunning, Date() < terminateDeadline {
                Thread.sleep(forTimeInterval: 0.02)
            }
            if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
            throw RuntimeLaunchAgentError.launchctlTimedOut
        }
        return process.terminationStatus
    }

    private func waitUntil(timeout: TimeInterval, condition: () throws -> Bool) throws -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if try condition() { return true }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline
        return try condition()
    }

    private func controlCenterReachable() -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 0.35
        configuration.timeoutIntervalForResource = 0.5
        let session = URLSession(configuration: configuration)
        var reachable = false
        var request = URLRequest(url: controlCenterURL)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let task = session.dataTask(with: request) { _, response, _ in
            reachable = response is HTTPURLResponse
            semaphore.signal()
        }
        task.resume()
        let wait = semaphore.wait(timeout: .now() + 0.65)
        if wait == .timedOut { task.cancel() }
        session.invalidateAndCancel()
        return wait == .success && reachable
    }

    private func waitForControlCenterOffline(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if !controlCenterReachable() { return true }
            Thread.sleep(forTimeInterval: 0.12)
        } while Date() < deadline
        return !controlCenterReachable()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate, NSMenuDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var retryWorkItem: DispatchWorkItem?
    private let controlClient = ControlCenterClient()
    private let runtimeLifecycle = RuntimeLaunchAgentController()
    private var runtimeStartInFlight = false

    private var statusItem: NSStatusItem!
    private var statusMenu: NSMenu!
    private var agentStateMenuItem: NSMenuItem!
    private var activeWorkMenuItem: NSMenuItem!
    private var agentActionMenuItem: NSMenuItem!
    private var agentBrowserStateMenuItem: NSMenuItem!
    private var agentBrowserActionMenuItem: NSMenuItem!
    private var runtimeHealthMenuItem: NSMenuItem!
    private var updateMenuItem: NSMenuItem!
    private var restartMenuItem: NSMenuItem!

    private var statusTimer: Timer?
    private var updateTimer: Timer?
    private var statusRefreshInFlight = false
    private var menuActionInFlight = false
    private var runtimeAvailable = false
    private var runtimeNeedsAttention = false
    private var agentPaused = false
    private var agentBrowserReady = false
    private var activeTerminalCount = 0
    private var activeProcessCount = 0
    private var quitPending = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMainMenu()
        configureStatusItem()
        configureWindow()
        showStartingPage()
        ensureRuntimeAndLoadControlCenter()
        refreshMenuStatus()
        refreshUpdateStatus()
        scheduleMenuRefresh()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openControlCenter(nil)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        retryWorkItem?.cancel()
        statusTimer?.invalidate()
        updateTimer?.invalidate()
    }

    func windowWillClose(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.quitPending else { return }
            NSApp.setActivationPolicy(.accessory)
            self.refreshMenuStatus()
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        refreshMenuStatus()
        refreshUpdateStatus()
    }

    private func makeMenuItem(_ title: String, action: Selector? = nil, keyEquivalent: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent)
        if action != nil { item.target = self }
        return item
    }

    private func configureStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.toolTip = "Equinox Local"

        statusMenu = NSMenu(title: "Equinox Local")
        statusMenu.delegate = self

        agentStateMenuItem = makeMenuItem("Equinox Local · Connecting")
        agentStateMenuItem.isEnabled = false
        statusMenu.addItem(agentStateMenuItem)

        activeWorkMenuItem = makeMenuItem("No active work")
        activeWorkMenuItem.isEnabled = false
        statusMenu.addItem(activeWorkMenuItem)
        statusMenu.addItem(.separator())

        agentActionMenuItem = makeMenuItem("Emergency Stop", action: #selector(toggleAgentState(_:)))
        statusMenu.addItem(agentActionMenuItem)
        statusMenu.addItem(.separator())

        statusMenu.addItem(makeMenuItem("Open Control Center", action: #selector(openControlCenter(_:)), keyEquivalent: "o"))

        agentBrowserStateMenuItem = makeMenuItem("Agent Browser · Checking")
        agentBrowserStateMenuItem.isEnabled = false
        statusMenu.addItem(agentBrowserStateMenuItem)

        agentBrowserActionMenuItem = makeMenuItem("Open Agent Browser", action: #selector(openAgentBrowser(_:)))
        statusMenu.addItem(agentBrowserActionMenuItem)
        statusMenu.addItem(.separator())

        runtimeHealthMenuItem = makeMenuItem("Runtime · Checking")
        runtimeHealthMenuItem.isEnabled = false
        statusMenu.addItem(runtimeHealthMenuItem)

        updateMenuItem = makeMenuItem("Update available", action: #selector(openControlCenter(_:)))
        updateMenuItem.isHidden = true
        statusMenu.addItem(updateMenuItem)

        restartMenuItem = makeMenuItem("Restart Equinox Local", action: #selector(restartEquinoxLocal(_:)))
        statusMenu.addItem(restartMenuItem)
        statusMenu.addItem(.separator())

        statusMenu.addItem(makeMenuItem("Quit Equinox Local", action: #selector(quitEquinoxLocal(_:)), keyEquivalent: "q"))
        statusItem.menu = statusMenu
        renderStatusMenu()
    }

    private func scheduleMenuRefresh() {
        statusTimer?.invalidate()
        updateTimer?.invalidate()

        let statusTimer = Timer(timeInterval: 8.0, repeats: true) { [weak self] _ in
            self?.refreshMenuStatus()
        }
        self.statusTimer = statusTimer
        RunLoop.main.add(statusTimer, forMode: .common)

        let updateTimer = Timer(timeInterval: 300.0, repeats: true) { [weak self] _ in
            self?.refreshUpdateStatus()
        }
        self.updateTimer = updateTimer
        RunLoop.main.add(updateTimer, forMode: .common)
    }

    private func refreshMenuStatus() {
        guard !statusRefreshInFlight else { return }
        statusRefreshInFlight = true
        controlClient.get("/api/v1/status") { [weak self] result in
            guard let self else { return }
            self.statusRefreshInFlight = false
            switch result {
            case let .success(payload):
                guard let status = payload["status"] as? [String: Any] else {
                    self.runtimeAvailable = false
                    self.renderStatusMenu()
                    return
                }
                self.applyStatus(status)
            case .failure:
                self.runtimeAvailable = false
                self.agentBrowserReady = false
                self.activeTerminalCount = 0
                self.activeProcessCount = 0
                self.renderStatusMenu()
            }
        }
    }

    private func applyStatus(_ status: [String: Any]) {
        runtimeAvailable = true

        let health = status["health"] as? [String: Any]
        let healthState = (health?["state"] as? String ?? "UNKNOWN").uppercased()
        runtimeNeedsAttention = healthState != "HEALTHY"

        if let agentControl = status["agentControl"] as? [String: Any] {
            agentPaused = agentControl["paused"] as? Bool ?? false
            if let activeWork = agentControl["activeWork"] as? [String: Any] {
                activeTerminalCount = activeWork["terminals"] as? Int ?? 0
                activeProcessCount = activeWork["processes"] as? Int ?? 0
            }
        }

        if let browser = status["browser"] as? [String: Any],
           let contexts = browser["contexts"] as? [String: Any],
           let agent = contexts["agent"] as? [String: Any] {
            agentBrowserReady = agent["ready"] as? Bool ?? false
        } else {
            agentBrowserReady = false
        }
        renderStatusMenu()
    }

    private func refreshUpdateStatus() {
        controlClient.get("/api/v1/update") { [weak self] result in
            guard let self else { return }
            guard case let .success(payload) = result, let update = payload["update"] as? [String: Any] else {
                self.updateMenuItem?.isHidden = true
                return
            }
            let available = update["updateAvailable"] as? Bool ?? false
            if available, let latest = update["latestVersion"] as? String, !latest.isEmpty {
                self.updateMenuItem.title = "Update available · \(latest)"
                self.updateMenuItem.isHidden = false
            } else {
                self.updateMenuItem.isHidden = true
            }
        }
    }

    private func renderStatusMenu() {
        guard statusItem != nil else { return }
        let stateLabel: String
        if !runtimeAvailable {
            stateLabel = "Offline"
        } else if agentPaused {
            stateLabel = "Paused"
        } else if runtimeNeedsAttention {
            stateLabel = "Needs Attention"
        } else {
            stateLabel = "Active"
        }
        agentStateMenuItem?.title = "Equinox Local · \(stateLabel)"

        let total = activeTerminalCount + activeProcessCount
        if total == 0 {
            activeWorkMenuItem?.title = "No active work"
        } else {
            let terminalLabel = activeTerminalCount == 1 ? "Terminal" : "Terminals"
            let processLabel = activeProcessCount == 1 ? "Process" : "Processes"
            activeWorkMenuItem?.title = "Active work · \(activeTerminalCount) \(terminalLabel) · \(activeProcessCount) \(processLabel)"
        }

        agentActionMenuItem?.title = agentPaused ? "Resume Agent" : "Emergency Stop"
        agentActionMenuItem?.isEnabled = runtimeAvailable && !menuActionInFlight
        agentBrowserStateMenuItem?.title = "Agent Browser · \(agentBrowserReady ? "Connected" : "Not connected")"
        agentBrowserActionMenuItem?.isEnabled = runtimeAvailable && !agentPaused && !menuActionInFlight
        runtimeHealthMenuItem?.title = runtimeAvailable
            ? "Runtime · \(runtimeNeedsAttention ? "Needs Attention" : "Healthy")"
            : "Runtime · Offline"
        restartMenuItem?.isEnabled = runtimeAvailable && !menuActionInFlight
        renderStatusIcon()
    }

    private func renderStatusIcon() {
        guard let button = statusItem.button else { return }
        button.image = nil
        button.title = ""
        button.attributedTitle = NSAttributedString(
            string: "EL",
            attributes: [
                .font: NSFont.systemFont(ofSize: 12.5, weight: .semibold),
                .foregroundColor: NSColor.labelColor,
                .kern: -0.25,
            ]
        )
        button.alphaValue = !runtimeAvailable ? 0.45 : agentPaused ? 0.58 : 1.0
        button.toolTip = "Equinox Local · \(!runtimeAvailable ? "Offline" : agentPaused ? "Paused" : runtimeNeedsAttention ? "Needs Attention" : "Active")"
    }

    private func runMenuMutation(_ path: String, completion: @escaping (Bool) -> Void) {
        guard !menuActionInFlight else { return }
        menuActionInFlight = true
        renderStatusMenu()
        controlClient.mutate(path) { [weak self] result in
            guard let self else { return }
            self.menuActionInFlight = false
            switch result {
            case .success:
                completion(true)
            case .failure:
                NSSound.beep()
                completion(false)
            }
            self.renderStatusMenu()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                self?.refreshMenuStatus()
            }
        }
    }

    @objc private func toggleAgentState(_ sender: Any?) {
        guard runtimeAvailable else { NSSound.beep(); return }
        let path = agentPaused ? "/api/v1/agent/resume" : "/api/v1/agent/pause"
        runMenuMutation(path) { [weak self] success in
            guard success, let self else { return }
            self.agentPaused.toggle()
            self.activeTerminalCount = 0
            self.activeProcessCount = 0
            self.renderStatusMenu()
        }
    }

    private func ensureRuntimeAndLoadControlCenter() {
        guard !runtimeStartInFlight else { return }
        runtimeStartInFlight = true
        runtimeLifecycle.ensureStarted { [weak self] result in
            guard let self else { return }
            self.runtimeStartInFlight = false
            switch result {
            case .success:
                self.loadControlCenterWhenReady()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in self?.refreshMenuStatus() }
            case let .failure(error):
                self.runtimeAvailable = false
                self.renderStatusMenu()
                self.showRuntimeLifecycleError(title: "Equinox Local could not start", error: error)
            }
        }
    }

    private func showRuntimeLifecycleError(title: String, error: Error) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    @objc private func openControlCenter(_ sender: Any?) {
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if !runtimeAvailable {
            showStartingPage()
            ensureRuntimeAndLoadControlCenter()
        }
        refreshMenuStatus()
    }

    @objc private func openAgentBrowser(_ sender: Any?) {
        guard runtimeAvailable, !agentPaused else { NSSound.beep(); return }
        runMenuMutation("/api/v1/browser/agent/open") { _ in }
    }

    @objc private func restartEquinoxLocal(_ sender: Any?) {
        guard runtimeAvailable else { NSSound.beep(); return }
        runMenuMutation("/api/v1/runtime/restart") { [weak self] success in
            guard success, let self else { return }
            self.runtimeAvailable = false
            self.renderStatusMenu()
            self.showStartingPage()
            self.loadControlCenterWhenReady()
        }
    }

    @objc private func quitEquinoxLocal(_ sender: Any?) {
        guard !quitPending else { return }
        quitPending = true
        statusTimer?.invalidate()
        updateTimer?.invalidate()
        menuActionInFlight = true
        renderStatusMenu()

        runtimeLifecycle.hardStop { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                NSApp.terminate(nil)
            case let .failure(error):
                self.quitPending = false
                self.menuActionInFlight = false
                self.scheduleMenuRefresh()
                self.refreshMenuStatus()
                self.showRuntimeLifecycleError(title: "Equinox Local could not quit safely", error: error)
            }
        }
    }

    private func configureMainMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Equinox Local", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        let quitItem = appMenu.addItem(withTitle: "Quit Equinox Local", action: #selector(quitEquinoxLocal(_:)), keyEquivalent: "q")
        quitItem.target = self
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)
        NSApp.mainMenu = mainMenu
    }

    private func configureWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.isElementFullscreenEnabled = false

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        let contentRect = NSRect(x: 0, y: 0, width: 1180, height: 760)
        window = NSWindow(
            contentRect: contentRect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Equinox Local"
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 920, height: 620)
        window.center()
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
    }

    private func showStartingPage() {
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark">
        <style>
        *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;background:#0b0d11;color:#f5f7fb}
        body{display:grid;place-items:center}.wrap{text-align:center;max-width:520px;padding:48px}.mark{width:72px;height:72px;border-radius:18px;margin:0 auto 24px;box-shadow:0 18px 60px rgba(70,170,255,.2)}
        h1{font-size:25px;margin:0 0 8px;letter-spacing:-.035em}p{margin:0;color:#8d96a8;font-size:14px;line-height:1.6}.dot{display:inline-block;width:7px;height:7px;margin-right:8px;border-radius:50%;background:#65d392;box-shadow:0 0 18px rgba(101,211,146,.55)}
        </style></head><body><div class="wrap"><h1>Equinox Local</h1><p><span class="dot"></span>Control Center is starting on this Mac…</p></div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func loadControlCenterWhenReady() {
        retryWorkItem?.cancel()
        var request = URLRequest(url: controlCenterURL)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 1.5
        request.setValue("text/html,application/json", forHTTPHeaderField: "Accept")

        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            guard let self else { return }
            if let http = response as? HTTPURLResponse, (200..<500).contains(http.statusCode) {
                DispatchQueue.main.async {
                    self.webView.load(URLRequest(url: controlCenterURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5))
                }
                return
            }
            let item = DispatchWorkItem { [weak self] in self?.loadControlCenterWhenReady() }
            self.retryWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: item)
        }.resume()
    }

    private func isAllowedControlCenterURL(_ url: URL) -> Bool {
        guard url.scheme == "http", url.host == allowedHost else { return false }
        return url.port == allowedPort
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.scheme == "about" || isAllowedControlCenterURL(url) {
            decisionHandler(.allow)
            return
        }
        if ["https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showStartingPage()
        loadControlCenterWhenReady()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showStartingPage()
        loadControlCenterWhenReady()
    }
}

if shouldRunAsRuntimeHost() {
    runRuntimeHost()
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = AppDelegate()
application.delegate = delegate
application.run()
