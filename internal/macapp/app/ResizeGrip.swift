import AppKit

/// The page's modes (its `view` message), each with its own popover size.
enum DropdownView: String {
    case collapsed, expanded

    var standard: NSSize {
        switch self {
        case .collapsed: return NSSize(width: 600, height: 800)
        case .expanded: return NSSize(width: 1200, height: 800)
        }
    }

    /// Expanded fits two columns of collapsed's minimum width. The page opens
    /// its task and event details windowed from expanded's minimum width up
    /// (MINI_WINDOWED_MODAL_MIN_WIDTH in ui/src/hooks/useMiniModalFullScreen.ts).
    var minimum: NSSize {
        switch self {
        case .expanded: return NSSize(width: 840, height: 480)
        case .collapsed: return NSSize(width: 420, height: 480)
        }
    }

    /// Collapsed keeps the keys from when there was one size, so that size
    /// carries over as the collapsed one.
    fileprivate var keys: (width: String, height: String) {
        switch self {
        case .collapsed: return ("popoverWidth", "popoverHeight")
        case .expanded: return ("popoverExpandedWidth", "popoverExpandedHeight")
        }
    }
}

/// The narrowest the popover gets while a task is open: the page's `sm`
/// breakpoint (48em), from which the task's sidebar sits beside its content.
let taskMinWidth: CGFloat = 768

/// Each mode's popover size, remembered across launches in the app's defaults.
enum PopoverSize {
    /// The mode's saved size, or its standard one when nothing (or nothing
    /// usable) was saved.
    static func saved(_ view: DropdownView) -> NSSize {
        let d = UserDefaults.standard
        let w = d.double(forKey: view.keys.width), h = d.double(forKey: view.keys.height)
        guard w >= view.minimum.width, h >= view.minimum.height else { return view.standard }
        return NSSize(width: w, height: h)
    }

    static func save(_ size: NSSize, for view: DropdownView) {
        UserDefaults.standard.set(Double(size.width), forKey: view.keys.width)
        UserDefaults.standard.set(Double(size.height), forKey: view.keys.height)
    }

    static func reset(_ view: DropdownView) {
        UserDefaults.standard.removeObject(forKey: view.keys.width)
        UserDefaults.standard.removeObject(forKey: view.keys.height)
    }

    static func resetAll() {
        for view in [DropdownView.collapsed, .expanded] { reset(view) }
    }

    /// Drops the sizes once kept for a task's and an event's details, which
    /// now take the mode's size.
    static func dropRetiredKeys() {
        for key in ["popoverTaskWidth", "popoverTaskHeight", "popoverEventWidth", "popoverEventHeight"] {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    /// The mode's minimum, no narrower than taskMinWidth while a task is open.
    static func minimum(_ view: DropdownView, taskOpen: Bool) -> NSSize {
        var m = view.minimum
        if taskOpen { m.width = max(m.width, taskMinWidth) }
        return m
    }

    /// Between the minimum and what fits on screen below the menu bar.
    static func clamped(_ size: NSSize, for view: DropdownView, taskOpen: Bool, on screen: NSScreen?) -> NSSize {
        let minimum = minimum(view, taskOpen: taskOpen)
        let visible = screen?.visibleFrame.size ?? size
        let margin: CGFloat = 20
        let maxW = max(minimum.width, visible.width - margin)
        let maxH = max(minimum.height, visible.height - margin)
        return NSSize(width: min(max(size.width, minimum.width), maxW),
                      height: min(max(size.height, minimum.height), maxH))
    }
}

/// A resize corner for the popover, which has none of its own. It sits over
/// the bottom-right corner of the content; dragging it resizes the popover and
/// double-clicking it restores the standard size. Either applies only to the
/// mode showing, including while a task is open (which keeps the popover no
/// narrower than taskMinWidth).
@MainActor
final class ResizeGrip: NSView {
    static let side: CGFloat = 16

    weak var popover: NSPopover?
    /// The mode showing, whose size this changes.
    var currentView: () -> DropdownView = { .collapsed }
    /// Whether a task is open, which sets a wider minimum.
    var taskOpen: () -> Bool = { false }

    /// From the mouse to the popover window's right edge, at mouse down.
    private var rightOffset: CGFloat = 0
    private var startY: CGFloat = 0
    private var startHeight: CGFloat = 0
    /// Whether the mouse moved since mouse down. A click alone saves nothing,
    /// so it can't turn a default, or a size shrunk to fit this screen, into
    /// the view's own.
    private var dragged = false

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
            let view = currentView()
            PopoverSize.reset(view)
            resize(popover, to: view.standard)
            return
        }
        let mouse = NSEvent.mouseLocation
        rightOffset = frame.maxX - mouse.x
        startY = mouse.y
        startHeight = popover.contentSize.height
        dragged = false
        popover.animates = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let popover, let frame = window?.frame else { return }
        dragged = true
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
        if dragged { PopoverSize.save(popover.contentSize, for: currentView()) }
    }

    private func resize(_ popover: NSPopover, to size: NSSize) {
        popover.contentSize = PopoverSize.clamped(size, for: currentView(), taskOpen: taskOpen(), on: window?.screen)
    }
}
