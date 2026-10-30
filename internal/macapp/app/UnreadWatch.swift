import Foundation

/// The icon's backstop for unread state: runs `worktree unread --json` every
/// 15s and reports what it says.
///
/// The page's event stream is the instant path, and usually the only one
/// that matters. This catches the icon up if that stream ever stalls while
/// the dropdown is closed (a hidden web view is WebKit's to throttle). The
/// CLI reads the database directly, through the same code as the page's
/// unread state (webui.AppUnread), so the two cannot disagree for longer
/// than a poll; it needs no login and no running server.
@MainActor
final class UnreadWatch {
    static let interval: TimeInterval = 15
    /// A run that takes longer than this is stopped: a locked database must
    /// not leave a process behind every interval.
    nonisolated static let timeout: TimeInterval = 10

    /// Where `make install` puts the CLI, then the usual alternatives. An
    /// app started by launchd has a bare PATH, so the CLI is looked for by
    /// path rather than by name.
    static let candidates = [
        "/usr/local/bin/worktree",
        "/opt/homebrew/bin/worktree",
        NSString(string: "~/.local/bin/worktree").expandingTildeInPath,
        NSString(string: "~/go/bin/worktree").expandingTildeInPath,
    ]

    var onResult: ((_ unread: Bool, _ count: Int) -> Void)?

    private var timer: Timer?
    private var running = false

    func start() {
        guard timer == nil else { return }
        let t = Timer(timeInterval: UnreadWatch.interval, target: self, selector: #selector(check),
                      userInfo: nil, repeats: true)
        RunLoop.main.add(t, forMode: .common)
        timer = t
        check()
    }

    @objc private func check() {
        guard !running,
              let cli = UnreadWatch.candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) })
        else { return }
        running = true
        DispatchQueue.global(qos: .utility).async {
            let result = UnreadWatch.run(cli)
            Task { @MainActor in
                self.running = false
                if let (unread, count) = result { self.onResult?(unread, count) }
            }
        }
    }

    /// Runs `<cli> unread --json` and parses its answer; nil on any failure,
    /// which leaves the icon as it was.
    nonisolated static func run(_ cli: String) -> (Bool, Int)? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: cli)
        p.arguments = ["unread", "--json"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        killer.cancel()
        guard p.terminationStatus == 0,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let unread = obj["unread"] as? Bool
        else { return nil }
        return (unread, obj["count"] as? Int ?? 0)
    }
}
