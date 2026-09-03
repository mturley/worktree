import { Divider } from "@mantine/core"

/**
 * The line separating unread from read.
 *
 * Shared by the Slack thread view and the single-resource activity feed so
 * the two cannot drift: "new below this line" must look like one idea, not
 * two features that happen to both draw a rule.
 */
export function UnreadDivider() {
  return <Divider label="New" labelPosition="center" color="blue" my="sm" />
}
