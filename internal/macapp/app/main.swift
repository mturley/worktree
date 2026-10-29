import AppKit

// Entry point. A dock-less accessory app: no Dock icon and no app menu, just
// the status item AppDelegate creates. Top-level code is not main-actor
// isolated under Swift 6, but this is the main thread, so say so.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate() // app.delegate is weak; run() never returns
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
