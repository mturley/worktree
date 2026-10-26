import { Menu, UnstyledButton } from "@mantine/core"
import type { TaskState } from "../../api/types"

/** Every task state's display name: the one place a state is spelled out. */
export const TASK_STATE_LABEL: Record<TaskState, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  done: "Done",
}

/** The states in their natural order. */
export const TASK_STATES: TaskState[] = ["not_started", "in_progress", "done"]

/** A state's display name, or `v` unchanged when it is not a TaskState ("deleted", say). */
export function taskStateLabel(v: string): string {
  return Object.hasOwn(TASK_STATE_LABEL, v) ? TASK_STATE_LABEL[v as TaskState] : v
}

const STATES = TASK_STATES.map((state) => ({ state, label: TASK_STATE_LABEL[state] }))

const SIZE = 16

/** Keeps the checkbox's clicks from the row (or other host) around it. */
const keepFromHost = (e: React.MouseEvent) => e.stopPropagation()

/** The checkbox drawing for a state, at `size` px. */
export function StateBox({ state, size }: { state: TaskState; size: number }) {
  const fill =
    state === "done"
      ? "var(--task-accent)"
      : state === "in_progress"
        ? "linear-gradient(135deg, var(--task-accent) 50%, transparent 50%)"
        : "transparent"
  return (
    <span
      data-state-box
      data-state={state}
      aria-hidden
      style={{
        width: size, height: size, flex: "none", borderRadius: 4, boxSizing: "border-box",
        border: "2px solid var(--task-accent)", background: fill,
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "var(--mantine-color-dark-9)", fontSize: Math.max(8, size - 5), lineHeight: 1, fontWeight: 700,
      }}
    >
      {state === "done" ? "✓" : null}
    </span>
  )
}

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
  return (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <UnstyledButton
          onClick={keepFromHost}
          aria-label={`State of “${title}”: ${current.label}`}
          className="task-row-control task-row-control-pad"
          style={{ flex: "none", display: "flex" }}
        >
          <StateBox state={state} size={SIZE} />
        </UnstyledButton>
      </Menu.Target>
      {/* A portal in the DOM, but React bubbles its events up the component
          tree all the same: without this a pick would also click the row. */}
      <Menu.Dropdown onClick={keepFromHost}>
        {/* Mantine fixes role="menuitem" (no menuitemradio), so the current
            state is marked with aria-current and a check. */}
        {STATES.map((s) => (
          <Menu.Item
            key={s.state}
            aria-current={s.state === state ? "true" : undefined}
            leftSection={
              <span aria-hidden style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 12, display: "inline-block" }}>{s.state === state ? "✓" : ""}</span>
                <StateBox state={s.state} size={SIZE} />
              </span>
            }
            onClick={() => onPick(s.state)}
          >
            {s.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  )
}
