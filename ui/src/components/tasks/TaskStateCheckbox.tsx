import { Menu, UnstyledButton } from "@mantine/core"
import type { TaskState } from "../../api/types"

const STATES: { state: TaskState; label: string }[] = [
  { state: "not_started", label: "Not started" },
  { state: "in_progress", label: "In progress" },
  { state: "done", label: "Done" },
]

const SIZE = 16

/**
 * Empty = not started, diagonally half-filled = in progress, filled with a
 * check = done. A click only opens the menu; nothing changes until a pick.
 */
export function TaskStateCheckbox({ state, title, onPick }: {
  state: TaskState
  /** The task's title, so the control's name says which task it is. */
  title: string
  onPick: (s: TaskState) => void
}) {
  const current = STATES.find((s) => s.state === state)!
  const fill =
    state === "done"
      ? "var(--task-accent)"
      : state === "in_progress"
        ? "linear-gradient(135deg, var(--task-accent) 50%, transparent 50%)"
        : "transparent"
  return (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <UnstyledButton
          aria-label={`State of “${title}”: ${current.label}`}
          style={{
            width: SIZE, height: SIZE, flex: "none", borderRadius: 4,
            border: "2px solid var(--task-accent)", background: fill,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--mantine-color-dark-9)", fontSize: 11, lineHeight: 1, fontWeight: 700,
          }}
        >
          {state === "done" ? "✓" : null}
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        {/* Mantine fixes role="menuitem" (no menuitemradio), so the current
            state is marked with aria-current and a check. */}
        {STATES.map((s) => (
          <Menu.Item
            key={s.state}
            aria-current={s.state === state ? "true" : undefined}
            leftSection={<span aria-hidden style={{ width: 12, display: "inline-block" }}>{s.state === state ? "✓" : ""}</span>}
            onClick={() => onPick(s.state)}
          >
            {s.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  )
}
