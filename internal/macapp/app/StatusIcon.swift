import AppKit

/// The menu bar icon: favicon.svg's "wt" monogram in a rounded square, in one
/// of four states.
///
/// At rest the tile is solid, so the blink is a whole tile changing colour
/// rather than an outline that gets lost on a tinted menu bar. By default it
/// is the favicon's purple with a white monogram; with "Use purple wt icon"
/// off it is a template image with the monogram cut out, white or black to
/// follow the menu bar. While anything is unread it alternates with the tile
/// in the web UI's unread blue. The coloured tiles are full colour images (a
/// template image would turn them monochrome); the dimmed offline and login
/// outlines are template images.
///
/// With "Flash icon on unread activity" off, there is no blink: the resting
/// tile just carries the dot.
///
/// While unread, a blue dot also sits steady on the top-right corner through
/// both blink frames. It is a small layer-backed view over the button, not
/// part of any image; both unread frames have a notch cut where it sits, so
/// it reads apart from the blue tile.
@MainActor
final class StatusIcon {
    enum State {
        /// Solid tile: connected, nothing unread.
        case resting
        /// The tile filled blue, alternating with resting every 0.6s, under a
        /// steady blue dot (or just the dot, when flash is off).
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

    /// favicon.svg's tile colour (#5b21b6).
    static let faviconPurple = NSColor(srgbRed: 0x5b / 255.0, green: 0x21 / 255.0,
                                       blue: 0xb6 / 255.0, alpha: 1)

    /// An 18pt tile inside a 1pt margin that leaves the dot room to hang past
    /// the corner. The status item slot is 22pt high.
    private static let size = NSSize(width: 20, height: 20)
    private static let dotDiameter: CGFloat = 6
    /// The clear gap the frames leave around the dot.
    private static let notchGap: CGFloat = 1.5

    private let button: NSStatusBarButton
    private let dot = NSView()
    private var blinkTimer: Timer?
    private var blinkOn = false

    private let purpleImage = StatusIcon.glyph(.purple)
    private let purpleNotchedImage = StatusIcon.glyph(.purple, notched: true)
    private let cutoutImage = StatusIcon.glyph(.cutout)
    private let cutoutNotchedImage = StatusIcon.glyph(.cutout, notched: true)
    private let unreadImage = StatusIcon.glyph(.unread, notched: true)
    private let disconnectedImage = StatusIcon.glyph(.outline, alpha: 0.4, badge: .slash)
    private let needsLoginImage = StatusIcon.glyph(.outline, alpha: 0.4, badge: .lock)

    var state: State = .disconnected {
        didSet { if state != oldValue { apply() } }
    }

    private static let purpleKey = "purpleIcon"

    /// "Use purple wt icon": the resting tile in the favicon's purple rather
    /// than following the menu bar. On unless turned off; kept in the app's
    /// defaults.
    var purple: Bool = UserDefaults.standard.object(forKey: StatusIcon.purpleKey) as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(purple, forKey: StatusIcon.purpleKey)
            apply()
        }
    }

    private static let flashKey = "flashUnread"

    /// "Flash icon on unread activity": blink the tile while unread rather
    /// than only showing the dot. On unless turned off; kept in the app's
    /// defaults.
    var flash: Bool = UserDefaults.standard.object(forKey: StatusIcon.flashKey) as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(flash, forKey: StatusIcon.flashKey)
            apply()
        }
    }

    private var restingImage: NSImage { purple ? purpleImage : cutoutImage }
    private var unreadOffImage: NSImage { purple ? purpleNotchedImage : cutoutNotchedImage }

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
            blinkOn = flash
            button.image = flash ? unreadImage : unreadOffImage
            button.setAccessibilityLabel("Worktree: unread activity")
            placeDot()
            dot.isHidden = false
            guard flash else { break }
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
        /// Solid favicon purple with a white monogram (not a template).
        case purple
        /// Solid, with the monogram cut out of it (a template image).
        case cutout
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
                let fill: NSColor = switch tile {
                case .unread: unreadBlue
                case .purple: faviconPurple
                default: ink
                }
                fill.setFill()
                NSBezierPath(roundedRect: rect.insetBy(dx: 1, dy: 1), xRadius: 5.25, yRadius: 5.25).fill()
                ink = .white
            } else {
                let frame = NSBezierPath(roundedRect: rect.insetBy(dx: 1.75, dy: 1.75),
                                         xRadius: 4.5, yRadius: 4.5)
                frame.lineWidth = 1.5
                ink.setStroke()
                frame.stroke()
            }

            // On the cut-out tile, the monogram erases what it covers.
            if tile == .cutout { NSGraphicsContext.current?.cgContext.setBlendMode(.destinationOut) }
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
        image.isTemplate = tile == .outline || tile == .cutout
        return image
    }
}
