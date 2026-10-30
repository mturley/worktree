import { Button, Group, Popover, Select, Stack, Switch, Text } from "@mantine/core"
import { IconChevronDown } from "@tabler/icons-react"
import type { TaskListPrefs, TaskSort } from "../../lib/taskSections"

const SORT_OPTIONS: { value: TaskSort; label: string }[] = [
  { value: "priority", label: "Priority" },
  { value: "state", label: "State" },
  { value: "due", label: "Due date" },
  { value: "updated", label: "Updated" },
  { value: "custom", label: "Custom" },
]

/**
 * A closed Select just wide enough for the option it shows: the text in `ch`,
 * plus room for the input's padding and chevron. Its open list sizes itself
 * (`comboboxProps.width: "max-content"`).
 */
const fitWidth = (options: { value: string; label: string }[], value: string) =>
  `calc(${(options.find((o) => o.value === value) ?? options[0]).label.length}ch + 40px)`

/**
 * Sort, and a View options dropdown (show completed + include archived, and
 * the In progress / Starred pins), for every task list at once.
 */
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
      <Popover position="bottom-end" shadow="md" withinPortal>
        <Popover.Target>
          <Button size="compact-xs" variant="default" rightSection={<IconChevronDown size={12} />}>
            View options
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap="xs">
            <Switch
              size="xs"
              label="Pin in-progress tasks to top"
              checked={prefs.pinInProgress}
              onChange={(e) => onChange({ pinInProgress: e.currentTarget.checked })}
            />
            <Switch
              size="xs"
              label="Pin starred tasks to top"
              checked={prefs.pinStarred}
              onChange={(e) => onChange({ pinStarred: e.currentTarget.checked })}
            />
            <Switch
              size="xs"
              label="Show completed"
              checked={prefs.showCompleted}
              onChange={(e) => onChange({ showCompleted: e.currentTarget.checked })}
            />
            {/* Archived gates only done tasks, so it means nothing until
                completed ones show: disabled until then. */}
            <Switch
              size="xs"
              label="Include archived"
              disabled={!prefs.showCompleted}
              checked={prefs.includeArchived}
              onChange={(e) => onChange({ includeArchived: e.currentTarget.checked })}
            />
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </Group>
  )
}
