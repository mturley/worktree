import AppKit

/// Shown over the web view when a load fails at the network level (connection
/// refused: there is no page to show its own countdown). It only says so and
/// waits: AppDelegate watches for the server (ServerWatch) and swaps the page
/// back in when it answers, so there is no countdown here.
@MainActor
final class OfflineView: NSView {
    private let footnote = NSTextField(labelWithString: "Waiting for it to start…")

    override init(frame: NSRect) {
        super.init(frame: frame)

        let title = NSTextField(labelWithString: "The worktree UI server isn't running.")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.alignment = .center

        let body = NSTextField(labelWithString: "Start it in a terminal with")
        body.font = .systemFont(ofSize: 13)
        body.alignment = .center

        let command = OfflineView.code("worktree ui")

        let cmux = NSTextField(wrappingLabelWithString: "To enable cmux features, start it within a cmux terminal.")
        cmux.font = .systemFont(ofSize: 12)
        cmux.textColor = .secondaryLabelColor
        cmux.alignment = .center

        footnote.font = .systemFont(ofSize: 11)
        footnote.textColor = .secondaryLabelColor
        footnote.alignment = .center

        let stack = NSStackView(views: [title, body, command, cmux, footnote])
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

    /// A command set off as code, on its own line: monospace on a rounded,
    /// tinted box. NSBox, so the tint follows light and dark mode.
    private static func code(_ text: String) -> NSView {
        let label = NSTextField(labelWithString: text)
        label.font = .monospacedSystemFont(ofSize: 13, weight: .semibold)
        label.translatesAutoresizingMaskIntoConstraints = false

        let box = NSBox()
        box.boxType = .custom
        box.borderWidth = 0
        box.cornerRadius = 5
        box.fillColor = .quaternaryLabelColor
        box.contentViewMargins = .zero
        box.titlePosition = .noTitle
        box.contentView?.addSubview(label)
        if let content = box.contentView {
            NSLayoutConstraint.activate([
                label.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 8),
                label.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -8),
                label.topAnchor.constraint(equalTo: content.topAnchor, constant: 3),
                label.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -3),
            ])
        }
        return box
    }
}
