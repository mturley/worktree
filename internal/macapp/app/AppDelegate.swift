import AppKit
import WebKit

/// The status item, its popover, and the web view inside it.
///
/// The web view loads the web UI's /mini page once at launch and stays alive
/// while the popover is closed, so the page's event stream keeps running and
/// the icon stays current. The page talks back through the `worktree` script
/// message handler (ui/src/lib/macBridge.ts).
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler,
    WKNavigationDelegate, WKUIDelegate
{
    private var statusItem: NSStatusItem!
    private var icon: StatusIcon!
    private let popover = NSPopover()
    private var webView: WKWebView!
    private let offlineView = OfflineView(frame: .zero)

    /// WorktreeServerURL from Info.plist, written at build time.
    private let serverURL: URL = {
        let s = Bundle.main.object(forInfoDictionaryKey: "WorktreeServerURL") as? String
        return URL(string: s ?? "") ?? URL(string: "http://127.0.0.1:8475")!
    }()

    private var miniURL: URL { serverURL.appendingPathComponent("mini") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        guard let button = statusItem.button else { return }
        icon = StatusIcon(button: button)
        button.target = self
        button.action = #selector(statusItemClicked)
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "worktree")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 640))
        for view in [webView!, offlineView] as [NSView] {
            view.frame = container.bounds
            view.autoresizingMask = [.width, .height]
            container.addSubview(view)
        }
        offlineView.isHidden = true
        offlineView.onReload = { [weak self] in self?.loadMini() }

        let controller = NSViewController()
        controller.view = container
        popover.contentViewController = controller
        popover.contentSize = NSSize(width: 420, height: 640)
        popover.behavior = .transient

        loadMini()
    }

    // MARK: - Status item

    @objc private func statusItemClicked() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            showMenu()
        } else {
            togglePopover()
        }
    }

    private func togglePopover() {
        if popover.isShown {
            popover.performClose(nil)
            return
        }
        guard let button = statusItem.button else { return }
        // An accessory app is never frontmost on its own; without this the
        // popover can't take key focus and the login form can't be typed in.
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }

    private func showMenu() {
        let menu = NSMenu()
        menu.addItem(item("Open full UI", #selector(openFullUI)))
        menu.addItem(item("Reload", #selector(reloadPage)))
        let login = item("Open at login", #selector(toggleLoginItem))
        login.state = LoginItem.isEnabled ? .on : .off
        menu.addItem(login)
        menu.addItem(item("More settings in web UI", #selector(openSettings)))
        menu.addItem(.separator())
        menu.addItem(item("Quit", #selector(quit)))

        // Attaching the menu for one click is the supported way to pop a menu
        // from a status item; detaching it again keeps left click for the
        // popover.
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    private func item(_ title: String, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        return item
    }

    @objc private func openFullUI() { openInBrowser(serverURL) }

    @objc private func openSettings() {
        if var c = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) {
            c.path = "/"
            c.query = "settings"
            if let url = c.url { openInBrowser(url) }
        }
    }

    @objc private func reloadPage() { loadMini() }

    @objc private func toggleLoginItem() {
        do {
            try LoginItem.setEnabled(!LoginItem.isEnabled)
        } catch {
            let alert = NSAlert(error: error)
            alert.messageText = "Couldn't change Open at login"
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    private func openInBrowser(_ url: URL) {
        NSWorkspace.shared.open(url)
        popover.performClose(nil)
    }

    // MARK: - Loading

    /// Loads /mini, keeping the current /mini URL (such as ?task=…) when there
    /// is one, so Reload and the offline countdown don't lose the user's place.
    private func loadMini() {
        if let current = webView.url, isMini(current) {
            webView.load(URLRequest(url: current))
        } else {
            webView.load(URLRequest(url: miniURL))
        }
    }

    /// Whether url is the server's /mini page (any query or fragment).
    private func isMini(_ url: URL) -> Bool {
        guard url.scheme == serverURL.scheme, url.host == serverURL.host,
              url.port == serverURL.port else { return false }
        return url.path == "/mini" || url.path.hasPrefix("/mini/")
    }

    private func showOffline() {
        icon.state = .disconnected
        webView.isHidden = true
        offlineView.isHidden = false
        offlineView.startCountdown()
    }

    private func hideOffline() {
        offlineView.stopCountdown()
        offlineView.isHidden = true
        webView.isHidden = false
    }

    // MARK: - Bridge

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
            return
        }
        switch type {
        case "unread":
            icon.state = (body["unread"] as? Bool ?? false) ? .unread : .resting
        case "ready":
            icon.state = .resting
        case "login":
            icon.state = .needsLogin
        case "open":
            if let s = body["url"] as? String, let url = URL(string: s),
               url.scheme == "http" || url.scheme == "https" {
                openInBrowser(url)
            }
        case "unreachable":
            // The page shows its own countdown and reloads itself; if that
            // reload fails at the network level, didFailProvisionalNavigation
            // brings up the offline view.
            icon.state = .disconnected
        default:
            break
        }
    }

    // MARK: - Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        let mainFrame = action.targetFrame?.isMainFrame ?? true // nil: a new window
        let leaves = (action.navigationType == .linkActivated || mainFrame) && !isMini(url)
        if leaves && (url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto") {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else if leaves && url.scheme != "about" {
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hideOffline()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loadMini()
    }

    private func failed(_ error: Error) {
        let e = error as NSError
        // A navigation we cancelled (sent to the browser) or replaced with
        // another load is not the server being down.
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return } // frame load interrupted
        showOffline()
    }
}
