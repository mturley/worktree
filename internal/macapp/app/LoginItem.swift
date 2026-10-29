import Foundation

/// "Open at login": a LaunchAgent plist in ~/Library/LaunchAgents. Its
/// existing is the only record of the choice, so there is nothing to keep in
/// sync but the file. No launchctl call is needed: deleting the plist only
/// stops the next login start, and the running app keeps running.
enum LoginItem {
    static let label = "me.turley.worktree.menubar"

    static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    static var isEnabled: Bool {
        FileManager.default.fileExists(atPath: plistURL.path)
    }

    static func setEnabled(_ on: Bool) throws {
        if on {
            try FileManager.default.createDirectory(
                at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try contents(appPath: Bundle.main.bundlePath).write(to: plistURL, options: .atomic)
        } else if isEnabled {
            try FileManager.default.removeItem(at: plistURL)
        }
    }

    /// KEEP IN SYNC with LaunchAgentPlist in internal/macapp/launchagent.go:
    /// `worktree setup` writes the same file, and the two must produce the
    /// same bytes. TestLoginItemSwiftMatchesLaunchAgentPlist reads the
    /// `body` literal below and compares it with the Go output.
    static func contents(appPath: String) -> Data {
        let executable = escape(appPath + "/Contents/MacOS/WorktreeMenuBar")
        let body = """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>me.turley.worktree.menubar</string>
	<key>ProgramArguments</key>
	<array>
		<string>\(executable)</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
</dict>
</plist>
"""
        return Data((body + "\n").utf8)
    }

    /// The same three replacements as the Go side's plistEscaper.
    private static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}
