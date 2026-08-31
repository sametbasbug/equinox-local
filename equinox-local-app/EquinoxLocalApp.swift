import AppKit
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

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var retryWorkItem: DispatchWorkItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMainMenu()
        configureWindow()
        showStartingPage()
        loadControlCenterWhenReady()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        retryWorkItem?.cancel()
    }

    private func configureMainMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Equinox Local", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Equinox Local", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
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
