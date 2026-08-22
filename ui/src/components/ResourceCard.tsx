import { useState } from "react"
import { ActionIcon, Alert, Anchor, Badge, Button, Group, Paper, Popover, Stack, Text, UnstyledButton } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { relativeTime, relativeFromNow } from "../lib/relativeTime"
import { api } from "../api/client"

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
    r.title || r.state || r.review_decision || r.ci_status || r.new_commits_since_review || r.author ||
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

function JiraCardBody({ r, variant }: { r: ResourceDTO; variant: ResourceCardVariant }) {
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
      {variant === "detail" && r.labels && r.labels.length > 0 && (
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

function SlackCardBody({ r }: { r: ResourceDTO }) {
  const label = r.custom_name || r.title || r.id
  return (
    <Stack gap={2}>
      <Group gap="xs" wrap="wrap">
        <Badge size="xs" variant="light" color="grape">Slack</Badge>
        {r.url ? <Anchor href={r.url} target="_blank" size="sm">{label}</Anchor> : <Text size="sm">{label}</Text>}
      </Group>
      <Group gap="xs" wrap="wrap">
        {r.channel_name && <Text size="xs" c="dimmed">#{r.channel_name}</Text>}
        {r.author && <Text size="xs" c="dimmed">by {r.author}</Text>}
        {r.created_ts && <Text size="xs" c="dimmed">started {relativeFromNow(r.created_ts)}</Text>}
        {r.updated_ts && <Text size="xs" c="dimmed">· active {relativeFromNow(r.updated_ts)}</Text>}
      </Group>
    </Stack>
  )
}

function RemoveControl({ r, path, onRemoved }: { r: ResourceDTO; path: string; onRemoved: () => void }) {
  const [opened, setOpened] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const handleRemove = async () => {
    setRemoving(true)
    try {
      await api.removeResource({ path, type: r.type, id: r.id })
      setRemoveError(null)
      setOpened(false)
      onRemoved()
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : String(err))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <Popover
      opened={opened}
      onChange={(v) => {
        setOpened(v)
        if (v) setRemoveError(null)
      }}
      withArrow
      position="bottom-end"
    >
      <Popover.Target>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          aria-label="Remove resource"
          onClick={(e) => {
            e.stopPropagation()
            setOpened((v) => !v)
          }}
        >
          <Text size="sm" lh={1}>×</Text>
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={6}>
          <Text size="sm">Remove this resource?</Text>
          {removeError ? (
            <Alert color="red" variant="light" p="xs">
              <Text size="xs">{removeError}</Text>
            </Alert>
          ) : null}
          <Group gap={6} justify="flex-end">
            <Button size="xs" variant="default" onClick={() => setOpened(false)} disabled={removing}>
              Cancel
            </Button>
            <Button size="xs" color="red" onClick={() => void handleRemove()} loading={removing}>
              Remove
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}

export type ResourceCardVariant = "compact" | "detail"

interface ResourceCardProps {
  r: ResourceDTO
  path?: string
  onRemoved?: () => void
  /** "detail" adds the fuller summary (e.g. Jira labels) shown in the pane. */
  variant?: ResourceCardVariant
  selected?: boolean
  /** When provided, the card becomes selectable. */
  onSelect?: () => void
}

export function ResourceCard({
  r,
  path = "",
  onRemoved = () => {},
  variant = "compact",
  selected = false,
  onSelect,
}: ResourceCardProps) {
  const body = r.type === "slack" ? (
    <SlackCardBody r={r} />
  ) : !isEnriched(r) ? (
    <MinimalRow r={r} />
  ) : r.type === "pr" ? (
    <PRCardBody r={r} />
  ) : r.type === "jira" ? (
    <JiraCardBody r={r} variant={variant} />
  ) : (
    <MinimalRow r={r} />
  )

  return (
    <Paper
      p="xs"
      withBorder
      // A selected card is tinted so the current selection is obvious next to
      // the pane it drives.
      bg={selected ? "var(--mantine-color-blue-light)" : undefined}
      style={selected ? { borderColor: "var(--mantine-color-blue-filled)" } : undefined}
    >
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        {onSelect ? (
          <UnstyledButton
            onClick={onSelect}
            aria-pressed={selected}
            aria-label={`select resource ${r.id}`}
            style={{ flex: 1, minWidth: 0, textAlign: "left" }}
          >
            {body}
          </UnstyledButton>
        ) : (
          <div style={{ flex: 1, minWidth: 0 }}>{body}</div>
        )}
        <RemoveControl r={r} path={path} onRemoved={onRemoved} />
      </Group>
    </Paper>
  )
}
