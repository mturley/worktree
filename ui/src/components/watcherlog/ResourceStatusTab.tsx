import { useState } from "react"
import { Anchor, Group, Stack, Table, Text, Tooltip, UnstyledButton } from "@mantine/core"
import { IconAlertTriangleFilled, IconChevronDown, IconChevronUp, IconCircleCheckFilled, IconMinus, IconSelector } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { WatchedResourceStatus } from "../../api/types"
import { relativeTime } from "../../lib/relativeTime"
import { nextSort, SOURCE_LABEL, sortResources, type ResourceSort, type ResourceSortColumn } from "../../lib/watcherLog"

/** A sortable column header: click cycles ascending, descending, unsorted. */
function SortableTh({ label, column, sort, onSort }: {
  label: string
  column: ResourceSortColumn
  sort: ResourceSort
  onSort: (column: ResourceSortColumn) => void
}) {
  const dir = sort?.column === column ? sort.dir : null
  const Icon = dir === "asc" ? IconChevronUp : dir === "desc" ? IconChevronDown : IconSelector
  return (
    <Table.Th aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}>
      <UnstyledButton onClick={() => onSort(column)} fz="inherit" fw="inherit">
        <Group gap={4} wrap="nowrap">
          {label}
          <Icon size={12} aria-hidden style={{ opacity: dir ? 1 : 0.5 }} />
        </Group>
      </UnstyledButton>
    </Table.Th>
  )
}

function fmtTime(ts?: string): string {
  if (!ts) return "—"
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString()
}

function StatusIcon({ r }: { r: WatchedResourceStatus }) {
  const d = r.detail
  const lines = [
    `Last attempt: ${fmtTime(r.last_attempt)}`,
    `Outcome: ${r.status === "never" ? "never polled" : d?.ok ? "success" : "failed"}`,
    d?.duration_ms ? `Duration: ${(d.duration_ms / 1000).toFixed(1)} s` : null,
    d?.http_status ? `HTTP ${d.http_status}` : null,
    d ? `Events emitted: ${d.events_emitted}` : null,
    r.status === "error" && r.error_message ? `Error: ${r.error_message}` : null,
    r.status !== "error" && r.last_error ? `Last failed: ${fmtTime(r.last_error)}` : null,
    d?.note ? `Note: ${d.note}` : null,
    r.resource_updated_at ? `Resource last changed: ${fmtTime(r.resource_updated_at)}` : null,
  ].filter(Boolean) as string[]
  const icon =
    r.status === "error" ? (
      <Text span c="red" role="img" tabIndex={0} aria-label="error" style={{ display: "inline-flex" }}><IconAlertTriangleFilled size={14} /></Text>
    ) : r.status === "ok" ? (
      <Text span c="green" role="img" tabIndex={0} aria-label="ok" style={{ display: "inline-flex" }}><IconCircleCheckFilled size={14} /></Text>
    ) : (
      <Text span c="dimmed" role="img" tabIndex={0} aria-label="never polled" style={{ display: "inline-flex" }}><IconMinus size={14} /></Text>
    )
  return (
    <Tooltip multiline w={320} withArrow label={<Stack gap={2}>{lines.map((l) => <Text key={l} size="xs">{l}</Text>)}</Stack>}>
      {icon}
    </Tooltip>
  )
}

export function ResourceStatusTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["watcher-resources"],
    queryFn: api.watchedResources,
    refetchInterval: 10_000,
  })
  const [sort, setSort] = useState<ResourceSort>(null)
  const rows = sortResources(data?.resources ?? [], sort)
  const onSort = (column: ResourceSortColumn) => setSort((s) => nextSort(s, column))
  if (error && !data) {
    const msg = error instanceof Error ? error.message : String(error)
    return <Text size="sm" c="red" py="lg">Couldn't load resource status: {msg}</Text>
  }
  if (!isLoading && rows.length === 0) {
    return <Text size="sm" c="dimmed" ta="center" py="lg">No resources are being watched.</Text>
  }
  return (
    // maxHeight, not the mah style prop: mah caps the ScrollArea root, which
    // clips (overflow: hidden) while its viewport grows to the full table, so
    // nothing scrolls. maxHeight caps the inner element and the viewport scrolls.
    <Table.ScrollContainer minWidth={480} maxHeight="60vh">
      <Table striped highlightOnHover verticalSpacing={4} fz="xs">
        <Table.Thead>
          <Table.Tr>
            <SortableTh label="Source" column="source" sort={sort} onSort={onSort} />
            <Table.Th>Resource</Table.Th>
            <SortableTh label="Updated" column="updated" sort={sort} onSort={onSort} />
            <SortableTh label="Status" column="status" sort={sort} onSort={onSort} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r) => (
            <Table.Tr key={`${r.type}:${r.id}`}>
              <Table.Td>{SOURCE_LABEL[r.type] ?? r.type}</Table.Td>
              <Table.Td>
                {r.url ? <Anchor href={r.url} target="_blank" rel="noreferrer" size="xs">{r.name}</Anchor> : r.name}
              </Table.Td>
              <Table.Td>{r.last_success ? relativeTime(r.last_success) : "Never"}</Table.Td>
              <Table.Td><StatusIcon r={r} /></Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  )
}
