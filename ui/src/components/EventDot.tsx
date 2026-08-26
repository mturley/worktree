import { eventMeta } from "../lib/eventMeta"

/**
 * The timeline's dot: the event's colour with its icon inside.
 *
 * Colour and icon both come from the shared eventMeta, so the dot cannot
 * disagree with any other surface that colours events.
 */
export function EventDot({ type, size = 22, label: labelOverride }: {
  type: string
  size?: number
  /**
   * Overrides the accessible name. The row passes the event's own type_label
   * ("PR comments") which is more specific than the kind name ("comment") —
   * and, since the rail dropped the text badge, is the only place that label
   * still appears outside the details modal.
   */
  label?: string
}) {
  // cssColor, not color: `color` is a Mantine palette NAME ("grape"), which
  // is not a valid CSS colour — and the few that happen to be valid CSS
  // ("violet", "indigo") would silently paint the wrong shade.
  const { cssColor, Icon, label: kindLabel } = eventMeta(type)
  const label = labelOverride || kindLabel
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: cssColor,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        // Sits on top of the timeline rail, so it needs to hide the line
        // behind it rather than let it show through the circle's edges.
        boxShadow: "0 0 0 3px var(--mantine-color-body)",
      }}
    >
      <Icon size={size * 0.6} stroke={2.5} color="var(--mantine-color-dark-9)" />
    </span>
  )
}
