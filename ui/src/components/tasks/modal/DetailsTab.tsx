import { Text } from "@mantine/core"
import type { TaskDetail } from "../../../api/types"

/** The Details tab body. A placeholder until Task 5 fills it in. */
export function DetailsTab({ task }: { task: TaskDetail }) {
  return <Text size="sm" c="dimmed" data-testid="task-details-tab">Details for {task.ref}</Text>
}
