import { Badge, Group, Stack, Text, Title, UnstyledButton } from "@mantine/core"
import type { TaskDetail } from "../../../api/types"
import { taskStateLabel } from "../TaskStateCheckbox"
import { useTaskModal } from "./TaskModalProvider"

/**
 * "Blocks": the tasks this one blocks. Each row opens its task in this
 * modal, in place of this one: open() replaces the history entry while the
 * modal is open, so one close still returns to the page underneath.
 */
export function BlocksSection({ task }: { task: TaskDetail }) {
  const { open } = useTaskModal()
  return (
    <Stack gap={6}>
      <Title order={6}>Blocks</Title>
      {task.blocks.length === 0 ? (
        <Text size="sm" c="dimmed">Blocks no other tasks.</Text>
      ) : (
        <Stack gap={2}>
          {task.blocks.map((b) => (
            <UnstyledButton
              key={b.id}
              onClick={() => open(b.id)}
              px={4}
              py={2}
              style={{ borderRadius: "var(--mantine-radius-sm)" }}
              className="task-blocks-row"
            >
              <Group gap="xs" wrap="nowrap">
                <Text size="sm" c="dimmed" style={{ flex: "none" }}>{b.ref}</Text>
                <Text
                  size="sm"
                  truncate="end"
                  style={{ flex: 1, minWidth: 0, opacity: b.state === "done" ? 0.6 : 1 }}
                  td={b.state === "done" ? "line-through" : undefined}
                >
                  {b.title}
                </Text>
                <Badge size="xs" variant="light" color="gray" style={{ flex: "none" }}>
                  {taskStateLabel(b.state)}
                </Badge>
              </Group>
            </UnstyledButton>
          ))}
        </Stack>
      )}
    </Stack>
  )
}
