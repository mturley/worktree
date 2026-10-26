import { Group, Select, Switch } from "@mantine/core"
import type { Priority } from "../../api/types"
import type { TaskListPrefs, TaskSort } from "../../lib/taskSections"

const SORT_OPTIONS: { value: TaskSort; label: string }[] = [
  { value: "custom", label: "Custom" },
  { value: "priority", label: "Priority" },
  { value: "due", label: "Due date" },
  { value: "updated", label: "Recently updated" },
]

const PRIORITY_OPTIONS: { value: Priority | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "none", label: "None" },
]

/** Sort, priority filter and show completed (+ include archived), for every task list at once. */
export function TaskListToolbar({ prefs, onChange }: {
  prefs: TaskListPrefs
  onChange(p: Partial<TaskListPrefs>): void
}) {
  return (
    <Group gap="xs" wrap="wrap">
      <Select
        size="xs"
        w={150}
        aria-label="Sort tasks"
        data={SORT_OPTIONS}
        value={prefs.sort}
        allowDeselect={false}
        onChange={(v) => v && onChange({ sort: v as TaskSort })}
      />
      <Select
        size="xs"
        w={110}
        aria-label="Filter tasks by priority"
        data={PRIORITY_OPTIONS}
        value={prefs.priority}
        allowDeselect={false}
        onChange={(v) => v && onChange({ priority: v as Priority | "all" })}
      />
      <Switch
        size="xs"
        label="Show completed"
        checked={prefs.showCompleted}
        onChange={(e) => onChange({ showCompleted: e.currentTarget.checked })}
      />
      {prefs.showCompleted && (
        <Switch
          size="xs"
          label="Include archived"
          checked={prefs.includeArchived}
          onChange={(e) => onChange({ includeArchived: e.currentTarget.checked })}
        />
      )}
    </Group>
  )
}
