import AppKit

/// Shown over the web view when a load fails at the network level (connection
/// refused: there is no page to show its own countdown). Counts down from 6,
/// the same as the web UI's RELOAD_AFTER_SECONDS in ui/src/App.tsx, and calls
/// onReload at zero.
@MainActor
final class OfflineView: NSView {
    static let reloadAfterSeconds = 6

    var onReload: (() -> Void)?

    private let footnote = NSTextField(labelWithString: "")
    private var remaining = 0
    private var timer: Timer?

    override init(frame: NSRect) {
        super.init(frame: frame)

        let title = NSTextField(labelWithString: "The worktree UI isn't running")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.alignment = .center

        let body = NSTextField(labelWithAttributedString: OfflineView.body())
        body.alignment = .center

        footnote.font = .systemFont(ofSize: 11)
        footnote.textColor = .secondaryLabelColor
        footnote.alignment = .center

        let stack = NSStackView(views: [title, body, footnote])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// "Start it with `worktree ui`.", with the command in monospace.
    private static func body() -> NSAttributedString {
        let size: CGFloat = 13
        let s = NSMutableAttributedString(string: "Start it with ", attributes: [
            .font: NSFont.systemFont(ofSize: size), .foregroundColor: NSColor.labelColor,
        ])
        s.append(NSAttributedString(string: "worktree ui", attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: size, weight: .regular),
            .foregroundColor: NSColor.labelColor,
        ]))
        s.append(NSAttributedString(string: ".", attributes: [
            .font: NSFont.systemFont(ofSize: size), .foregroundColor: NSColor.labelColor,
        ]))
        return s
    }

    /// Starts (or restarts) the countdown from 6.
    func startCountdown() {
        timer?.invalidate()
        remaining = OfflineView.reloadAfterSeconds
        updateFootnote()
        let t = Timer(timeInterval: 1, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stopCountdown() {
        timer?.invalidate()
        timer = nil
    }

    @objc private func tick() {
        remaining -= 1
        if remaining <= 0 {
            stopCountdown()
            footnote.stringValue = "Reloading…"
            onReload?()
        } else {
            updateFootnote()
        }
    }

    private func updateFootnote() {
        footnote.stringValue = "Reloading in \(remaining)s…"
    }
}
