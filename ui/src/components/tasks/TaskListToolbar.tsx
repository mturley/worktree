import { Group, Select, Switch, Text } from "@mantine/core"
import type { TaskListPrefs, TaskSort } from "../../lib/taskSections"

const SORT_OPTIONS: { value: TaskSort; label: string }[] = [
  { value: "custom", label: "Custom" },
  { value: "priority", label: "Priority" },
  { value: "state", label: "State" },
  { value: "due", label: "Due date" },
  { value: "updated", label: "Updated" },
]

/**
 * A closed Select just wide enough for the option it shows: the text in `ch`,
 * plus room for the input's padding and chevron. Its open list sizes itself
 * (`comboboxProps.width: "max-content"`).
 */
const fitWidth = (options: { value: string; label: string }[], value: string) =>
  `calc(${(options.find((o) => o.value === value) ?? options[0]).label.length}ch + 40px)`

/** Sort and show completed (+ include archived), for every task list at once. */
export function TaskListToolbar({ prefs, onChange }: {
  prefs: TaskListPrefs
  onChange(p: Partial<TaskListPrefs>): void
}) {
  return (
    <Group gap="sm" wrap="wrap" justify="flex-end">
      <Group gap={4} wrap="nowrap">
        <Text size="xs" c="dimmed">Sort:</Text>
        <Select
          size="xs"
          w={fitWidth(SORT_OPTIONS, prefs.sort)}
          comboboxProps={{ width: "max-content" }}
          aria-label="Sort tasks"
          data={SORT_OPTIONS}
          value={prefs.sort}
          allowDeselect={false}
          onChange={(v) => v && onChange({ sort: v as TaskSort })}
        />
      </Group>
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
