import { Anchor, Group, Text } from "@mantine/core"
import { useWorktreeResource } from "../../hooks/useWorktreeResource"
import { shortResourceRef } from "../../lib/resourceRef"
import { InfoRow } from "../InfoRow"
import { ResourceStatusIcon } from "../ResourceStatusIcon"
import { ResourceHoverCard } from "../tasks/LinkHoverCards"

/**
 * The PR the worktree's branch tracks, in the Git summary: its status icon,
 * `#N` (hover for the card, click to open it) and its title on one line.
 */
export function PRRow({ path, prId, onOpen }: { path: string; prId: string; onOpen?: () => void }) {
  const resource = useWorktreeResource(path, "pr", prId)
  return (
    <InfoRow label="PR">
      <Group gap={6} wrap="nowrap" component="span">
        {resource && <ResourceStatusIcon r={resource} />}
        <ResourceHoverCard type="pr" id={prId}>
          <Anchor component="button" type="button" size="sm" onClick={onOpen} style={{ flex: "none" }}>
            {shortResourceRef("pr", prId)}
          </Anchor>
        </ResourceHoverCard>
        {resource?.title && <Text span inherit lineClamp={1} style={{ minWidth: 0 }}>{resource.title}</Text>}
      </Group>
    </InfoRow>
  )
}
