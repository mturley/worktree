import { Anchor, Badge, Group, Paper, Stack, Text } from "@mantine/core"
import type { TimelineEvent } from "../api/types"

function rel(ts: string): string {
  const d = new Date(ts).getTime()
  if (!d) return ts
  const s = Math.floor((Date.now() - d) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function EventRow({ e, showWorktrees }: { e: TimelineEvent; showWorktrees?: boolean }) {
  return (
    <Paper p="sm" withBorder>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={2}>
          <Group gap="xs">
            <Badge size="sm" variant="light">{e.type_label || e.type}</Badge>
            <Text size="sm" fw={600}>{e.title}</Text>
          </Group>
          {e.resource_title && (
            <Text size="xs" c="dimmed">
              {e.resource_url ? <Anchor href={e.resource_url} target="_blank" size="xs">{e.resource_title}</Anchor> : e.resource_title}
            </Text>
          )}
          {e.body && <Text size="xs" c="dimmed" lineClamp={3}>{e.body}</Text>}
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
