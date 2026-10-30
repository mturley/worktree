import AppKit

/// The popover's size, remembered across launches in the app's defaults.
enum PopoverSize {
    static let standard = NSSize(width: 600, height: 640)
    static let minimum = NSSize(width: 420, height: 480)

    private static let widthKey = "popoverWidth"
    private static let heightKey = "popoverHeight"

    /// The saved size, or the standard one when nothing (or nothing usable)
    /// was saved.
    static var saved: NSSize {
        let d = UserDefaults.standard
        let w = d.double(forKey: widthKey), h = d.double(forKey: heightKey)
        guard w >= minimum.width, h >= minimum.height else { return standard }
        return NSSize(width: w, height: h)
    }

    static func save(_ size: NSSize) {
        UserDefaults.standard.set(Double(size.width), forKey: widthKey)
        UserDefaults.standard.set(Double(size.height), forKey: heightKey)
    }

    static func reset() {
        UserDefaults.standard.removeObject(forKey: widthKey)
        UserDefaults.standard.removeObject(forKey: heightKey)
    }
}

/// A resize corner for the popover, which has none of its own. It sits over
/// the bottom-right corner of the content; dragging it resizes the popover and
/// double-clicking it restores the standard size.
@MainActor
final class ResizeGrip: NSView {
    static let side: CGFloat = 16

    weak var popover: NSPopover?

    /// From the mouse to the popover window's right edge, at mouse down.
    private var rightOffset: CGFloat = 0
    private var startY: CGFloat = 0
    private var startHeight: CGFloat = 0

    override func draw(_ dirtyRect: NSRect) {
        NSColor.tertiaryLabelColor.setStroke()
        let path = NSBezierPath()
        path.lineWidth = 1.5
        path.lineCapStyle = .round
        // Three strokes cutting across the corner, shortest nearest it.
        let pad: CGFloat = 3
        for reach in [6.0, 10.0, 14.0] as [CGFloat] {
            path.move(to: NSPoint(x: bounds.maxX - reach, y: bounds.minY + pad))
            path.line(to: NSPoint(x: bounds.maxX - pad, y: bounds.minY + reach))
        }
        path.stroke()
    }

    override func resetCursorRects() {
        if #available(macOS 15.0, *) {
            addCursorRect(bounds, cursor: .frameResize(position: .bottomRight, directions: .all))
        } else {
            addCursorRect(bounds, cursor: .crosshair)
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard let popover, let frame = window?.frame else { return }
        if event.clickCount == 2 {
            PopoverSize.reset()
            resize(popover, to: PopoverSize.standard)
            return
        }
        let mouse = NSEvent.mouseLocation
        rightOffset = frame.maxX - mouse.x
        startY = mouse.y
        startHeight = popover.contentSize.height
        popover.animates = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let popover, let frame = window?.frame else { return }
        let mouse = NSEvent.mouseLocation
        // The popover stays centred on its icon unless the screen edge stops
        // it, so the right edge moves by somewhere between half and all of a
        // width change. Asking for the full gap each event never overshoots
        // and closes on the cursor within a few events.
        let width = popover.contentSize.width + (mouse.x + rightOffset - frame.maxX)
        // It hangs from the menu bar, so the bottom edge follows the mouse.
        let height = startHeight + (startY - mouse.y)
        resize(popover, to: NSSize(width: width, height: height))
    }

    override func mouseUp(with event: NSEvent) {
        guard let popover, event.clickCount < 2 else { return }
        popover.animates = true
        PopoverSize.save(popover.contentSize)
    }

    private func resize(_ popover: NSPopover, to size: NSSize) {
        popover.contentSize = clamped(size)
    }

    /// Between the minimum and what fits on this screen below the menu bar.
    private func clamped(_ size: NSSize) -> NSSize {
        let visible = window?.screen?.visibleFrame.size ?? size
        let margin: CGFloat = 20
        let maxW = max(PopoverSize.minimum.width, visible.width - margin)
        let maxH = max(PopoverSize.minimum.height, visible.height - margin)
        return NSSize(width: min(max(size.width, PopoverSize.minimum.width), maxW),
                      height: min(max(size.height, PopoverSize.minimum.height), maxH))
    }
}
