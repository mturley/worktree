import { Anchor, Badge, Group, Paper, Stack, Text } from "@mantine/core"
import type { TimelineEvent } from "../api/types"
import { relativeTime as rel } from "../lib/relativeTime"

export function EventRow({ e, showWorktrees }: { e: TimelineEvent; showWorktrees?: boolean }) {
  return (
    <Paper p="sm" withBorder>
      <Group justify="space-between" wrap="wrap" align="flex-start">
        <Stack gap={2} style={{ flex: "1 1 200px", minWidth: 0 }}>
          <Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
            <Badge size="sm" variant="light">{e.type_label || e.type}</Badge>
            <Text size="sm" fw={600} style={{ overflowWrap: "anywhere", minWidth: 0 }}>{e.title}</Text>
          </Group>
          {e.resource_title && (
            <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
              {e.resource_url ? <Anchor href={e.resource_url} target="_blank" size="xs">{e.resource_title}</Anchor> : e.resource_title}
            </Text>
          )}
          {e.body && <Text size="xs" c="dimmed" lineClamp={3} style={{ overflowWrap: "anywhere" }}>{e.body}</Text>}
          {showWorktrees && e.worktrees.length > 0 && (
            <Group gap={4}>{e.worktrees.map((w) => <Badge key={w} size="xs" variant="outline">{w}</Badge>)}</Group>
          )}
        </Stack>
        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
          {e.author && `${e.author} · `}{rel(e.external_ts || e.ts)}
        </Text>
      </Group>
    </Paper>
  )
}
