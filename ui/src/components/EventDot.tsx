import { Tooltip } from "@mantine/core"
import { eventLabel, eventMeta } from "../lib/eventMeta"

/**
 * The timeline's dot: the event's colour with its icon inside, and its type
 * label on hover.
 *
 * The label is a Mantine Tooltip, not the native `title` attribute. `title`
 * on a 22px target is unreliable — it needs a long, still hover and is easy
 * to miss entirely — which is why the first version of this appeared not to
 * work at all. Tooltip also matches the rest of the app's hover affordances.
 */
export function EventDot({ type, size = 22, label: labelOverride }: {
  type: string
  size?: number
  /**
   * Overrides the label. The row passes the event's own type_label ("PR
   * comments"), which is more specific than the mapping's generic name
   * ("comment").
   */
  label?: string
}) {
  // cssColor, not color: `color` is a Mantine palette NAME ("grape"), which
  // is not a valid CSS colour — and the few that happen to be valid CSS
  // ("violet", "indigo") would silently paint the wrong shade.
  const { cssColor, Icon } = eventMeta(type)
  const label = eventLabel(type, labelOverride)

  return (
    <Tooltip label={label} withArrow openDelay={150}>
      <span
        role="img"
        aria-label={label}
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
    </Tooltip>
  )
}
