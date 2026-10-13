import { Anchor, Stack, Table, Text, Tooltip } from "@mantine/core"
import { IconAlertTriangleFilled, IconCircleCheckFilled, IconMinus } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { WatchedResourceStatus, WatcherLogScope } from "../../api/types"
import { relativeTime } from "../../lib/relativeTime"

const SOURCE_LABEL: Record<string, string> = { pr: "GitHub", jira: "Jira", slack: "Slack" }

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
      <Text span c="red" aria-label="error" style={{ display: "inline-flex" }}><IconAlertTriangleFilled size={14} /></Text>
    ) : r.status === "ok" ? (
      <Text span c="green" aria-label="ok" style={{ display: "inline-flex" }}><IconCircleCheckFilled size={14} /></Text>
    ) : (
      <Text span c="dimmed" aria-label="never polled" style={{ display: "inline-flex" }}><IconMinus size={14} /></Text>
    )
  return (
    <Tooltip multiline w={320} withArrow label={<Stack gap={2}>{lines.map((l) => <Text key={l} size="xs">{l}</Text>)}</Stack>}>
      {icon}
    </Tooltip>
  )
}

export function ResourceStatusTab({ scope }: { scope: WatcherLogScope }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["watcher-resources", scope],
    queryFn: () => api.watchedResources(scope),
    refetchInterval: 10_000,
  })
  const rows = data?.resources ?? []
  if (error && !data) {
    const msg = error instanceof Error ? error.message : String(error)
    return <Text size="sm" c="red" py="lg">Couldn't load resource status: {msg}</Text>
  }
  if (!isLoading && rows.length === 0) {
    return <Text size="sm" c="dimmed" ta="center" py="lg">No resources are being watched.</Text>
  }
  return (
    <Table.ScrollContainer minWidth={480} mah="60vh">
      <Table striped highlightOnHover verticalSpacing={4} fz="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Source</Table.Th>
            <Table.Th>Resource</Table.Th>
            <Table.Th>Updated</Table.Th>
            <Table.Th>Status</Table.Th>
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
