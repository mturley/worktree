import { useState } from "react"
import { ActionIcon, Alert, Badge, Button, Group, Paper, Popover, SegmentedControl, Stack, Text, UnstyledButton } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { relativeTime, relativeFromNow } from "../lib/relativeTime"
import { api } from "../api/client"
import { ResourceActions } from "./ResourceActions"
import { ResourceTitle } from "./ResourceStatusIcon"
import { EditResourceDetailsModal } from "./EditResourceDetailsModal"

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

/**
 * The user's own note about why this resource belongs to this worktree.
 * Shown for every resource type — unlike custom NAME, which only Slack
 * threads need because they have no title of their own.
 */
function CustomDescription({ r }: { r: ResourceDTO }) {
  if (!r.custom_description) return null
  return (
    <Text size="xs" c="dimmed" fs="italic" style={{ overflowWrap: "anywhere" }}>
      {r.custom_description}
    </Text>
  )
}

function MinimalRow({ r }: { r: ResourceDTO }) {
  return (
    <Group gap="xs">
      <Badge size="xs" variant="light">{r.type}</Badge>
      <ResourceTitle r={r} label={r.id} fw={400} />
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
      <ResourceTitle r={r} label={r.title || r.id} />
      <CustomDescription r={r} />
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
      <ResourceTitle r={r} label={r.title || r.id} />
      <CustomDescription r={r} />
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
        <ResourceTitle r={r} label={label} fw={500} />
      </Group>
      <CustomDescription r={r} />
      <Group gap="xs" wrap="wrap">
        {r.channel_name && <Text size="xs" c="dimmed">#{r.channel_name}</Text>}
        {r.author && <Text size="xs" c="dimmed">by {r.author}</Text>}
        {r.created_ts && <Text size="xs" c="dimmed">started {relativeFromNow(r.created_ts)}</Text>}
        {r.updated_ts && <Text size="xs" c="dimmed">· active {relativeFromNow(r.updated_ts)}</Text>}
      </Group>
    </Stack>
  )
}

/**
 * Confirm-then-remove control for a resource. Exported so the Slack thread
 * pane can put the same control in its header — a slack thread has no detail
 * ResourceCard to hang it off, and without it a thread would be the one
 * resource type you could not remove from the UI.
 */
/**
 * Labels the edit-details button.
 *
 * "Add" vs "Edit" reflects whether anything custom is set, so the button says
 * what it will do rather than assuming there is something to change.
 *
 * Only Slack threads have a custom NAME — a PR or Jira issue takes its title
 * from the source and only the description is ours to set — so the label
 * names just the fields that resource actually has.
 */
export function editDetailsLabel(r: ResourceDTO): string {
  const fields = r.type === "slack" ? "custom name/description" : "custom description"
  const has = r.type === "slack"
    ? Boolean(r.custom_name || r.custom_description)
    : Boolean(r.custom_description)
  return `${has ? "Edit" : "Add"} ${fields}`
}

export function RemoveControl({ r, path, onRemoved }: { r: ResourceDTO; path: string; onRemoved: () => void }) {
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
  /** Called after a custom name/description is saved, to refetch resources. */
  onMetaChanged?: () => void
}

export function ResourceCard({
  r,
  path = "",
  onRemoved = () => {},
  variant = "compact",
  selected = false,
  onSelect,
  onMetaChanged = () => {},
}: ResourceCardProps) {
  const [editOpen, setEditOpen] = useState(false)
  // Focus/Related is written straight through on change — no confirm step for
  // a reversible, one-click reclassification. `saving` only guards against a
  // double-fire while the request is in flight.
  const [savingPrimary, setSavingPrimary] = useState(false)
  const [primaryError, setPrimaryError] = useState<string | null>(null)

  const handlePrimaryChange = async (value: string) => {
    if (savingPrimary || !path) return
    setSavingPrimary(true)
    setPrimaryError(null)
    try {
      await api.setResourcePrimary({ path, type: r.type, id: r.id, primary: value === "focus" })
      onMetaChanged()
    } catch (e) {
      setPrimaryError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingPrimary(false)
    }
  }
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
      // Selectable cards get the clickable surface + hover/focus styling from
      // styles/cards.css; the detail pane renders this card without onSelect.
      data-interactive={onSelect ? "true" : undefined}
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
        {/*
          Only the detail card carries the remove control. List cards are
          clickable-to-select, so a per-card x there is visual noise and an
          easy mis-click; removal belongs with the selected resource.
        */}
        {variant === "detail" && (
          <Group gap={2} wrap="nowrap">
            <RemoveControl r={r} path={path} onRemoved={onRemoved} />
          </Group>
        )}
      </Group>
      {variant === "detail" && primaryError && (
        <Alert color="red" variant="light" mt={6} withCloseButton onClose={() => setPrimaryError(null)}>
          <Text size="xs">{primaryError}</Text>
        </Alert>
      )}
      {variant === "detail" && (
        <EditResourceDetailsModal
          opened={editOpen}
          r={r}
          onClose={() => setEditOpen(false)}
          onSaved={onMetaChanged}
        />
      )}
      {variant === "detail" && (
        // Bottom-right, on the same visual line as the card's metadata, so
        // the actions read as belonging to the card rather than heading it.
        <Group justify="space-between" gap="xs" wrap="wrap" mt={6}>
          {/* Bottom-left, spelled out rather than a bare pencil in the
              corner: the icon alone did not say what it edited, and the
              header is for the resource's own content. */}
          <Button
            size="xs"
            variant="subtle"
            leftSection="✎"
            onClick={(e) => {
              e.stopPropagation()
              setEditOpen(true)
            }}
          >
            {editDetailsLabel(r)}
          </Button>
          <Group gap="xs" wrap="wrap">
          {/* Left of the open/copy group: reclassifying is about this
              worktree, opening is about the resource itself. */}
          <SegmentedControl
            size="xs"
            value={r.primary ? "focus" : "related"}
            onChange={(v) => void handlePrimaryChange(v)}
            disabled={savingPrimary}
            data={[
              { value: "focus", label: "Focus" },
              { value: "related", label: "Related" },
            ]}
          />
          <ResourceActions r={r} />
          </Group>
        </Group>
      )}
    </Paper>
  )
}
