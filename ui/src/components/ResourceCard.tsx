import { Anchor, Badge, Group, Paper, Stack, Text } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { relativeTime } from "../lib/relativeTime"

function prStateColor(state?: string): string {
  switch ((state || "").toUpperCase()) {
    case "OPEN": return "green"
    case "MERGED": return "violet"
    case "CLOSED": return "red"
    default: return "gray"
  }
}

function reviewColor(decision?: string): string {
  switch ((decision || "").toUpperCase()) {
    case "APPROVED": return "green"
    case "CHANGES_REQUESTED": return "orange"
    case "REVIEW_REQUIRED": return "gray"
    default: return "gray"
  }
}

function reviewLabel(decision?: string): string {
  switch ((decision || "").toUpperCase()) {
    case "APPROVED": return "approved"
    case "CHANGES_REQUESTED": return "changes requested"
    case "REVIEW_REQUIRED": return "review required"
    default: return decision || ""
  }
}

function ciColor(status?: string): string {
  switch ((status || "").toLowerCase()) {
    case "success": return "green"
    case "failure": return "red"
    case "pending": return "yellow"
    default: return "gray"
  }
}

function prNumber(id: string): string {
  const m = id.match(/#(\d+)$/)
  return m ? `#${m[1]}` : id
}

function isEnriched(r: ResourceDTO): boolean {
  return Boolean(
    r.title || r.state || r.review_decision || r.ci_status || r.author ||
    r.status || r.priority || r.issue_type || r.assignee || (r.labels && r.labels.length > 0) || r.updated_at
  )
}

function MinimalRow({ r }: { r: ResourceDTO }) {
  return (
    <Group gap="xs">
      <Badge size="xs" variant="light">{r.type}</Badge>
      {r.url ? <Anchor href={r.url} target="_blank" size="sm">{r.id}</Anchor> : <Text size="sm">{r.id}</Text>}
    </Group>
  )
}

function PRCardBody({ r }: { r: ResourceDTO }) {
  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="wrap">
        <Badge size="xs" variant="light">PR</Badge>
        <Text size="xs" c="dimmed">{prNumber(r.id)}</Text>
      </Group>
      <Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
        {r.url ? <Anchor href={r.url} target="_blank">{r.title || r.id}</Anchor> : (r.title || r.id)}
      </Text>
      <Group gap={4} wrap="wrap">
        {r.state && <Badge size="xs" color={prStateColor(r.state)}>{r.state.toLowerCase()}</Badge>}
        {r.review_decision && <Badge size="xs" color={reviewColor(r.review_decision)}>{reviewLabel(r.review_decision)}</Badge>}
        {r.ci_status && <Badge size="xs" color={ciColor(r.ci_status)}>ci: {r.ci_status}</Badge>}
        {r.new_commits_since_review && <Badge size="xs" color="blue" variant="outline">new commits</Badge>}
      </Group>
      <Text size="xs" c="dimmed">
        {r.author && `by ${r.author}`}
        {r.author && r.updated_at && " · "}
        {r.updated_at && `updated ${relativeTime(r.updated_at)}`}
      </Text>
    </Stack>
  )
}

function JiraCardBody({ r }: { r: ResourceDTO }) {
  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="wrap">
        <Badge size="xs" variant="light">Jira</Badge>
        <Text size="xs" c="dimmed">{r.id}</Text>
      </Group>
      <Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
        {r.url ? <Anchor href={r.url} target="_blank">{r.title || r.id}</Anchor> : (r.title || r.id)}
      </Text>
      <Group gap={4} wrap="wrap">
        {r.status && <Badge size="xs" variant="light">{r.status}</Badge>}
        {r.priority && <Badge size="xs" variant="light" color="orange">{r.priority}</Badge>}
        {r.issue_type && <Badge size="xs" variant="outline">{r.issue_type}</Badge>}
      </Group>
      {r.labels && r.labels.length > 0 && (
        <Group gap={4} wrap="wrap">
          {r.labels.map((l) => <Badge key={l} size="xs" variant="dot">{l}</Badge>)}
        </Group>
      )}
      <Text size="xs" c="dimmed">
        {r.assignee && `→ ${r.assignee}`}
        {r.assignee && r.updated_at && " · "}
        {r.updated_at && `updated ${relativeTime(r.updated_at)}`}
      </Text>
    </Stack>
  )
}

export function ResourceCard({ r }: { r: ResourceDTO }) {
  return (
    <Paper key={`${r.type}:${r.id}`} p="xs" withBorder>
      {!isEnriched(r) ? (
        <MinimalRow r={r} />
      ) : r.type === "pr" ? (
        <PRCardBody r={r} />
      ) : r.type === "jira" ? (
        <JiraCardBody r={r} />
      ) : (
        <MinimalRow r={r} />
      )}
    </Paper>
  )
}
