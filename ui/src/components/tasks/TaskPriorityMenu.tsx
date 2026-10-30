import { Menu, UnstyledButton } from "@mantine/core"
import type { Priority } from "../../api/types"

export const PRIORITY_MARK: Record<Priority, { text: string; color: string } | null> = {
  high: { text: "!!!", color: "var(--mantine-color-red-4)" },
  medium: { text: "!!", color: "var(--mantine-color-amber-4, var(--mantine-color-yellow-4))" },
  low: { text: "!", color: "var(--mantine-color-blue-8)" },
  none: null,
}

/**
 * A task checkbox's colours for its priority: the box in the priority mark's
 * colour, or the text colour with none, and a check that stays legible on
 * the filled box (white on low's dark blue).
 */
export function priorityInk(priority: Priority): { box: string; check: string } {
  const box = PRIORITY_MARK[priority]?.color ?? "var(--mantine-color-text)"
  return { box, check: priority === "low" ? "var(--mantine-color-white)" : "var(--mantine-color-dark-9)" }
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
}

/** The priorities in menu order. */
export const PRIORITIES: Priority[] = ["high", "medium", "low", "none"]

/** A mark as the row shows it; the menu's options use the same. */
const MARK_STYLE = {
  width: 22, display: "inline-block", fontWeight: 700, fontSize: "var(--mantine-font-size-sm)",
} as const

/** A priority's mark at the menu's size, or an empty space of its width for none. */
export function PriorityGlyph({ priority }: { priority: Priority }) {
  const mark = PRIORITY_MARK[priority]
  return <span aria-hidden style={{ ...MARK_STYLE, color: mark?.color }}>{mark?.text ?? ""}</span>
}

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
          className={mark ? "task-row-control" : "task-row-control task-priority-none"}
          style={{ ...MARK_STYLE, flex: "none", color: mark?.color ?? "var(--mantine-color-gray-5)" }}
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
            leftSection={
              <span aria-hidden style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 12, display: "inline-block" }}>{p === priority ? "✓" : ""}</span>
                <PriorityGlyph priority={p} />
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
