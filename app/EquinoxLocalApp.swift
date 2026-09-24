import AppKit
import Darwin
import Foundation
import UserNotifications
import WebKit

private let controlCenterURL = URL(string: "http://127.0.0.1:24891/")!
private let allowedHost = "127.0.0.1"
private let allowedPort = 24891
private let nativeLanguageMessageHandler = "equinoxNativeLanguage"
private let nativeProcessSessionHelperEnvironmentKey = "EQUINOX_LOCAL_NATIVE_PROCESS_HELPER"
private let internalProcessSessionIdArgument = "--internal-process-session-id"
private let internalProcessSessionPidsArgument = "--internal-process-session-pids"

private func parsePositivePID(_ raw: String) -> pid_t? {
    guard let value = Int32(raw), value > 0 else { return nil }
    return pid_t(value)
}

private func writeStdoutLine(_ value: String) {
    FileHandle.standardOutput.write(Data((value + "\n").utf8))
}

private func runInternalProcessSessionCommandIfRequested() {
    let arguments = CommandLine.arguments
    guard arguments.count >= 2 else { return }
    let mode = arguments[1]
    guard mode == internalProcessSessionIdArgument || mode == internalProcessSessionPidsArgument else { return }
    guard arguments.count == 3, let requested = parsePositivePID(arguments[2]) else {
        fputs("Equinox Local internal process-session query received invalid arguments.\n", stderr)
        exit(64)
    }

    if mode == internalProcessSessionIdArgument {
        let sessionId = getsid(requested)
        guard sessionId > 0 else {
            exit(errno == ESRCH ? 3 : 70)
        }
        writeStdoutLine(String(sessionId))
        exit(0)
    }

    let ps = Process()
    let output = Pipe()
    ps.executableURL = URL(fileURLWithPath: "/bin/ps")
    ps.arguments = ["-axo", "pid="]
    ps.standardOutput = output
    ps.standardError = FileHandle.nullDevice
    do {
        try ps.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        ps.waitUntilExit()
        guard ps.terminationStatus == 0, data.count <= 2 * 1024 * 1024 else { exit(70) }
        let text = String(decoding: data, as: UTF8.self)
        for line in text.split(whereSeparator: \.isNewline) {
            guard let pid = parsePositivePID(String(line).trimmingCharacters(in: .whitespaces)),
                  getsid(pid) == requested else { continue }
            writeStdoutLine(String(pid))
        }
        exit(0)
    } catch {
        exit(70)
    }
}

private enum NativeLanguage: String {
    case english = "en"
    case turkish = "tr"

    static func initial(userDefaults: UserDefaults = .standard) -> NativeLanguage {
        if let stored = userDefaults.string(forKey: "EquinoxLocalNativeLanguage"),
           let language = NativeLanguage(rawValue: stored) {
            return language
        }
        let preferred = Locale.preferredLanguages.first?.lowercased() ?? ""
        return preferred.hasPrefix("tr") ? .turkish : .english
    }
}

private func runtimeWrapperURL() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Equinox Local/equinox-local-app-runtime")
}

private func shouldRunAsRuntimeHost() -> Bool {
    let environment = ProcessInfo.processInfo.environment
    return CommandLine.arguments.contains("--runtime-host")
        || environment["EQUINOX_LOCAL_RUNTIME_HOST"] == "1"
}

private func foregroundShellIsRunning() -> Bool {
    guard let bundleIdentifier = Bundle.main.bundleIdentifier else { return false }
    let currentPID = getpid()
    return NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).contains { application in
        !application.isTerminated && application.processIdentifier != currentPID
    }
}

private func launchForegroundShellIfNeeded() {
    guard !foregroundShellIsRunning() else { return }
    let opener = Process()
    opener.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    opener.arguments = ["-gn", Bundle.main.bundlePath, "--args", "--restart-shell"]
    var environment = ProcessInfo.processInfo.environment
    environment.removeValue(forKey: "EQUINOX_LOCAL_RUNTIME_HOST")
    environment.removeValue(forKey: nativeProcessSessionHelperEnvironmentKey)
    environment.removeValue(forKey: "XPC_SERVICE_NAME")
    opener.environment = environment
    opener.standardOutput = FileHandle.nullDevice
    opener.standardError = FileHandle.nullDevice
    do {
        try opener.run()
    } catch {
        fputs("Equinox Local foreground shell launch failed: \(error.localizedDescription)\n", stderr)
    }
}

private func runRuntimeHost() -> Never {
    let wrapper = runtimeWrapperURL()
    let process = Process()
    process.executableURL = wrapper
    var environment = ProcessInfo.processInfo.environment
    if let executablePath = Bundle.main.executableURL?.standardizedFileURL.path {
        environment[nativeProcessSessionHelperEnvironmentKey] = executablePath
    }
    process.environment = environment
    do {
        try process.run()
        launchForegroundShellIfNeeded()
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

    func get(
        _ path: String,
        backgroundRefresh: Bool = false,
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        request(
            path: path,
            method: "GET",
            body: nil,
            csrfToken: nil,
            backgroundRefresh: backgroundRefresh,
            completion: completion
        )
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
                    backgroundRefresh: false,
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
        backgroundRefresh: Bool,
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
        if backgroundRefresh && method == "GET" {
            request.setValue("1", forHTTPHeaderField: "X-Equinox-Background-Refresh")
        }
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

private enum CodexPetState: String {
    case idle
    case runningRight = "running-right"
    case runningLeft = "running-left"
    case waving
    case jumping
    case failed
    case waiting
    case running
    case review
}

private struct CodexPetAnimation {
    let row: Int
    let frameDurations: [TimeInterval]
}

private enum EquinoxFloatingPetPack {
    static let identifier = "nyx-atlas-v2"
    static let assetName = "EquinoxCompanionNyx"
    static let assetExtension = "webp"
    static let sheetPixelSize = NSSize(width: 1536, height: 2288)
    static let cellPixelSize = NSSize(width: 192, height: 208)
    static let slowIdleDurations: [TimeInterval] = [1.680, 0.660, 0.660, 0.840, 0.840, 1.920]

    static let animations: [CodexPetState: CodexPetAnimation] = [
        .idle: CodexPetAnimation(row: 0, frameDurations: slowIdleDurations),
        .runningRight: CodexPetAnimation(row: 1, frameDurations: [0.120, 0.120, 0.120, 0.120, 0.120, 0.120, 0.120, 0.220]),
        .runningLeft: CodexPetAnimation(row: 2, frameDurations: [0.120, 0.120, 0.120, 0.120, 0.120, 0.120, 0.120, 0.220]),
        .waving: CodexPetAnimation(row: 3, frameDurations: [0.140, 0.140, 0.140, 0.280]),
        .jumping: CodexPetAnimation(row: 4, frameDurations: [0.140, 0.140, 0.140, 0.140, 0.280]),
        .failed: CodexPetAnimation(row: 5, frameDurations: [0.140, 0.140, 0.140, 0.140, 0.140, 0.140, 0.140, 0.240]),
        .waiting: CodexPetAnimation(row: 6, frameDurations: [0.150, 0.150, 0.150, 0.150, 0.150, 0.260]),
        .running: CodexPetAnimation(row: 7, frameDurations: [0.120, 0.120, 0.120, 0.120, 0.120, 0.220]),
        .review: CodexPetAnimation(row: 8, frameDurations: [0.150, 0.150, 0.150, 0.150, 0.150, 0.280]),
    ]

    static func state(for presentationState: String) -> CodexPetState {
        switch presentationState {
        case "working": return .running
        case "waiting": return .waiting
        case "success": return .review
        case "needs_attention", "emergency_stopped", "offline": return .failed
        default: return .idle
        }
    }

    static func loadSheet() -> NSImage? {
        var candidates: [URL] = []
        if let bundled = Bundle.main.url(forResource: assetName, withExtension: assetExtension) {
            candidates.append(bundled)
        }
        candidates.append(
            URL(fileURLWithPath: CommandLine.arguments[0])
                .deletingLastPathComponent()
                .appendingPathComponent("\(assetName).\(assetExtension)")
        )
        for url in candidates where FileManager.default.fileExists(atPath: url.path) {
            guard let image = NSImage(contentsOf: url) else { continue }
            let valid = image.representations.contains {
                $0.pixelsWide == Int(sheetPixelSize.width) && $0.pixelsHigh == Int(sheetPixelSize.height)
            }
            if valid { return image }
        }
        return nil
    }

    static func lookCell(angleDegrees: Double) -> (row: Int, column: Int) {
        var normalized = angleDegrees.truncatingRemainder(dividingBy: 360)
        if normalized < 0 { normalized += 360 }
        let slot = Int((normalized / 22.5).rounded()) % 16
        return slot < 8 ? (9, slot) : (10, slot - 8)
    }
}

private final class EquinoxCompanionSpriteView: NSView {
    private let sheetImage: NSImage?
    private var animationTimer: Timer?
    private var baseState: CodexPetState = .idle
    private var selectedState: CodexPetState = .idle
    private var visualState: CodexPetState = .idle
    private var frameIndex = 0
    private var completedCycles = 0
    private var automaticIdleFallback = false
    private var lookCell: (row: Int, column: Int)?
    private var lastMousePoint: NSPoint?
    private var isHovered = false
    private var isDraggingCompanion = false
    private var isPaused = false
    private var reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    var onPrimaryClick: (() -> Void)?

    override var mouseDownCanMoveWindow: Bool { false }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard event.buttonNumber == 0, let window else {
            super.mouseDown(with: event)
            return
        }
        let startOrigin = window.frame.origin
        window.performDrag(with: event)
        let endOrigin = window.frame.origin
        let distance = hypot(
            Double(endOrigin.x - startOrigin.x),
            Double(endOrigin.y - startOrigin.y)
        )
        if distance < 4 {
            onPrimaryClick?()
        }
    }

    init(frame frameRect: NSRect, sheetImage: NSImage?) {
        self.sheetImage = sheetImage
        super.init(frame: frameRect)
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("Nyx companion")
        addTrackingArea(NSTrackingArea(
            rect: .zero,
            options: [.activeAlways, .mouseEnteredAndExited, .mouseMoved, .inVisibleRect],
            owner: self,
            userInfo: nil
        ))
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(accessibilityDisplayOptionsChanged(_:)),
            name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
            object: nil
        )
        restartAnimation()
    }

    required init?(coder: NSCoder) { nil }

    override func accessibilityPerformPress() -> Bool {
        guard !isPaused else { return false }
        onPrimaryClick?()
        return true
    }

    deinit {
        animationTimer?.invalidate()
        NSWorkspace.shared.notificationCenter.removeObserver(self)
    }

    func setBasePresentationState(_ presentationState: String) {
        let next = EquinoxFloatingPetPack.state(for: presentationState)
        guard next != baseState else { return }
        baseState = next
        if !isHovered && !isDraggingCompanion {
            selectedState = next
            restartAnimation()
        }
    }

    func setPaused(_ paused: Bool) {
        guard paused != isPaused else { return }
        isPaused = paused
        if paused {
            animationTimer?.invalidate()
            animationTimer = nil
        } else {
            restartAnimation()
        }
    }

    func setDragDirection(rightward: Bool) {
        isDraggingCompanion = true
        lookCell = nil
        let next: CodexPetState = rightward ? .runningRight : .runningLeft
        guard selectedState != next else { return }
        selectedState = next
        restartAnimation()
    }

    func endDrag() {
        guard isDraggingCompanion else { return }
        isDraggingCompanion = false
        lookCell = nil
        selectedState = isHovered ? .jumping : baseState
        restartAnimation()
    }

    override func mouseEntered(with event: NSEvent) {
        isHovered = true
        lastMousePoint = convert(event.locationInWindow, from: nil)
        guard !isDraggingCompanion else { return }
        selectedState = .jumping
        restartAnimation()
    }

    override func mouseMoved(with event: NSEvent) {
        lastMousePoint = convert(event.locationInWindow, from: nil)
        guard isHovered, !isDraggingCompanion, automaticIdleFallback || reduceMotion else { return }
        updateLookCell()
    }

    override func mouseExited(with event: NSEvent) {
        isHovered = false
        lastMousePoint = nil
        lookCell = nil
        guard !isDraggingCompanion else { return }
        selectedState = baseState
        restartAnimation()
    }

    @objc private func accessibilityDisplayOptionsChanged(_ notification: Notification) {
        reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        restartAnimation()
    }

    private func restartAnimation() {
        animationTimer?.invalidate()
        animationTimer = nil
        lookCell = nil
        visualState = selectedState
        frameIndex = 0
        completedCycles = 0
        automaticIdleFallback = false
        needsDisplay = true
        setAccessibilityValue(selectedState.rawValue)
        guard !isPaused, !reduceMotion else { return }
        scheduleCurrentFrame()
    }

    private func scheduleCurrentFrame() {
        guard !isPaused, !reduceMotion, lookCell == nil,
              let animation = EquinoxFloatingPetPack.animations[visualState],
              !animation.frameDurations.isEmpty else { return }
        let safeIndex = min(frameIndex, animation.frameDurations.count - 1)
        let timer = Timer(timeInterval: animation.frameDurations[safeIndex], repeats: false) { [weak self] _ in
            self?.advanceFrame()
        }
        animationTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func advanceFrame() {
        animationTimer = nil
        guard !isPaused, !reduceMotion, lookCell == nil,
              let animation = EquinoxFloatingPetPack.animations[visualState] else { return }
        let nextFrame = frameIndex + 1
        if nextFrame < animation.frameDurations.count {
            frameIndex = nextFrame
            needsDisplay = true
            scheduleCurrentFrame()
            return
        }
        if visualState == .idle {
            frameIndex = 0
            needsDisplay = true
            scheduleCurrentFrame()
            return
        }
        completedCycles += 1
        if completedCycles < 3 {
            frameIndex = 0
            needsDisplay = true
            scheduleCurrentFrame()
            return
        }
        automaticIdleFallback = true
        visualState = .idle
        frameIndex = 0
        completedCycles = 0
        if isHovered && selectedState == .jumping && !isDraggingCompanion {
            updateLookCell()
            if lookCell != nil { return }
        }
        needsDisplay = true
        scheduleCurrentFrame()
    }

    private func updateLookCell() {
        guard let point = lastMousePoint else { return }
        let dx = Double(point.x - bounds.midX)
        let dy = Double(point.y - bounds.midY)
        guard hypot(dx, dy) > 1 else {
            lookCell = nil
            visualState = .idle
            frameIndex = 0
            needsDisplay = true
            scheduleCurrentFrame()
            return
        }
        lookCell = EquinoxFloatingPetPack.lookCell(angleDegrees: atan2(dx, dy) * 180 / Double.pi)
        animationTimer?.invalidate()
        animationTimer = nil
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let sheetImage else {
            let text = NSAttributedString(string: "EL", attributes: [
                .font: NSFont.systemFont(ofSize: 24, weight: .semibold),
                .foregroundColor: NSColor.secondaryLabelColor,
            ])
            let size = text.size()
            text.draw(at: NSPoint(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2))
            return
        }
        let cell: (row: Int, column: Int)
        if let lookCell {
            cell = lookCell
        } else {
            let stateForFrame = reduceMotion ? selectedState : visualState
            guard let animation = EquinoxFloatingPetPack.animations[stateForFrame] else { return }
            cell = (animation.row, reduceMotion ? 0 : frameIndex)
        }
        let cellWidth = EquinoxFloatingPetPack.cellPixelSize.width
        let cellHeight = EquinoxFloatingPetPack.cellPixelSize.height
        let source = NSRect(
            x: CGFloat(cell.column) * cellWidth,
            y: EquinoxFloatingPetPack.sheetPixelSize.height - CGFloat(cell.row + 1) * cellHeight,
            width: cellWidth,
            height: cellHeight
        )
        let aspect = cellWidth / cellHeight
        let targetWidth = min(bounds.width, bounds.height * aspect)
        let targetHeight = targetWidth / aspect
        let target = NSRect(
            x: bounds.midX - targetWidth / 2,
            y: bounds.midY - targetHeight / 2,
            width: targetWidth,
            height: targetHeight
        )
        NSGraphicsContext.current?.imageInterpolation = .none
        sheetImage.draw(in: target, from: source, operation: .sourceOver, fraction: 1.0)
    }
}


private final class EquinoxCompanionActionRow: NSControl {
    private let iconView = NSImageView()
    private let titleField = NSTextField(labelWithString: "")
    private var hoverTrackingArea: NSTrackingArea?

    init(title: String, symbolName: String, target: AnyObject?, action: Selector?) {
        super.init(frame: .zero)
        self.target = target
        self.action = action
        wantsLayer = true
        layer?.cornerRadius = 9
        layer?.cornerCurve = .continuous
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)

        if let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: title) {
            iconView.image = image
            iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
            iconView.contentTintColor = .secondaryLabelColor
        }
        iconView.imageScaling = .scaleProportionallyDown
        iconView.translatesAutoresizingMaskIntoConstraints = false

        titleField.stringValue = title
        titleField.font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
        titleField.textColor = .labelColor
        titleField.lineBreakMode = .byTruncatingTail
        titleField.translatesAutoresizingMaskIntoConstraints = false

        addSubview(iconView)
        addSubview(titleField)
        NSLayoutConstraint.activate([
            iconView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 11),
            iconView.centerYAnchor.constraint(equalTo: centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 16),
            iconView.heightAnchor.constraint(equalToConstant: 16),
            titleField.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 9),
            titleField.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -10),
            titleField.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverTrackingArea { removeTrackingArea(hoverTrackingArea) }
        let next = NSTrackingArea(
            rect: .zero,
            options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(next)
        hoverTrackingArea = next
    }

    override func mouseEntered(with event: NSEvent) {
        layer?.backgroundColor = NSColor.selectedContentBackgroundColor.withAlphaComponent(0.16).cgColor
    }

    override func mouseExited(with event: NSEvent) {
        layer?.backgroundColor = NSColor.clear.cgColor
    }

    override func mouseDown(with event: NSEvent) {
        guard event.buttonNumber == 0 else { return }
        layer?.backgroundColor = NSColor.selectedContentBackgroundColor.withAlphaComponent(0.25).cgColor
    }

    override func mouseUp(with event: NSEvent) {
        guard event.buttonNumber == 0 else { return }
        let local = convert(event.locationInWindow, from: nil)
        layer?.backgroundColor = bounds.contains(local)
            ? NSColor.selectedContentBackgroundColor.withAlphaComponent(0.16).cgColor
            : NSColor.clear.cgColor
        guard bounds.contains(local), let action else { return }
        NSApp.sendAction(action, to: target, from: self)
    }
}

private final class EquinoxCompanionSpeechView: NSView {
    private let tailHeight: CGFloat = 10
    private let cornerRadius: CGFloat = 14
    private var tailAtBottom = true
    private var tailX: CGFloat = 48

    override var isOpaque: Bool { false }

    func updateShape(tailAtBottom: Bool, tailX: CGFloat) {
        self.tailAtBottom = tailAtBottom
        self.tailX = tailX
        needsDisplay = true
    }

    private func bubblePath() -> NSBezierPath {
        let clampedTailX = min(max(tailX, 26), bounds.width - 26)
        let body = tailAtBottom
            ? NSRect(x: 0.5, y: tailHeight, width: bounds.width - 1, height: bounds.height - tailHeight - 0.5)
            : NSRect(x: 0.5, y: 0.5, width: bounds.width - 1, height: bounds.height - tailHeight - 0.5)
        let path = NSBezierPath(roundedRect: body, xRadius: cornerRadius, yRadius: cornerRadius)
        let tail = NSBezierPath()
        if tailAtBottom {
            tail.move(to: NSPoint(x: clampedTailX - 8, y: tailHeight + 1))
            tail.line(to: NSPoint(x: clampedTailX, y: 0.5))
            tail.line(to: NSPoint(x: clampedTailX + 8, y: tailHeight + 1))
        } else {
            let top = bounds.height - tailHeight
            tail.move(to: NSPoint(x: clampedTailX - 8, y: top - 1))
            tail.line(to: NSPoint(x: clampedTailX, y: bounds.height - 0.5))
            tail.line(to: NSPoint(x: clampedTailX + 8, y: top - 1))
        }
        tail.close()
        path.append(tail)
        return path
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let path = bubblePath()
        NSColor.windowBackgroundColor.withAlphaComponent(0.98).setFill()
        path.fill()
        NSColor.separatorColor.withAlphaComponent(0.42).setStroke()
        path.lineWidth = 0.7
        path.stroke()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, NSWindowDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var retryWorkItem: DispatchWorkItem?
    private let controlClient = ControlCenterClient()
    private let runtimeLifecycle = RuntimeLaunchAgentController()
    private var runtimeStartInFlight = false
    private let notificationCenter = UNUserNotificationCenter.current()
    private var notificationBaselineEstablished = false
    private var lastNotificationCandidateId: String?
    private var presentationState = "connecting"
    private var floatingPetPanel: NSPanel?
    private var floatingPetSpriteView: EquinoxCompanionSpriteView?
    private var floatingPetActionsPanel: NSPanel?
    private var floatingPetSpeechPanel: NSPanel?
    private var floatingPetSpeechSurface: EquinoxCompanionSpeechView?
    private var floatingPetSpeechLabel: NSTextView?
    private var floatingPetSpeechDismissWorkItem: DispatchWorkItem?
    private var floatingPetLastOrigin: NSPoint?
    private var floatingPetDragEndWorkItem: DispatchWorkItem?
    private var companionLifecycleBaselineEstablished = false
    private var lastCompanionTaskId: String?
    private var lastCompanionContinuationStatus: String?
    private var lastCompanionLifecycleNotificationId: String?
    private var lastManualSpeechKey: String?
    private var manualSpeechCounter = 0
    private let floatingPetVisibleKey = "EquinoxLocalFloatingPetVisible"
    private let floatingPetFrameKey = "EquinoxLocalFloatingPetFrame"
    private let nativeLanguageKey = "EquinoxLocalNativeLanguage"
    private let controlCenterVisibleKey = "EquinoxLocalControlCenterVisible"
    private let restartShellMode = CommandLine.arguments.contains("--restart-shell")
    private var nativeLanguage = NativeLanguage.initial()

    private var statusItem: NSStatusItem!
    private var statusMenu: NSMenu!
    private var agentStateMenuItem: NSMenuItem!
    private var controlCenterMenuItem: NSMenuItem!
    private var floatingPetMenuItem: NSMenuItem!
    private var agentActionMenuItem: NSMenuItem!
    private var agentBrowserStateMenuItem: NSMenuItem!
    private var agentBrowserActionMenuItem: NSMenuItem!
    private var runtimeHealthMenuItem: NSMenuItem!
    private var updateMenuItem: NSMenuItem!
    private var restartMenuItem: NSMenuItem!
    private var quitMenuItem: NSMenuItem!
    private var availableUpdateVersion: String?

    private var statusTimer: Timer?
    private var updateTimer: Timer?
    private var statusRefreshInFlight = false
    private var menuActionInFlight = false
    private var runtimeAvailable = false
    private var runtimeNeedsAttention = false
    private var agentPaused = false
    private var agentBrowserReady = false
    private var quitPending = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        notificationCenter.delegate = self
        configureMainMenu()
        configureStatusItem()
        let storedControlCenterVisibility = UserDefaults.standard.object(forKey: controlCenterVisibleKey) as? Bool
        let showControlCenter = restartShellMode ? (storedControlCenterVisibility ?? true) : true
        configureWindow(showOnLaunch: showControlCenter)
        configureFloatingPet()
        showStartingPage()
        ensureRuntimeAndLoadControlCenter()
        refreshMenuStatus()
        refreshUpdateStatus()
        scheduleMenuRefresh()
        if showControlCenter {
            UserDefaults.standard.set(true, forKey: controlCenterVisibleKey)
            NSApp.activate(ignoringOtherApps: true)
        } else {
            NSApp.setActivationPolicy(.accessory)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !quitPending else { return .terminateLater }
        beginHardStopForTermination(sender)
        return .terminateLater
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openControlCenter(nil)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        retryWorkItem?.cancel()
        statusTimer?.invalidate()
        updateTimer?.invalidate()
        floatingPetDragEndWorkItem?.cancel()
        floatingPetSpeechDismissWorkItem?.cancel()
        floatingPetSpriteView?.setPaused(true)
        hideFloatingPetActions()
        hideCompanionSpeech()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: nativeLanguageMessageHandler)
        saveFloatingPetFrame()
    }

    func windowWillClose(_ notification: Notification) {
        UserDefaults.standard.set(false, forKey: controlCenterVisibleKey)
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.quitPending else { return }
            NSApp.setActivationPolicy(.accessory)
            self.refreshMenuStatus()
        }
    }

    func windowDidMove(_ notification: Notification) {
        guard let panel = floatingPetPanel,
              let movedWindow = notification.object as? NSWindow,
              movedWindow === panel else { return }
        let current = panel.frame.origin
        hideFloatingPetActions()
        hideCompanionSpeech()
        if let previous = floatingPetLastOrigin {
            let deltaX = current.x - previous.x
            if abs(deltaX) >= 0.5 {
                floatingPetSpriteView?.setDragDirection(rightward: deltaX > 0)
            }
        }
        floatingPetLastOrigin = current
        floatingPetDragEndWorkItem?.cancel()
        let endWork = DispatchWorkItem { [weak self] in
            self?.floatingPetSpriteView?.endDrag()
        }
        floatingPetDragEndWorkItem = endWork
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: endWork)
        saveFloatingPetFrame()
    }

    func menuWillOpen(_ menu: NSMenu) {
        refreshMenuStatus()
        refreshUpdateStatus()
    }

    private func localized(_ english: String, _ turkish: String) -> String {
        nativeLanguage == .turkish ? turkish : english
    }

    private func applyNativeLanguage(_ language: NativeLanguage) {
        guard language != nativeLanguage else { return }
        nativeLanguage = language
        UserDefaults.standard.set(language.rawValue, forKey: nativeLanguageKey)
        hideFloatingPetActions()
        hideCompanionSpeech()
        floatingPetActionsPanel = nil
        renderStatusMenu()
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

        agentStateMenuItem = makeMenuItem("Equinox Local")
        agentStateMenuItem.isEnabled = false
        statusMenu.addItem(agentStateMenuItem)
        statusMenu.addItem(.separator())

        agentActionMenuItem = makeMenuItem("", action: #selector(toggleAgentState(_:)))
        statusMenu.addItem(agentActionMenuItem)
        statusMenu.addItem(.separator())

        controlCenterMenuItem = makeMenuItem("", action: #selector(openControlCenter(_:)), keyEquivalent: "o")
        statusMenu.addItem(controlCenterMenuItem)
        floatingPetMenuItem = makeMenuItem("", action: #selector(toggleFloatingPet(_:)))
        statusMenu.addItem(floatingPetMenuItem)

        agentBrowserStateMenuItem = makeMenuItem("")
        agentBrowserStateMenuItem.isEnabled = false
        statusMenu.addItem(agentBrowserStateMenuItem)

        agentBrowserActionMenuItem = makeMenuItem("", action: #selector(openAgentBrowser(_:)))
        statusMenu.addItem(agentBrowserActionMenuItem)
        statusMenu.addItem(.separator())

        runtimeHealthMenuItem = makeMenuItem("")
        runtimeHealthMenuItem.isEnabled = false
        statusMenu.addItem(runtimeHealthMenuItem)

        updateMenuItem = makeMenuItem("", action: #selector(openControlCenter(_:)))
        updateMenuItem.isHidden = true
        statusMenu.addItem(updateMenuItem)

        restartMenuItem = makeMenuItem("", action: #selector(restartEquinoxLocal(_:)))
        statusMenu.addItem(restartMenuItem)
        statusMenu.addItem(.separator())

        quitMenuItem = makeMenuItem("", action: #selector(quitEquinoxLocal(_:)), keyEquivalent: "q")
        statusMenu.addItem(quitMenuItem)
        statusItem.menu = statusMenu
        renderStatusMenu()
    }

    private func scheduleMenuRefresh() {
        statusTimer?.invalidate()
        updateTimer?.invalidate()

        let statusTimer = Timer(timeInterval: 8.0, repeats: true) { [weak self] _ in
            self?.refreshMenuStatus(backgroundRefresh: true)
        }
        self.statusTimer = statusTimer
        RunLoop.main.add(statusTimer, forMode: .common)

        let updateTimer = Timer(timeInterval: 300.0, repeats: true) { [weak self] _ in
            self?.refreshUpdateStatus(backgroundRefresh: true)
        }
        self.updateTimer = updateTimer
        RunLoop.main.add(updateTimer, forMode: .common)
    }

    private func refreshMenuStatus(backgroundRefresh: Bool = false) {
        guard !statusRefreshInFlight else { return }
        statusRefreshInFlight = true
        controlClient.get("/api/v1/status", backgroundRefresh: backgroundRefresh) { [weak self] result in
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
        }

        if let browser = status["browser"] as? [String: Any],
           let contexts = browser["contexts"] as? [String: Any],
           let agent = contexts["agent"] as? [String: Any] {
            agentBrowserReady = agent["ready"] as? Bool ?? false
        } else {
            agentBrowserReady = false
        }
        if let presentation = status["presentation"] as? [String: Any] {
            applyPresentation(presentation)
        }

        renderStatusMenu()
    }

    private func applyPresentation(_ presentation: [String: Any]) {
        presentationState = presentation["state"] as? String ?? "idle"
        handleCompanionLifecycle(presentation)
        handleNotificationCandidate(presentation["notification"] as? [String: Any])
        renderFloatingPet()
    }

    private func handleCompanionLifecycle(_ presentation: [String: Any]) {
        let task = presentation["task"] as? [String: Any]
        let taskId = task?["taskId"] as? String
        let taskTitle = task?["title"] as? String ?? localized("Untitled task", "Adsız görev")
        let taskStatus = task?["status"] as? String
        let continuationStatus = task?["continuationStatus"] as? String
        let notification = presentation["notification"] as? [String: Any]
        let notificationId = notification?["id"] as? String

        if !companionLifecycleBaselineEstablished {
            companionLifecycleBaselineEstablished = true
            lastCompanionTaskId = taskId
            lastCompanionContinuationStatus = continuationStatus
            lastCompanionLifecycleNotificationId = notificationId
            return
        }

        if let notificationId, notificationId != lastCompanionLifecycleNotificationId {
            lastCompanionLifecycleNotificationId = notificationId
            let kind = notification?["kind"] as? String ?? ""
            if kind == "task_completed" {
                let title = notification?["body"] as? String ?? taskTitle
                showCompanionSpeech(
                    localized("Finished “\(title)”.", "“\(title)” tamamlandı."),
                    dismissAfter: 5.0
                )
                return
            }
            if kind == "fresh_resume_attention" {
                showCompanionSpeech(
                    localized("I need you for “\(taskTitle)”.", "“\(taskTitle)” için sana ihtiyacım var."),
                    dismissAfter: 5.5
                )
                return
            }
            if kind == "runtime_attention" {
                showCompanionSpeech(
                    localized("Something needs attention. Check Control Center.", "Bir şey dikkat gerektiriyor. Kontrol Merkezi'ne bak."),
                    dismissAfter: 5.5
                )
                return
            }
        } else if notificationId == nil {
            lastCompanionLifecycleNotificationId = nil
        }

        if let taskId, taskStatus == "active", taskId != lastCompanionTaskId {
            lastCompanionTaskId = taskId
            lastCompanionContinuationStatus = continuationStatus
            showCompanionSpeech(
                localized("Starting “\(taskTitle)”.", "“\(taskTitle)” görevine başlıyorum."),
                dismissAfter: 5.0
            )
            return
        }

        if taskId == lastCompanionTaskId,
           continuationStatus == "delivered",
           lastCompanionContinuationStatus != "delivered" {
            lastCompanionContinuationStatus = continuationStatus
            showCompanionSpeech(
                localized("Continuing “\(taskTitle)”.", "“\(taskTitle)” görevine devam ediyorum."),
                dismissAfter: 5.0
            )
            return
        }

        lastCompanionTaskId = taskId
        lastCompanionContinuationStatus = continuationStatus
    }

    private func handleNotificationCandidate(_ candidate: [String: Any]?) {
        let candidateId = candidate?["id"] as? String
        if !notificationBaselineEstablished {
            notificationBaselineEstablished = true
            lastNotificationCandidateId = candidateId
            return
        }
        guard candidateId != lastNotificationCandidateId else { return }
        lastNotificationCandidateId = candidateId
        guard let candidate,
              let identifier = candidateId,
              let title = candidate["title"] as? String,
              let body = candidate["body"] as? String else { return }
        deliverNativeNotification(
            identifier: identifier,
            title: title,
            body: body,
            taskId: candidate["taskId"] as? String
        )
    }

    private func deliverNativeNotification(identifier: String, title: String, body: String, taskId: String?) {
        let deliver = { [weak self] in
            guard let self else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            if let taskId { content.userInfo = ["taskId": taskId] }
            let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
            self.notificationCenter.add(request)
        }

        notificationCenter.getNotificationSettings { [weak self] settings in
            guard let self else { return }
            switch settings.authorizationStatus {
            case .authorized, .provisional:
                deliver()
            case .notDetermined:
                self.notificationCenter.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    if granted { deliver() }
                }
            default:
                break
            }
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let taskId = response.notification.request.content.userInfo["taskId"] as? String
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let taskId, self.isValidTaskId(taskId) {
                self.presentControlCenter(taskId: taskId)
            } else {
                self.presentControlCenter()
            }
        }
        completionHandler()
    }

    private func refreshUpdateStatus(backgroundRefresh: Bool = false) {
        controlClient.get("/api/v1/update", backgroundRefresh: backgroundRefresh) { [weak self] result in
            guard let self else { return }
            guard case let .success(payload) = result, let update = payload["update"] as? [String: Any] else {
                self.availableUpdateVersion = nil
                self.renderStatusMenu()
                return
            }
            let available = update["updateAvailable"] as? Bool ?? false
            if available, let latest = update["latestVersion"] as? String, !latest.isEmpty {
                self.availableUpdateVersion = latest
            } else {
                self.availableUpdateVersion = nil
            }
            self.renderStatusMenu()
        }
    }

    private func renderStatusMenu() {
        guard statusItem != nil else { return }
        let stateLabel: String
        if !runtimeAvailable {
            stateLabel = localized("Offline", "Çevrimdışı")
        } else if agentPaused {
            stateLabel = localized("Paused", "Duraklatıldı")
        } else if runtimeNeedsAttention {
            stateLabel = localized("Needs Attention", "Dikkat Gerekiyor")
        } else {
            stateLabel = localized("Active", "Aktif")
        }
        agentStateMenuItem?.title = "Equinox Local · \(stateLabel)"

        controlCenterMenuItem?.title = localized("Open Control Center", "Kontrol Merkezini Aç")
        floatingPetMenuItem?.title = floatingPetPanel?.isVisible == true
            ? localized("Hide Companion", "Companion'ı Gizle")
            : localized("Show Companion", "Companion'ı Göster")
        agentActionMenuItem?.title = agentPaused
            ? localized("Resume Agent", "Ajanı Sürdür")
            : localized("Emergency Stop", "Acil Durdur")
        agentActionMenuItem?.isEnabled = runtimeAvailable && !menuActionInFlight
        agentBrowserStateMenuItem?.title = "Agent Browser · \(agentBrowserReady ? localized("Connected", "Bağlı") : localized("Not connected", "Bağlı değil"))"
        agentBrowserActionMenuItem?.title = localized("Open Agent Browser", "Agent Browser'ı Aç")
        agentBrowserActionMenuItem?.isEnabled = runtimeAvailable && !agentPaused && !menuActionInFlight
        runtimeHealthMenuItem?.title = runtimeAvailable
            ? "Runtime · \(runtimeNeedsAttention ? localized("Needs Attention", "Dikkat Gerekiyor") : localized("Healthy", "Sağlıklı"))"
            : "Runtime · \(localized("Offline", "Çevrimdışı"))"
        if let availableUpdateVersion {
            updateMenuItem?.title = "\(localized("Update available", "Güncelleme mevcut")) · \(availableUpdateVersion)"
            updateMenuItem?.isHidden = false
        } else {
            updateMenuItem?.isHidden = true
        }
        restartMenuItem?.title = localized("Restart Equinox Local", "Equinox Local'i Yeniden Başlat")
        restartMenuItem?.isEnabled = runtimeAvailable && !menuActionInFlight
        quitMenuItem?.title = localized("Quit Equinox Local", "Equinox Local'den Çık")
        renderStatusIcon()
        renderFloatingPet()
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
        let state = !runtimeAvailable
            ? localized("Offline", "Çevrimdışı")
            : agentPaused
                ? localized("Paused", "Duraklatıldı")
                : runtimeNeedsAttention
                    ? localized("Needs Attention", "Dikkat Gerekiyor")
                    : localized("Active", "Aktif")
        button.toolTip = "Equinox Local · \(state)"
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
            self.renderStatusMenu()
        }
    }

    private func configureFloatingPet() {
        let size = NSSize(width: 132, height: 142)
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "Equinox Companion · Nyx"
        panel.delegate = self
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.acceptsMouseMovedEvents = true

        let root = NSView(frame: NSRect(origin: .zero, size: size))
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.clear.cgColor

        let sprite = EquinoxCompanionSpriteView(
            frame: root.bounds,
            sheetImage: EquinoxFloatingPetPack.loadSheet()
        )
        sprite.autoresizingMask = [.width, .height]
        sprite.onPrimaryClick = { [weak self] in
            guard let self else { return }
            let actionsWereVisible = self.floatingPetActionsPanel?.isVisible == true
            self.toggleFloatingPetActions()
            if !actionsWereVisible {
                self.showManualCompanionSpeech()
            }
        }
        root.addSubview(sprite)

        panel.contentView = root
        floatingPetPanel = panel
        floatingPetSpriteView = sprite
        restoreFloatingPetFrame()
        floatingPetLastOrigin = panel.frame.origin

        let defaults = UserDefaults.standard
        let shouldShow = (defaults.object(forKey: floatingPetVisibleKey) as? Bool) ?? true
        sprite.setPaused(!shouldShow)
        if shouldShow { panel.orderFrontRegardless() }
        renderFloatingPet()
    }

    private func companionTextHeight(_ text: String, font: NSFont, width: CGFloat) -> CGFloat {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        let storage = NSTextStorage(string: text, attributes: [
            .font: font,
            .paragraphStyle: paragraph,
        ])
        let layoutManager = NSLayoutManager()
        let container = NSTextContainer(containerSize: NSSize(width: width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        container.heightTracksTextView = false
        layoutManager.addTextContainer(container)
        storage.addLayoutManager(layoutManager)
        layoutManager.ensureLayout(for: container)
        return ceil(layoutManager.usedRect(for: container).height)
    }

    private func configureCompanionSpeechPanel() -> NSPanel {
        if let panel = floatingPetSpeechPanel { return panel }
        let initialSize = NSSize(width: 260, height: 72)
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: initialSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = localized("Nyx Speech", "Nyx Konuşma Balonu")
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.ignoresMouseEvents = true

        let container = NSView(frame: NSRect(origin: .zero, size: initialSize))
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.clear.cgColor

        let surface = EquinoxCompanionSpeechView(frame: container.bounds)
        surface.autoresizingMask = [.width, .height]
        container.addSubview(surface)

        let label = NSTextView(frame: .zero)
        label.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        label.textColor = .labelColor
        label.alignment = .left
        label.isEditable = false
        label.isSelectable = false
        label.drawsBackground = false
        label.textContainerInset = .zero
        label.textContainer?.lineFragmentPadding = 0
        label.textContainer?.widthTracksTextView = true
        label.textContainer?.heightTracksTextView = false
        surface.addSubview(label)

        panel.contentView = container
        floatingPetSpeechPanel = panel
        floatingPetSpeechSurface = surface
        floatingPetSpeechLabel = label
        return panel
    }

    private func showCompanionSpeech(_ text: String, dismissAfter seconds: TimeInterval) {
        guard let pet = floatingPetPanel,
              pet.isVisible,
              let visible = (pet.screen ?? NSScreen.main)?.visibleFrame else { return }
        let bounded = String(text.prefix(240))
        let font = NSFont.systemFont(ofSize: 13, weight: .medium)
        let inset: CGFloat = 8
        let horizontalPadding: CGFloat = 16
        let verticalPadding: CGFloat = 10
        let tailHeight: CGFloat = 10
        let maxOuterWidth = min(360, visible.width - inset * 2)
        let maxTextWidth = max(180, maxOuterWidth - horizontalPadding * 2)
        let naturalWidth = ceil((bounded as NSString).size(withAttributes: [.font: font]).width)
        let textWidth = min(maxTextWidth, max(220, naturalWidth))
        let textHeight = companionTextHeight(bounded, font: font, width: textWidth)
        let requestedHeight = max(58, textHeight + verticalPadding * 2 + tailHeight)
        let size = NSSize(
            width: textWidth + horizontalPadding * 2,
            height: min(requestedHeight, visible.height - inset * 2)
        )
        let panel = configureCompanionSpeechPanel()
        guard let container = panel.contentView,
              let surface = floatingPetSpeechSurface,
              let label = floatingPetSpeechLabel else { return }

        let gap: CGFloat = 5
        var x = pet.frame.midX - size.width / 2
        x = min(max(x, visible.minX + inset), visible.maxX - size.width - inset)
        let aboveY = pet.frame.maxY + gap
        let tailAtBottom = aboveY + size.height <= visible.maxY - inset
        var y = tailAtBottom ? aboveY : pet.frame.minY - gap - size.height
        y = min(max(y, visible.minY + inset), visible.maxY - size.height - inset)
        let tailX = pet.frame.midX - x

        panel.setFrame(NSRect(x: x, y: y, width: size.width, height: size.height), display: false)
        container.frame = NSRect(origin: .zero, size: size)
        surface.frame = container.bounds
        surface.updateShape(tailAtBottom: tailAtBottom, tailX: tailX)

        let bodyOriginY: CGFloat = tailAtBottom ? tailHeight : 0
        let bodyHeight = max(1, size.height - tailHeight)
        let centeredTextHeight = min(textHeight, bodyHeight)
        let centeredTextY = bodyOriginY + max(0, (bodyHeight - centeredTextHeight) / 2)
        label.frame = NSRect(
            x: horizontalPadding,
            y: centeredTextY,
            width: textWidth,
            height: centeredTextHeight
        )
        label.string = bounded
        label.needsDisplay = true
        surface.needsDisplay = true
        panel.orderFrontRegardless()

        floatingPetSpeechDismissWorkItem?.cancel()
        let dismiss = DispatchWorkItem { [weak self] in
            self?.floatingPetSpeechPanel?.orderOut(nil)
        }
        floatingPetSpeechDismissWorkItem = dismiss
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: dismiss)
    }

    private func hideCompanionSpeech() {
        floatingPetSpeechDismissWorkItem?.cancel()
        floatingPetSpeechDismissWorkItem = nil
        floatingPetSpeechPanel?.orderOut(nil)
    }

    private func showManualCompanionSpeech(now: Date = Date()) {
        let hour = Calendar.current.component(.hour, from: now)
        let greeting: (key: String, english: String, turkish: String)
        switch hour {
        case 5..<12:
            greeting = ("morning", "Good morning. Ready when you are.", "Günaydın. Hazır olduğunda buradayım.")
        case 12..<18:
            greeting = ("day", "Hope your day is going well.", "Umarım günün iyi gidiyordur.")
        case 18..<23:
            greeting = ("evening", "Good evening. What's next?", "İyi akşamlar. Sırada ne var?")
        default:
            greeting = ("night", "Good night… or one more task?", "İyi geceler… yoksa bir görev daha mı?")
        }
        let daily: [(key: String, english: String, turkish: String)] = [
            ("need-anything", "Need anything?", "Bir şeye ihtiyacın var mı?"),
            ("watching", "I'm keeping an eye on things.", "Buralara göz kulak oluyorum."),
            ("quiet", "Quiet around here. For now.", "Buralar sakin. Şimdilik."),
            ("one-task", "One task at a time.", "Her seferinde bir görev."),
            ("ready", "Ready for the next thing.", "Sıradaki işe hazırım."),
            ("listening", "I'm here when you need me.", "İhtiyacın olduğunda buradayım."),
        ]
        let choices = [greeting] + daily
        var index = manualSpeechCounter % choices.count
        if choices[index].key == lastManualSpeechKey { index = (index + 1) % choices.count }
        manualSpeechCounter += 1
        let choice = choices[index]
        lastManualSpeechKey = choice.key
        showCompanionSpeech(nativeLanguage == .turkish ? choice.turkish : choice.english, dismissAfter: 4.2)
    }

    private func companionPanelMask(size: NSSize, cornerRadius: CGFloat) -> NSImage {
        let mask = NSImage(size: size)
        mask.lockFocus()
        NSColor.white.setFill()
        NSBezierPath(
            roundedRect: NSRect(origin: .zero, size: size),
            xRadius: cornerRadius,
            yRadius: cornerRadius
        ).fill()
        mask.unlockFocus()
        return mask
    }

    private func makeCompanionActionRow(_ title: String, symbolName: String, action: Selector) -> EquinoxCompanionActionRow {
        EquinoxCompanionActionRow(title: title, symbolName: symbolName, target: self, action: action)
    }

    private func configureFloatingPetActionsPanel() -> NSPanel {
        if let panel = floatingPetActionsPanel { return panel }

        let size = NSSize(width: 188, height: 124)
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = localized("Nyx Quick Actions", "Nyx Hızlı Eylemler")
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.becomesKeyOnlyIfNeeded = true

        let container = NSView(frame: NSRect(origin: .zero, size: size))
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.clear.cgColor

        let surfaceFrame = container.bounds.insetBy(dx: 1, dy: 1)
        let surface = NSVisualEffectView(frame: surfaceFrame)
        surface.autoresizingMask = [.width, .height]
        surface.material = .popover
        surface.blendingMode = .behindWindow
        surface.state = .active
        surface.wantsLayer = true
        surface.layer?.cornerRadius = 14
        surface.layer?.cornerCurve = .continuous
        surface.layer?.borderWidth = 0.5
        surface.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.30).cgColor
        surface.maskImage = companionPanelMask(size: surfaceFrame.size, cornerRadius: 14)
        container.addSubview(surface)

        let newChat = makeCompanionActionRow(
            localized("New Chat", "Yeni Sohbet"),
            symbolName: "square.and.pencil",
            action: #selector(openNewChatFromCompanion(_:))
        )
        let controlCenter = makeCompanionActionRow(
            localized("Control Center", "Kontrol Merkezi"),
            symbolName: "slider.horizontal.3",
            action: #selector(openControlCenterFromCompanion(_:))
        )
        let hideNyx = makeCompanionActionRow(
            localized("Hide Nyx", "Nyx'i Gizle"),
            symbolName: "eye.slash",
            action: #selector(hideNyxFromCompanion(_:))
        )

        let stack = NSStackView(views: [newChat, controlCenter, hideNyx])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.distribution = .fillEqually
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        surface.addSubview(stack)
        for row in [newChat, controlCenter, hideNyx] {
            row.translatesAutoresizingMaskIntoConstraints = false
            row.widthAnchor.constraint(equalToConstant: 168).isActive = true
            row.heightAnchor.constraint(equalToConstant: 34).isActive = true
        }
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: surface.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: surface.centerYAnchor),
        ])

        panel.contentView = container
        floatingPetActionsPanel = panel
        return panel
    }

    private func positionFloatingPetActionsPanel(_ actions: NSPanel) {
        guard let pet = floatingPetPanel, let visible = (pet.screen ?? NSScreen.main)?.visibleFrame else { return }
        let gap: CGFloat = 8
        let inset: CGFloat = 8
        var x = pet.frame.maxX + gap
        if x + actions.frame.width > visible.maxX - inset {
            x = pet.frame.minX - gap - actions.frame.width
        }
        x = min(max(x, visible.minX + inset), visible.maxX - actions.frame.width - inset)
        var y = pet.frame.midY - actions.frame.height / 2
        y = min(max(y, visible.minY + inset), visible.maxY - actions.frame.height - inset)
        actions.setFrameOrigin(NSPoint(x: x, y: y))
    }

    private func toggleFloatingPetActions() {
        guard floatingPetPanel?.isVisible == true else { return }
        let actions = configureFloatingPetActionsPanel()
        if actions.isVisible {
            actions.orderOut(nil)
            return
        }
        positionFloatingPetActionsPanel(actions)
        actions.orderFrontRegardless()
    }

    private func hideFloatingPetActions() {
        floatingPetActionsPanel?.orderOut(nil)
    }

    @objc private func openNewChatFromCompanion(_ sender: Any?) {
        hideFloatingPetActions()
        guard let url = URL(string: "https://chatgpt.com/") else {
            NSSound.beep()
            return
        }
        NSWorkspace.shared.open(url)
    }

    @objc private func openControlCenterFromCompanion(_ sender: Any?) {
        hideFloatingPetActions()
        presentControlCenter()
    }

    @objc private func hideNyxFromCompanion(_ sender: Any?) {
        hideFloatingPetActions()
        if floatingPetPanel?.isVisible == true {
            toggleFloatingPet(nil)
        }
    }

    private func defaultFloatingPetOrigin(for size: NSSize) -> NSPoint {
        guard let screen = NSScreen.main else { return NSPoint(x: 40, y: 40) }
        let visible = screen.visibleFrame
        return NSPoint(x: visible.maxX - size.width - 28, y: visible.minY + 44)
    }

    private func restoreFloatingPetFrame() {
        guard let panel = floatingPetPanel else { return }
        if let raw = UserDefaults.standard.string(forKey: floatingPetFrameKey) {
            let frame = NSRectFromString(raw)
            if frame.width > 0, frame.height > 0, NSScreen.screens.contains(where: { $0.visibleFrame.intersects(frame) }) {
                panel.setFrame(frame, display: false)
                return
            }
        }
        panel.setFrameOrigin(defaultFloatingPetOrigin(for: panel.frame.size))
    }

    private func saveFloatingPetFrame() {
        guard let panel = floatingPetPanel else { return }
        UserDefaults.standard.set(NSStringFromRect(panel.frame), forKey: floatingPetFrameKey)
    }

    private func renderFloatingPet() {
        guard let panel = floatingPetPanel else { return }
        let state = runtimeAvailable ? presentationState : "offline"
        floatingPetSpriteView?.setBasePresentationState(state)
        panel.alphaValue = state == "emergency_stopped" ? 0.72 : 1.0
    }

    @objc private func toggleFloatingPet(_ sender: Any?) {
        guard let panel = floatingPetPanel else { return }
        if panel.isVisible {
            hideFloatingPetActions()
            hideCompanionSpeech()
            saveFloatingPetFrame()
            floatingPetSpriteView?.setPaused(true)
            panel.orderOut(nil)
            UserDefaults.standard.set(false, forKey: floatingPetVisibleKey)
        } else {
            floatingPetSpriteView?.setPaused(false)
            renderFloatingPet()
            panel.orderFrontRegardless()
            UserDefaults.standard.set(true, forKey: floatingPetVisibleKey)
        }
        renderStatusMenu()
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

    private func isValidTaskId(_ taskId: String) -> Bool {
        taskId.range(of: #"^task-[a-z0-9-]{6,80}$"#, options: .regularExpression) != nil
    }

    private func controlCenterTaskURL(_ taskId: String) -> URL? {
        guard isValidTaskId(taskId), var components = URLComponents(url: controlCenterURL, resolvingAgainstBaseURL: false) else { return nil }
        components.queryItems = [
            URLQueryItem(name: "section", value: "tasks"),
            URLQueryItem(name: "task", value: taskId),
        ]
        return components.url
    }

    private func presentControlCenter(taskId: String? = nil) {
        UserDefaults.standard.set(true, forKey: controlCenterVisibleKey)
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if !runtimeAvailable {
            showStartingPage()
            ensureRuntimeAndLoadControlCenter()
        } else if let taskId, let url = controlCenterTaskURL(taskId) {
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5))
        }
        refreshMenuStatus()
    }

    @objc private func openControlCenter(_ sender: Any?) {
        presentControlCenter()
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
        NSApp.terminate(sender)
    }

    private func beginHardStopForTermination(_ application: NSApplication) {
        guard !quitPending else { return }
        quitPending = true
        statusTimer?.invalidate()
        updateTimer?.invalidate()
        menuActionInFlight = true
        renderStatusMenu()

        runtimeLifecycle.hardStop { [weak self, weak application] result in
            guard let self, let application else { return }
            switch result {
            case .success:
                application.reply(toApplicationShouldTerminate: true)
            case let .failure(error):
                self.quitPending = false
                self.menuActionInFlight = false
                self.scheduleMenuRefresh()
                self.refreshMenuStatus()
                application.reply(toApplicationShouldTerminate: false)
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

    private func configureWindow(showOnLaunch: Bool) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.isElementFullscreenEnabled = false
        configuration.userContentController.add(self, name: nativeLanguageMessageHandler)
        configuration.userContentController.addUserScript(WKUserScript(
            source: "window.__equinoxNativeLanguage = '\(nativeLanguage.rawValue)';",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
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
        if showOnLaunch {
            window.makeKeyAndOrderFront(nil)
        } else {
            window.orderOut(nil)
        }
    }

    private func showStartingPage() {
        let languageCode = nativeLanguage.rawValue
        let startingMessage = localized("Control Center is starting on this Mac…", "Kontrol Merkezi bu Mac'te başlatılıyor…")
        let html = """
        <!doctype html><html lang="\(languageCode)"><head><meta charset="utf-8"><meta name="color-scheme" content="dark">
        <style>
        *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;background:#0b0d11;color:#f5f7fb}
        body{display:grid;place-items:center}.wrap{text-align:center;max-width:520px;padding:48px}.mark{width:72px;height:72px;border-radius:18px;margin:0 auto 24px;box-shadow:0 18px 60px rgba(70,170,255,.2)}
        h1{font-size:25px;margin:0 0 8px;letter-spacing:-.035em}p{margin:0;color:#8d96a8;font-size:14px;line-height:1.6}.dot{display:inline-block;width:7px;height:7px;margin-right:8px;border-radius:50%;background:#65d392;box-shadow:0 0 18px rgba(101,211,146,.55)}
        </style></head><body><div class="wrap"><h1>Equinox Local</h1><p><span class="dot"></span>\(startingMessage)</p></div></body></html>
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

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == nativeLanguageMessageHandler,
              message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url,
              isAllowedControlCenterURL(url),
              let raw = message.body as? String,
              let language = NativeLanguage(rawValue: raw) else { return }
        applyNativeLanguage(language)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        guard frame.isMainFrame,
              let url = frame.request.url,
              isAllowedControlCenterURL(url),
              let window, window.isVisible else {
            completionHandler(false)
            return
        }

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = localized("Confirm action", "İşlemi onayla")
        alert.informativeText = message
        alert.addButton(withTitle: localized("Confirm", "Onayla"))
        alert.addButton(withTitle: localized("Cancel", "Vazgeç"))
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
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

runInternalProcessSessionCommandIfRequested()

if shouldRunAsRuntimeHost() {
    runRuntimeHost()
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = AppDelegate()
application.delegate = delegate
application.run()
