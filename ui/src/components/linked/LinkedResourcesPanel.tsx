import { ActionIcon, Alert, Button, Center, Group, Loader, Stack, Text, Title, Tooltip } from "@mantine/core"
import { IconRefresh } from "@tabler/icons-react"
import type { LinkedSection } from "../../api/types"
import type { useLinkedResources } from "../../hooks/useLinkedResources"
import { relativeTime } from "../../lib/relativeTime"
import { HierarchyTree } from "./HierarchyTree"
import { LinkedResourceRow } from "./LinkedResourceRow"

type LinkedQuery = ReturnType<typeof useLinkedResources>

export function linkedTabLabel(data?: { count: number }): string {
  return data ? `Linked Resources (${data.count})` : "Linked Resources"
}

/** A hierarchy that is only the current issue (no parent, no children) says nothing. */
function isLoneCurrent(tree?: LinkedSection["tree"]): boolean {
  return tree?.length === 1 && !!tree[0].current && !tree[0].children?.length
}

function isEmpty(s: LinkedSection): boolean {
  return !s.error && !s.items?.length && !s.groups?.length && (!s.tree?.length || isLoneCurrent(s.tree))
}

function SectionView({ s, path }: { s: LinkedSection; path?: string }) {
  return (
    <Stack gap={2}>
      <Title order={6}>{s.title}</Title>
      {s.error && <Alert color="red" variant="light" p="xs"><Text size="sm">{s.error}</Text></Alert>}
      {s.items?.map((it) => <LinkedResourceRow key={`${it.type}:${it.id}`} item={it} path={path} />)}
      {s.groups?.map((g) => (
        <Stack key={g.label} gap={0} pl="xs">
          <Text size="xs" c="dimmed" fw={600}>{g.label}</Text>
          {g.items.map((it) => <LinkedResourceRow key={`${it.type}:${it.id}`} item={it} path={path} />)}
        </Stack>
      ))}
      {s.tree && <HierarchyTree roots={s.tree} path={path} />}
    </Stack>
  )
}

/** The Linked Resources tab body. */
export function LinkedResourcesPanel({ query, path }: { query: LinkedQuery; path?: string }) {
  if (query.error && !query.data) {
    return (
      <Alert color="red" variant="light" title="Couldn't load linked resources">
        <Group gap="sm">
          <Text size="sm">{query.error.message}</Text>
          <Button size="compact-sm" variant="light" onClick={query.refetch}>Retry</Button>
        </Group>
      </Alert>
    )
  }
  if (!query.data) {
    return <Center py="md"><Loader size="sm" /></Center>
  }
  const visible = query.data.sections.filter((s) => !isEmpty(s))
  if (visible.length === 0) {
    return <Text size="sm" c="dimmed" ta="center" py="md">No linked resources found</Text>
  }
  return <Stack gap="md">{visible.map((s) => <SectionView key={s.kind} s={s} path={path} />)}</Stack>
}

/**
 * The Linked tab's freshness and refresh, for the far end of the tab bar:
 * when the view was fetched, and a refresh that bypasses the server's cache.
 * Ordered and styled like the Activity tab's ("Updated …" then
 * RefreshWatchersButton) so the two read as one control.
 */
export function LinkedTabControls({ query }: { query: LinkedQuery }) {
  const busy = query.refreshing
  return (
    <Group gap={6} wrap="nowrap" align="center">
      {query.data?.fetched_at && (
        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>{`Fetched ${relativeTime(query.data.fetched_at)}`}</Text>
      )}
      {query.refreshError && (
        <Text size="xs" c="red" role="alert" style={{ whiteSpace: "nowrap" }}>{`Refresh failed: ${query.refreshError.message}`}</Text>
      )}
      <Tooltip label={busy ? "Refreshing…" : "Refresh linked resources"}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label="Refresh linked resources"
          aria-busy={busy}
          disabled={busy}
          onClick={() => void query.refresh()}
        >
          <IconRefresh
            size={16}
            style={{ animation: busy ? "wt-spin 900ms linear infinite" : undefined }}
          />
        </ActionIcon>
      </Tooltip>
    </Group>
  )
}
