import { useState } from "react"
import { Accordion, ActionIcon, Alert, Button, Center, Group, Loader, Stack, Text, Title, Tooltip } from "@mantine/core"
import { IconRefresh } from "@tabler/icons-react"
import type { LinkedSection } from "../../api/types"
import type { useLinkedResources } from "../../hooks/useLinkedResources"
import { relativeTime } from "../../lib/relativeTime"
import { HierarchyTree } from "./HierarchyTree"
import { LinkedResourceRow } from "./LinkedResourceRow"
import { useSearchQuery } from "../../hooks/useSearchQuery"
import { filterLinkedSections } from "../../lib/linkedSearch"
import { SearchSummary } from "../search/SearchSummary"

type LinkedQuery = ReturnType<typeof useLinkedResources>

/** `matches`, while searching, replaces the total — as the home page's tab badges count results. */
export function linkedTabLabel(data?: { count: number }, matches?: number | null): string {
  if (!data) return "Linked Resources"
  return `Linked Resources (${matches ?? data.count})`
}

/** A hierarchy that is only the current issue (no parent, no children) says nothing. */
function isLoneCurrent(tree?: LinkedSection["tree"]): boolean {
  return tree?.length === 1 && !!tree[0].current && !tree[0].children?.length
}

function isEmpty(s: LinkedSection): boolean {
  return !s.error && !s.items?.length && !s.groups?.length && (!s.tree?.length || isLoneCurrent(s.tree))
}

/** One section as an accordion item: its title is the toggle. */
function SectionView({ s, path, searching }: { s: LinkedSection; path?: string; searching: boolean }) {
  return (
    <Accordion.Item value={s.kind}>
      <Accordion.Control>
        <Title order={6}>{s.title}</Title>
      </Accordion.Control>
      <Accordion.Panel>
        <Stack gap={2}>
          {s.error && <Alert color="red" variant="light" p="xs"><Text size="sm">{s.error}</Text></Alert>}
          {s.items?.map((it) => <LinkedResourceRow key={`${it.type}:${it.id}`} item={it} path={path} />)}
          {s.groups?.map((g) => (
            <Stack key={g.label} gap={0} pl="xs">
              <Text size="xs" c="dimmed" fw={600}>{g.label}</Text>
              {/* Indented under the relationship so each group reads as its own subsection. */}
              <Stack gap={2} pl="md" data-testid="link-group-items">
                {g.items.map((it) => <LinkedResourceRow key={`${it.type}:${it.id}`} item={it} path={path} />)}
              </Stack>
            </Stack>
          ))}
          {s.tree && <HierarchyTree roots={s.tree} path={path} unfold={searching} />}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  )
}

/**
 * The sections, each collapsible and all open to start. What's tracked is
 * which ones were collapsed, not which are open, so a section that first
 * appears on a refresh opens like the rest. The panel remounts each time the
 * tab is shown, which reopens everything.
 */
function Sections({ sections, path, searching = false }: { sections: LinkedSection[]; path?: string; searching?: boolean }) {
  const [collapsed, setCollapsed] = useState<string[]>([])
  return (
    <Accordion
      multiple
      chevronPosition="left"
      value={sections.map((s) => s.kind).filter((k) => !collapsed.includes(k))}
      onChange={(open) => setCollapsed(sections.map((s) => s.kind).filter((k) => !open.includes(k)))}
    >
      {sections.map((s) => <SectionView key={s.kind} s={s} path={path} searching={searching} />)}
    </Accordion>
  )
}

/** The Linked Resources tab body. */
export function LinkedResourcesPanel({ query, path }: { query: LinkedQuery; path?: string }) {
  const search = useSearchQuery()
  // The resource's own watcher is off: nothing to retry, and nothing wrong.
  if (query.error && !query.data && query.error.message.includes("watcher is disabled")) {
    return <Text size="sm" c="dimmed" ta="center" py="md">{query.error.message}, so linked resources aren't fetched.</Text>
  }
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
  if (search.terms.length === 0) return <Sections sections={visible} path={path} />
  const found = filterLinkedSections(visible, search.terms)
  return (
    <Stack gap="xs">
      <SearchSummary count={found.count ?? 0} noun={["linked resource", "linked resources"]} />
      {found.unsearched && (
        <Text size="xs" c="dimmed" fs="italic">Hierarchy branches that haven't been loaded weren't searched.</Text>
      )}
      {/* Keyed by the query: the tree's expansion is per-mount state, and a
          new search has new paths to open. With no matches the line above
          says so, and nothing renders here. */}
      {found.sections.length > 0 && (
        <Sections key={search.terms.join(" ")} sections={found.sections} path={path} searching />
      )}
    </Stack>
  )
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
