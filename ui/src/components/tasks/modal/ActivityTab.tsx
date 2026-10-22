import { Text } from "@mantine/core"
import type { TaskDetail } from "../../../api/types"

/** The Activity tab body. A placeholder until Task 7 fills it in. */
export function ActivityTab({ task }: { task: TaskDetail }) {
  return <Text size="sm" c="dimmed" data-testid="task-activity-tab">Activity for {task.ref}</Text>
}
