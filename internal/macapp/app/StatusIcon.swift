import AppKit

/// The menu bar icon: favicon.svg's "wt" monogram in a rounded square, in one
/// of four states.
///
/// Every image but the unread one is a template image, so the glyph follows
/// the light and dark menu bar. At rest the tile is solid with the monogram
/// cut out, so the blink is a whole tile changing colour rather than an
/// outline that gets lost on a tinted menu bar. The unread frame is a full
/// colour image (a template image would turn it monochrome): the tile filled
/// with the web UI's unread blue, the monogram in white.
///
/// While unread, a blue dot also sits steady on the top-right corner through
/// both blink frames. It is a small layer-backed view over the button, not
/// part of any image, so it stays blue over the template frame; both unread
/// frames have a notch cut where it sits, so it reads apart from the blue
/// tile.
@MainActor
final class StatusIcon {
    enum State {
        /// Solid tile: connected, nothing unread.
        case resting
        /// The tile filled blue, alternating with resting every 0.6s, under a
        /// steady blue dot.
        case unread
        /// Dimmed outline with a slash: the server can't be reached.
        case disconnected
        /// Dimmed outline with a lock badge: the dropdown shows the login page.
        case needsLogin
    }

    /// Seconds each blink frame is shown. Matches BLINK_MS in
    /// ui/src/lib/blinkTicker.ts so the icon and the favicon keep one rhythm.
    static let blinkInterval: TimeInterval = 0.6

    /// Mantine's blue-5 (#339af0), the unread blue the web UI paints with
    /// (ui/src/components/UnreadMarkerDot.tsx).
    static let unreadBlue = NSColor(srgbRed: 0x33 / 255.0, green: 0x9a / 255.0,
                                    blue: 0xf0 / 255.0, alpha: 1)

    private static let size = NSSize(width: 18, height: 18)
    private static let dotDiameter: CGFloat = 6
    /// The clear gap the frames leave around the dot.
    private static let notchGap: CGFloat = 1.5

    private let button: NSStatusBarButton
    private let dot = NSView()
    private var blinkTimer: Timer?
    private var blinkOn = false

    private let restingImage = StatusIcon.glyph(.solid)
    private let unreadOffImage = StatusIcon.glyph(.solid, notched: true)
    private let unreadImage = StatusIcon.glyph(.unread, notched: true)
    private let disconnectedImage = StatusIcon.glyph(.outline, alpha: 0.4, badge: .slash)
    private let needsLoginImage = StatusIcon.glyph(.outline, alpha: 0.4, badge: .lock)

    var state: State = .disconnected {
        didSet { if state != oldValue { apply() } }
    }

    init(button: NSStatusBarButton) {
        self.button = button
        dot.wantsLayer = true
        dot.layer?.backgroundColor = StatusIcon.unreadBlue.cgColor
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
            blinkOn = true
            button.image = unreadImage
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
        blinkOn.toggle()
        button.image = blinkOn ? unreadImage : unreadOffImage
        placeDot()
    }

    /// The dot's centre in image coordinates (origin bottom-left): on the
    /// tile's top-right corner, hanging 1pt past the image so it clears the
    /// monogram. The button has room around the image for it.
    private static var dotCenter: NSPoint {
        NSPoint(x: size.width - dotDiameter / 2 + 1, y: size.height - dotDiameter / 2 + 1)
    }

    /// Puts the dot over the image's notch. The image is centred in the
    /// button, whose size and flippedness are AppKit's business, so this is
    /// recomputed rather than fixed once.
    private func placeDot() {
        let b = button.bounds
        let d = StatusIcon.dotDiameter
        let c = StatusIcon.dotCenter
        let x = b.midX - StatusIcon.size.width / 2 + c.x - d / 2
        let fromTop = StatusIcon.size.height - c.y // image top to dot centre
        let imageTop = b.midY + (button.isFlipped ? -1 : 1) * StatusIcon.size.height / 2
        let y = button.isFlipped ? imageTop + fromTop - d / 2 : imageTop - fromTop - d / 2
        dot.frame = NSRect(x: x, y: y, width: d, height: d)
    }

    private enum Badge { case none, slash, lock }

    /// The "wt" glyph outlines from ui/public/favicon.svg, in its 64×64 space
    /// (y down). Copied verbatim so the icon matches the favicon, centring
    /// included; TestMonogramMatchesFavicon fails if the two drift apart.
    private static let monogramPath =
        "M15.42 47L9.56 25.02L15.61 25.02L18.93 41.32L19.05 41.32L22.95 25.02L28.69 25.02L32.61 41.32L32.73 41.32L36.07 25.02L41.98 25.02L36.15 47L29.78 47L25.8 31.46L25.67 31.46L21.72 47Z M51.55 47.45Q47.9 47.45 46.14 45.91Q44.38 44.38 44.38 40.85L44.38 29.53L41.32 29.53L41.32 25.02L44.38 25.02L44.38 19.64L50.42 19.64L50.42 25.02L54.44 25.02L54.44 29.53L50.42 29.53L50.42 40.19Q50.42 41.73 51.11 42.33Q51.8 42.94 53.15 42.94Q53.56 42.94 53.87 42.91Q54.18 42.88 54.44 42.84L54.44 47.23Q53.95 47.31 53.22 47.38Q52.5 47.45 51.55 47.45Z"

    /// monogramPath scaled from the favicon's 64×64 tile onto tile (y up).
    /// The path uses only M, L, Q and Z; a quadratic segment becomes the
    /// equivalent cubic, since NSBezierPath has no quadratic before macOS 14.
    private static func monogram(in tile: NSRect) -> NSBezierPath {
        let scale = tile.width / 64
        func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
            NSPoint(x: tile.minX + x * scale, y: tile.maxY - y * scale)
        }
        // Commands are single letters; numbers run on until a space or the
        // next letter ("47L9.56" is 47, L, 9.56).
        var commands: [(Character, [CGFloat])] = []
        var digits = ""
        func flush() {
            if let n = Double(digits), !commands.isEmpty { commands[commands.count - 1].1.append(CGFloat(n)) }
            digits = ""
        }
        for c in monogramPath {
            if c.isLetter {
                flush()
                commands.append((c, []))
            } else if c == " " {
                flush()
            } else {
                digits.append(c)
            }
        }
        flush()

        let path = NSBezierPath()
        for (command, n) in commands {
            switch (command, n.count) {
            case ("M", 2): path.move(to: point(n[0], n[1]))
            case ("L", 2): path.line(to: point(n[0], n[1]))
            case ("Q", 4):
                let p0 = path.currentPoint
                let q = point(n[0], n[1]), p = point(n[2], n[3])
                path.curve(to: p,
                           controlPoint1: NSPoint(x: p0.x + 2 / 3 * (q.x - p0.x), y: p0.y + 2 / 3 * (q.y - p0.y)),
                           controlPoint2: NSPoint(x: p.x + 2 / 3 * (q.x - p.x), y: p.y + 2 / 3 * (q.y - p.y)))
            case ("Z", 0): path.close()
            default: break
            }
        }
        return path
    }

    private enum Tile {
        /// A stroked frame around the monogram.
        case outline
        /// Solid, with the monogram cut out of it (a template image).
        case solid
        /// Solid unread blue with a white monogram (not a template).
        case unread
    }

    private static func glyph(_ tile: Tile, alpha: CGFloat = 1, badge: Badge = .none,
                              notched: Bool = false) -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            var ink = NSColor.black.withAlphaComponent(alpha)

            if tile != .outline {
                // Out to the stroked frame's outer edge, so the tile is the
                // same size in every state.
                (tile == .unread ? unreadBlue : ink).setFill()
                NSBezierPath(roundedRect: rect.insetBy(dx: 1, dy: 1), xRadius: 4.75, yRadius: 4.75).fill()
                if tile == .unread { ink = .white }
            } else {
                let frame = NSBezierPath(roundedRect: rect.insetBy(dx: 1.75, dy: 1.75),
                                         xRadius: 4, yRadius: 4)
                frame.lineWidth = 1.5
                ink.setStroke()
                frame.stroke()
            }

            // On the solid tile, the monogram erases what it covers.
            if tile == .solid { NSGraphicsContext.current?.cgContext.setBlendMode(.destinationOut) }
            ink.setFill()
            // Inside the outline's stroke the full-size monogram would touch
            // the frame, so it is drawn smaller there.
            let inset: CGFloat = tile == .outline ? 2.5 : 1
            monogram(in: rect.insetBy(dx: inset, dy: inset)).fill()
            NSGraphicsContext.current?.cgContext.setBlendMode(.normal)

            guard let ctx = NSGraphicsContext.current else { return true }
            if notched {
                let r = dotDiameter / 2 + notchGap
                ctx.compositingOperation = .clear
                NSBezierPath(ovalIn: NSRect(x: dotCenter.x - r, y: dotCenter.y - r,
                                            width: r * 2, height: r * 2)).fill()
                ctx.compositingOperation = .sourceOver
            }
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
        image.isTemplate = tile != .unread
        return image
    }
}
