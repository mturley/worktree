import { Tooltip } from "@mantine/core"
import type { TaskState } from "../api/types"
import { StateBox } from "./tasks/TaskStateCheckbox"
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
export function EventDot({ type, size = 22, label: labelOverride, dimmed = false, taskState }: {
  type: string
  size?: number
  /**
   * A task event's resulting state: that task checkbox is drawn inside the
   * coloured circle in place of the type's icon, so a task's activity reads
   * like its row does.
   */
  taskState?: TaskState
  /**
   * Steps the dot back alongside a dimmed title (an archived event). The
   * colour is mixed toward the page background rather than faded with
   * opacity, which would let the timeline rail show through the circle.
   */
  dimmed?: boolean
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
        data-task-state={taskState}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: dimmed ? `color-mix(in srgb, ${cssColor} 40%, var(--mantine-color-body))` : cssColor,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          // Sits on top of the timeline rail, so it needs to hide the line
          // behind it rather than let it show through the circle's edges.
          boxShadow: "0 0 0 3px var(--mantine-color-body)",
        }}
      >
        {/* A task event shows the checkbox of the state it left the task in,
            in place of the type's icon. */}
        {taskState
          ? <StateBox state={taskState} size={Math.round(size * 0.55)} tone="dark" />
          : <Icon size={size * 0.6} stroke={2.5} color="var(--mantine-color-dark-9)" />}
      </span>
    </Tooltip>
  )
}
