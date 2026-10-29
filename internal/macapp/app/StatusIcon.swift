import AppKit

/// The menu bar icon: a "wt" monogram in a rounded square (a simplified
/// favicon.svg), in one of four states.
///
/// Every image here is a template image, so the glyph follows the light and
/// dark menu bar. The unread dot is not part of any image: it is a small
/// layer-backed view over the button, so it can stay systemBlue (a template
/// image would turn it monochrome).
@MainActor
final class StatusIcon {
    enum State {
        /// Plain glyph: connected, nothing unread.
        case resting
        /// Glyph plus a blue dot, alternating with resting every 0.6s.
        case unread
        /// Dimmed glyph with a slash: the server can't be reached.
        case disconnected
        /// Dimmed glyph with a lock badge: the dropdown shows the login page.
        case needsLogin
    }

    /// Seconds each blink frame is shown. Matches BLINK_MS in
    /// ui/src/lib/blinkTicker.ts so the icon and the favicon keep one rhythm.
    static let blinkInterval: TimeInterval = 0.6

    private static let size = NSSize(width: 18, height: 18)
    private static let dotDiameter: CGFloat = 6

    private let button: NSStatusBarButton
    private let dot = NSView()
    private var blinkTimer: Timer?

    private let restingImage = StatusIcon.glyph(alpha: 1, badge: .none)
    private let disconnectedImage = StatusIcon.glyph(alpha: 0.4, badge: .slash)
    private let needsLoginImage = StatusIcon.glyph(alpha: 0.4, badge: .lock)

    var state: State = .disconnected {
        didSet { if state != oldValue { apply() } }
    }

    init(button: NSStatusBarButton) {
        self.button = button
        dot.wantsLayer = true
        dot.layer?.backgroundColor = NSColor.systemBlue.cgColor
        dot.layer?.cornerRadius = StatusIcon.dotDiameter / 2
        dot.isHidden = true
        button.addSubview(dot)
        apply()
    }

    private func apply() {
        blinkTimer?.invalidate()
        blinkTimer = nil
        dot.isHidden = true
        switch state {
        case .resting:
            button.image = restingImage
            button.setAccessibilityLabel("Worktree")
        case .unread:
            button.image = restingImage
            button.setAccessibilityLabel("Worktree: unread activity")
            placeDot()
            dot.isHidden = false
            // .common so the blink keeps going while the right-click menu is
            // tracking (the default mode pauses during menu tracking).
            let timer = Timer(timeInterval: StatusIcon.blinkInterval, target: self,
                              selector: #selector(blink), userInfo: nil, repeats: true)
            RunLoop.main.add(timer, forMode: .common)
            blinkTimer = timer
        case .disconnected:
            button.image = disconnectedImage
            button.setAccessibilityLabel("Worktree: the web UI isn't running")
        case .needsLogin:
            button.image = needsLoginImage
            button.setAccessibilityLabel("Worktree: log in needed")
        }
    }

    @objc private func blink() {
        placeDot()
        dot.isHidden.toggle()
    }

    /// Puts the dot on the glyph's top-right corner. The image is centred in
    /// the button, whose size and flippedness are AppKit's business, so this
    /// is recomputed rather than fixed once.
    private func placeDot() {
        let b = button.bounds
        let d = StatusIcon.dotDiameter
        let imageMaxX = b.midX + StatusIcon.size.width / 2
        let imageTop = b.midY + (button.isFlipped ? -1 : 1) * StatusIcon.size.height / 2
        let y = button.isFlipped ? imageTop - 1 : imageTop - d + 1
        dot.frame = NSRect(x: imageMaxX - d + 1, y: y, width: d, height: d)
    }

    private enum Badge { case none, slash, lock }

    private static func glyph(alpha: CGFloat, badge: Badge) -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            let ink = NSColor.black.withAlphaComponent(alpha)

            let frame = NSBezierPath(roundedRect: rect.insetBy(dx: 1.75, dy: 1.75),
                                     xRadius: 4, yRadius: 4)
            frame.lineWidth = 1.5
            ink.setStroke()
            frame.stroke()

            let text = NSAttributedString(string: "wt", attributes: [
                .font: NSFont.systemFont(ofSize: 9.5, weight: .bold),
                .foregroundColor: ink,
            ])
            let t = text.size()
            text.draw(at: NSPoint(x: rect.midX - t.width / 2, y: rect.midY - t.height / 2 + 0.5))

            guard let ctx = NSGraphicsContext.current else { return true }
            switch badge {
            case .none:
                break
            case .slash:
                // Cut a gap either side of the slash so it reads over the
                // glyph, then draw it at full strength.
                let slash = NSBezierPath()
                slash.move(to: NSPoint(x: rect.minX + 1, y: rect.minY + 1))
                slash.line(to: NSPoint(x: rect.maxX - 1, y: rect.maxY - 1))
                slash.lineCapStyle = .round
                ctx.compositingOperation = .clear
                slash.lineWidth = 4
                slash.stroke()
                ctx.compositingOperation = .sourceOver
                slash.lineWidth = 1.5
                NSColor.black.setStroke()
                slash.stroke()
            case .lock:
                let badgeRect = NSRect(x: rect.maxX - 10, y: rect.minY, width: 10, height: 10)
                ctx.compositingOperation = .clear
                NSBezierPath(ovalIn: badgeRect.insetBy(dx: -1, dy: -1)).fill()
                ctx.compositingOperation = .sourceOver
                let config = NSImage.SymbolConfiguration(pointSize: 8, weight: .bold)
                if let lock = NSImage(systemSymbolName: "lock.fill", accessibilityDescription: nil)?
                    .withSymbolConfiguration(config) {
                    let s = lock.size
                    lock.draw(in: NSRect(x: badgeRect.midX - s.width / 2, y: badgeRect.midY - s.height / 2,
                                         width: s.width, height: s.height))
                }
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}
