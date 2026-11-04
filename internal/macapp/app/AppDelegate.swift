import AppKit
import WebKit

/// Keeps an Esc the page didn't preventDefault from closing the popover.
/// WebKit hands the unhandled key back as `cancelOperation:` asynchronously,
/// once the page is done with it, and from there it reaches NSPopover's
/// performClose. By then the current event may be the key-up or something
/// else, so popoverShouldClose can't recognise it as Esc: stop it here.
private final class DropdownWebView: WKWebView {
    override func cancelOperation(_ sender: Any?) {}
}

/// The status item, its popover, and the web view inside it.
///
/// The web view loads the web UI's /mini page once at launch and stays alive
/// while the popover is closed, so the page's event stream keeps running and
/// the icon stays current. The page talks back through the `worktree` script
/// message handler (ui/src/lib/macBridge.ts).
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler,
    WKNavigationDelegate, WKUIDelegate, NSPopoverDelegate
{
    private var statusItem: NSStatusItem!
    private var icon: StatusIcon!
    private let popover = NSPopover()
    private var webView: WKWebView!
    private let offlineView = OfflineView(frame: .zero)
    /// The last unread report, from the page or the CLI (whichever spoke
    /// last), nil until one has. Survives reloads, so `ready` can restore it
    /// rather than guess.
    private var lastUnread: Bool?
    private let unreadWatch = UnreadWatch()
    /// The view the page last said it shows, whose size the popover has.
    private var currentView = DropdownView.collapsed
    /// The last of collapsed or expanded, what's left when details go away
    /// with the page.
    private var modeView = DropdownView.collapsed
    /// The last /mini URL that loaded (with its ?task= and such), so coming
    /// back from offline returns to it rather than to plain /mini.
    private var lastMiniURL: URL?
    private lazy var serverWatch = ServerWatch(url: serverURL)

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
        webView = DropdownWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        let size = PopoverSize.saved(currentView)
        let container = NSView(frame: NSRect(origin: .zero, size: size))
        for view in [webView!, offlineView] as [NSView] {
            view.frame = container.bounds
            view.autoresizingMask = [.width, .height]
            container.addSubview(view)
        }
        offlineView.isHidden = true
        serverWatch.onUp = { [weak self] in self?.loadMini() }
        unreadWatch.onResult = { [weak self] unread, _ in self?.cliUnread(unread) }
        unreadWatch.start()

        // Added last so it sits above the web view and takes its own clicks.
        let grip = ResizeGrip(frame: NSRect(x: size.width - ResizeGrip.side, y: 0,
                                            width: ResizeGrip.side, height: ResizeGrip.side))
        grip.autoresizingMask = [.minXMargin, .maxYMargin]
        grip.popover = popover
        grip.currentView = { [weak self] in self?.currentView ?? .collapsed }
        container.addSubview(grip)

        let controller = NSViewController()
        controller.view = container
        popover.contentViewController = controller
        popover.contentSize = size
        popover.behavior = .transient
        popover.delegate = self

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
        // The screen may have changed since: a size shrunk to fit a smaller
        // one comes back here, as only the fit was shrunk, not the saved size.
        applySize()
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        let window = popover.contentViewController?.view.window
        window?.makeKey()
        // So keys reach the page (U for Unreads only) without a click first.
        window?.makeFirstResponder(webView)
    }

    private func showMenu() {
        let menu = NSMenu()
        menu.addItem(item("Open full UI", #selector(openFullUI)))
        menu.addItem(item("Reload", #selector(reloadPage)))
        menu.addItem(item("Reset dropdown to default size", #selector(resetSize)))
        let login = item("Open at login", #selector(toggleLoginItem))
        login.state = LoginItem.isEnabled ? .on : .off
        menu.addItem(login)
        let purple = item("Use purple wt icon", #selector(togglePurpleIcon))
        purple.state = icon.purple ? .on : .off
        menu.addItem(purple)
        let flash = item("Flash icon on unread activity", #selector(toggleFlash))
        flash.state = icon.flash ? .on : .off
        menu.addItem(flash)
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

    /// Every view's size, unlike double-clicking the grip, which resets the
    /// one showing.
    @objc private func resetSize() {
        PopoverSize.resetAll()
        applySize()
    }

    /// The page's `view`: moves to that view's size.
    private func setView(_ view: DropdownView) {
        currentView = view
        if view == .collapsed || view == .expanded { modeView = view }
        applySize()
    }

    /// The current view's saved size, as far as it fits the screen holding
    /// the icon the popover hangs from. Saves nothing.
    private func applySize() {
        let screen = statusItem.button?.window?.screen ?? NSScreen.main
        popover.contentSize = PopoverSize.clamped(PopoverSize.saved(currentView), for: currentView, on: screen)
    }

    @objc private func togglePurpleIcon() { icon.purple.toggle() }

    @objc private func toggleFlash() { icon.flash.toggle() }

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

    /// Loads /mini, keeping the current /mini URL (such as ?task=…), or the
    /// last one while offline, so Reload and coming back don't lose the
    /// user's place.
    private func loadMini() {
        if let current = webView.url, isMini(current) {
            webView.load(URLRequest(url: current))
        } else {
            webView.load(URLRequest(url: lastMiniURL ?? miniURL))
        }
    }

    /// Whether url is the server's /mini page (any query or fragment). Exactly
    /// the path /mini, as the page's own isMiniRoute accepts.
    private func isMini(_ url: URL) -> Bool {
        guard url.scheme == serverURL.scheme, url.host == serverURL.host,
              url.port == serverURL.port else { return false }
        return url.path == "/mini"
    }

    /// The schemes the app hands to the system: everything else is dropped.
    private func opensExternally(_ url: URL) -> Bool {
        url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto"
    }

    private func showOffline() {
        icon.state = .disconnected
        // The page showing any details is gone.
        setView(modeView)
        webView.isHidden = true
        offlineView.isHidden = false
        // A failed load leaves the previous page in place, scripts still
        // running: its own retries would keep failing behind this view.
        // Blank it, and watch for the server instead.
        if webView.url.map(isMini) ?? false { lastMiniURL = webView.url }
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
        serverWatch.start()
    }

    private func hideOffline() {
        serverWatch.stop()
        offlineView.isHidden = true
        webView.isHidden = false
    }

    /// UnreadWatch's backstop report. It moves the icon only while the icon
    /// shows the connected states: offline and needs-login keep their look,
    /// and the next `ready` restores from lastUnread.
    private func cliUnread(_ unread: Bool) {
        lastUnread = unread
        if icon.state == .resting || icon.state == .unread {
            icon.state = unread ? .unread : .resting
        }
    }

    /// Esc is the page's: it closes a modal, menu or the search's suggestions
    /// and clears the search and filters. The dropdown closes on a click
    /// away or on the menu bar icon, never on Esc. This covers an Esc while
    /// the web view doesn't have focus; DropdownWebView covers one it does.
    func popoverShouldClose(_ popover: NSPopover) -> Bool {
        guard let e = NSApp.currentEvent else { return true }
        return !(e.type == .keyDown && e.keyCode == 53)
    }

    // MARK: - Bridge

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
            return
        }
        switch type {
        case "unread":
            guard let unread = body["unread"] as? Bool else { return }
            lastUnread = unread
            icon.state = unread ? .unread : .resting
        case "ready":
            // Restore what the page last said; with nothing said yet, leave
            // the icon alone until its first unread report arrives.
            if let unread = lastUnread { icon.state = unread ? .unread : .resting }
        case "view":
            guard let name = body["view"] as? String, let view = DropdownView(rawValue: name) else { return }
            setView(view)
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
        if leaves && opensExternally(url) {
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
        if let url = action.request.url, opensExternally(url) { NSWorkspace.shared.open(url) }
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
        // Only the page itself ends offline: the blank page showOffline loads
        // finishes too.
        guard let url = webView.url, isMini(url) else { return }
        lastMiniURL = url
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
