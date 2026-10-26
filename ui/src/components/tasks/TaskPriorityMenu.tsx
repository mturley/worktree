import { Menu, UnstyledButton } from "@mantine/core"
import type { Priority } from "../../api/types"

export const PRIORITY_MARK: Record<Priority, { text: string; color: string } | null> = {
  high: { text: "!!!", color: "var(--mantine-color-red-4)" },
  medium: { text: "!!", color: "var(--mantine-color-amber-4, var(--mantine-color-yellow-4))" },
  low: { text: "!", color: "var(--mantine-color-gray-5)" },
  none: null,
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
}

/** The priorities in menu order. */
export const PRIORITIES: Priority[] = ["high", "medium", "low", "none"]

/** Keeps the menu's clicks from the row (or other host) around it. */
const keepFromHost = (e: React.MouseEvent) => e.stopPropagation()

/**
 * A row's priority mark, which opens a menu of the priorities. A task with no
 * priority shows a faint placeholder `!` (see `.task-priority-none`).
 */
export function TaskPriorityMenu({ priority, title, onPick }: {
  priority: Priority
  title: string
  onPick: (p: Priority) => void
}) {
  const mark = PRIORITY_MARK[priority]
  return (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <UnstyledButton
          onClick={keepFromHost}
          aria-label={`Priority of “${title}”: ${PRIORITY_LABEL[priority]}`}
          className={mark ? undefined : "task-priority-none"}
          style={{
            width: 22, flex: "none", fontWeight: 700, fontSize: "var(--mantine-font-size-sm)",
            color: mark?.color ?? "var(--mantine-color-gray-5)",
          }}
        >
          {mark?.text ?? "!"}
        </UnstyledButton>
      </Menu.Target>
      {/* A portal in the DOM, but React bubbles its events up the component
          tree all the same: without this a pick would also click the row. */}
      <Menu.Dropdown onClick={keepFromHost}>
        {PRIORITIES.map((p) => (
          <Menu.Item
            key={p}
            aria-current={p === priority ? "true" : undefined}
            leftSection={<span aria-hidden style={{ width: 12, display: "inline-block" }}>{p === priority ? "✓" : ""}</span>}
            rightSection={
              <span aria-hidden style={{ width: 22, display: "inline-block", fontWeight: 700, color: PRIORITY_MARK[p]?.color }}>
                {PRIORITY_MARK[p]?.text ?? ""}
              </span>
            }
            onClick={() => onPick(p)}
          >
            {PRIORITY_LABEL[p]}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  )
}
