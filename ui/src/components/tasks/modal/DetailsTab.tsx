import { Divider, Stack } from "@mantine/core"
import type { TaskDetail } from "../../../api/types"
import { DescriptionSection } from "./DescriptionSection"
import { LinkedEventsSection } from "./LinkedEventsSection"
import { LinksSection } from "./LinksSection"
import { SubtasksSection } from "./SubtasksSection"

/** The Details tab: Description, Subtasks, Linked to, Linked events — in that order. */
export function DetailsTab({ task }: { task: TaskDetail }) {
  return (
    <Stack gap="md" data-testid="task-details-tab">
      <DescriptionSection task={task} />
      <Divider />
      <SubtasksSection task={task} />
      <Divider />
      <LinksSection task={task} />
      <Divider />
      <LinkedEventsSection task={task} />
    </Stack>
  )
}
