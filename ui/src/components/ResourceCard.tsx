import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ActionIcon, Alert, Badge, Button, Group, Paper, Popover, SegmentedControl, Stack, Text, UnstyledButton } from "@mantine/core"
import { IconTrash } from "@tabler/icons-react"
import type { NotifyMode, ResourceDTO } from "../api/types"
import { relativeTime, relativeFromNow } from "../lib/relativeTime"
import { api } from "../api/client"
import { ResourceActions } from "./ResourceActions"
import { ResourceTitle } from "./ResourceStatusIcon"
import { ResourceTypeLine, awaitsFetch } from "./ResourceTypeLine"
import { cardEdgeStyle, hasUnread } from "../lib/unread"
import { UnreadBadge } from "./UnreadBadge"
import { EditResourceDetailsModal } from "./EditResourceDetailsModal"
import { supportsCustomName } from "../lib/customName"
import { TAB_ID } from "../lib/tabId"
import { NotifySwitch } from "./NotifySwitch"
import { NotifyBell } from "./NotifyBell"

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

/**
 * The user's own note about why this resource belongs to this worktree.
 * Shown for every resource type — unlike custom NAME, which only Slack
 * threads need because they have no title of their own.
 */
function CustomDescription({ r }: { r: ResourceDTO }) {
  if (!r.custom_description) return null
  return (
    // Deliberately the largest text on the card, and not dimmed. Everything
    // else here is fetched metadata; this is the one line a person wrote
    // about why this resource matters to this worktree, so it should win the
    // reader's eye rather than hide under the status badges. Italic still
    // marks it as the user's own words.
    <Text size="md" fs="italic" style={{ overflowWrap: "anywhere" }}>
      {r.custom_description}
    </Text>
  )
}

/**
 * How prominently a card renders its resource title.
 *
 * The detail card is the header of the pane you are reading, so its title is
 * the page's subject and gets full weight. A list card is one of many
 * competing for a click, where an oversized title would crowd out the status
 * badges you scan the list by.
 */
/**
 * Whether a card of this variant shows unread styling at all.
 *
 * The detail card heads the very timeline that lists its unread events, and
 * that feed boxes each one. Repeating the state as a border, a dot and a badge
 * three inches above it says nothing the reader cannot already see, and buries
 * the "Mark N as read" button in decoration. The LIST card still shows it —
 * there, the events are somewhere else.
 */
function showsUnread(variant: ResourceCardVariant): boolean {
  return variant !== "detail"
}

function titleProps(variant: ResourceCardVariant): { size: string; fw: number } {
  return variant === "detail" ? { size: "xl", fw: 700 } : { size: "sm", fw: 600 }
}

/**
 * The card for a resource the poller has not fetched yet: just its id. Its
 * type line shows a spinner where the status icon will go — the placeholder
 * glyph that replaced read as a state of its own rather than "not loaded yet".
 */
function MinimalRow({ r, variant }: { r: ResourceDTO; variant: ResourceCardVariant }) {
  return (
    <Stack gap={4}>
      <ResourceTypeLine r={r} />
      <ResourceTitle r={r} label={r.id} fw={400} showUnread={showsUnread(variant)} icon={null} />
    </Stack>
  )
}

function PRCardBody({ r, variant }: { r: ResourceDTO; variant: ResourceCardVariant }) {
  return (
    <Stack gap={4}>
      <ResourceTypeLine r={r} />
      <ResourceTitle r={r} label={r.title || r.id} showUnread={showsUnread(variant)} icon={null} {...titleProps(variant)} />
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
      <ResourceTypeLine r={r} />
      <ResourceTitle r={r} label={r.title || r.id} showUnread={showsUnread(variant)} icon={null} {...titleProps(variant)} />
      <CustomDescription r={r} />
      <Group gap={4} wrap="wrap">
        {r.status && <Badge size="xs" variant="light">{r.status}</Badge>}
        {r.priority && <Badge size="xs" variant="light" color="orange">{r.priority}</Badge>}
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

function SlackCardBody({ r, variant }: { r: ResourceDTO; variant: ResourceCardVariant }) {
  const label = r.custom_name || r.title || r.id
  return (
    <Stack gap={4}>
      <ResourceTypeLine r={r} />
      {/* Custom name or fetched title alike — same prominence either way. */}
      <ResourceTitle r={r} label={label} showUnread={showsUnread(variant)} icon={null} {...titleProps(variant)} />
      <CustomDescription r={r} />
      <Group gap="xs" wrap="wrap">
        {r.author && <Text size="xs" c="dimmed">by {r.author}</Text>}
        {r.created_ts && <Text size="xs" c="dimmed">started {relativeFromNow(r.created_ts)}</Text>}
        {r.updated_ts && <Text size="xs" c="dimmed">· active {relativeFromNow(r.updated_ts)}</Text>}
      </Group>
    </Stack>
  )
}

function LinkCardBody({ r, variant }: { r: ResourceDTO; variant: ResourceCardVariant }) {
  const label = r.custom_name || r.title || r.id
  return (
    <Stack gap={2}>
      <ResourceTypeLine r={r} />
      <ResourceTitle r={r} label={label} showUnread={false} icon={null} {...titleProps(variant)} />
      <CustomDescription r={r} />
      {variant === "detail" && r.description && (
        <Text size="xs" c="dimmed" lineClamp={3}>{r.description}</Text>
      )}
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
 * Only some types have a custom NAME (see supportsCustomName) — a PR or Jira
 * issue takes its title from the source and only the description is ours to
 * set — so the label names just the fields that resource actually has.
 */
export function editDetailsLabel(r: ResourceDTO): string {
  const canCustomName = supportsCustomName(r.type)
  const fields = canCustomName ? "custom name/description" : "custom description"
  const has = canCustomName
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
          aria-label="Unfollow resource"
          onClick={(e) => {
            e.stopPropagation()
            setOpened((v) => !v)
          }}
        >
          <IconTrash size={14} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={6}>
          <Text size="sm">Unfollow this resource?</Text>
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
              Unfollow
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}

export type ResourceCardVariant = "compact" | "detail"

/**
 * What a card needs to know about notifications beyond the resource itself:
 * whether its worktree notifies on everything, and how the server delivers.
 * Absent means the caller doesn't show notification UI at all.
 */
export interface ResourceNotifyContext {
  all: boolean
  mode: NotifyMode | undefined
}

function ResourceNotifySwitch({ r, path, notify }: { r: ResourceDTO; path: string; notify: ResourceNotifyContext }) {
  const qc = useQueryClient()
  return (
    <NotifySwitch
      // A thread's events are its replies, and "messages" is what Slack calls them.
      label={r.type === "slack" ? "Notify on new messages" : "Notify on new events"}
      checked={notify.all || Boolean(r.notify)}
      mode={notify.mode}
      disabledReason={notify.all ? "Notifications are enabled for all resources in the worktree" : undefined}
      onToggle={async (on) => {
        await api.setNotify({ path, type: r.type, id: r.id, on, tab: TAB_ID })
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["resources"] }),
          qc.invalidateQueries({ queryKey: ["worktrees"] }),
        ])
      }}
    />
  )
}

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
  /**
   * Rendered at the card's leading edge, beside — never inside — the select
   * button. The card stays unaware of the drag library: the handle arrives
   * already wired, so ResourceCard only has to make room for it.
   */
  dragHandle?: React.ReactNode
  /** Notification state; when absent, no notification switch or bell renders. */
  notify?: ResourceNotifyContext
}

export function ResourceCard({
  r,
  path = "",
  onRemoved = () => {},
  variant = "compact",
  selected = false,
  onSelect,
  onMetaChanged = () => {},
  dragHandle,
  notify,
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
  // Slack and links never take the not-yet-fetched path: a thread's card is
  // useful from its id alone, and a link is resolved once when added and
  // never polled, so a spinner on it would never stop.
  const body = r.type === "slack" ? (
    <SlackCardBody r={r} variant={variant} />
  ) : r.type === "link" ? (
    <LinkCardBody r={r} variant={variant} />
  ) : awaitsFetch(r) ? (
    <MinimalRow r={r} variant={variant} />
  ) : r.type === "pr" ? (
    <PRCardBody r={r} variant={variant} />
  ) : r.type === "jira" ? (
    <JiraCardBody r={r} variant={variant} />
  ) : (
    <MinimalRow r={r} variant={variant} />
  )

  // Links are never polled, so they never notify, whatever the toggles say.
  const bell =
    !notify || r.type === "link" ? null
    : notify.all ? <NotifyBell kind="implicit" />
    : r.notify ? <NotifyBell kind="explicit" />
    : null

  // The badge lives INSIDE the click target, not beside it. As a sibling of
  // the button it carved a fixed-width strip out of the card that no click
  // could reach — harmless at full width, but a quarter of the card once
  // selecting something narrows the list column, which is exactly when you
  // most want to click another card.
  const bodyWithBadge = (
    <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
      <div style={{ flex: 1, minWidth: 0 }}>{body}</div>
      <Group gap={6} wrap="nowrap" style={{ flex: "none" }}>
        {/* The detail card carries the switch instead of a bell. */}
        {variant !== "detail" && bell}
        <UnreadBadge unread={showsUnread(variant) && hasUnread(r)} count={r.unread_count} />
      </Group>
    </Group>
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
      // Violet, not blue: blue is spoken for by unread, and a selected read
      // card sitting beside an unread one has to be tellable apart at a glance.
      bg={selected ? "var(--mantine-color-violet-light)" : undefined}
      // One total function over both states rather than two conditional
      // spreads — see cardEdgeStyle for the two bugs the spreads caused.
      style={cardEdgeStyle(showsUnread(variant) && hasUnread(r), selected)}
    >
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        {dragHandle}
        {onSelect ? (
          <UnstyledButton
            onClick={onSelect}
            aria-pressed={selected}
            aria-label={`select resource ${r.id}`}
            style={{ flex: 1, minWidth: 0, textAlign: "left" }}
          >
            {bodyWithBadge}
          </UnstyledButton>
        ) : (
          <div style={{ flex: 1, minWidth: 0 }}>{bodyWithBadge}</div>
        )}
        {/*
          Only the detail card carries the remove control. List cards are
          clickable-to-select, so a per-card x there is visual noise and an
          easy mis-click; removal belongs with the selected resource.
        */}
        {variant === "detail" && (
          <Group gap="sm" wrap="nowrap" align="flex-start">
            {/* Links are never polled, so there is nothing to notify about. */}
            {notify && path && r.type !== "link" && <ResourceNotifySwitch r={r} path={path} notify={notify} />}
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
