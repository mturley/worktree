import { Badge, Box, Group, Paper, Stack, Text } from "@mantine/core"
import { useLocation } from "wouter"
import { useCmuxMatches } from "../api/cmux"
import type { ResourceDTO, WorktreeSummary } from "../api/types"
import { relatedSummary } from "../lib/resourceSummary"
import { CmuxWorkspaceSection } from "./CmuxWorkspaceSection"
import { UnreadDot } from "./ResourceStatusIcon"
import { ResourceTypeLine } from "./ResourceTypeLine"
import { cardEdgeStyle } from "../lib/unread"
import { UnreadBadge } from "./UnreadBadge"
import { NotifyBell } from "./NotifyBell"
import { useNotificationsEnabled } from "../hooks/useNotifyMode"
import { NotesMarkdown } from "./NotesMarkdown"
import { VISIBLE_FIELDS, matchWorktree } from "../lib/search"
import { worktreeName } from "../lib/homeWorktree"
import { MatchWhy } from "./search/MatchWhy"
import { SearchHighlight } from "./search/SearchHighlight"
import { useSearchContext } from "./search/SearchContext"
import { useCrossHover } from "./CrossHoverContext"

interface WorktreeCardProps {
  w: WorktreeSummary
  /**
   * When true (default) the card navigates to the worktree detail page.
   * The detail page renders the same card with clickable={false}, since we
   * are already there.
   */
  clickable?: boolean
}

/**
 * A focus resource, as plain content — deliberately NOT a link.
 *
 * These used to deep-link into the worktree with the resource preselected.
 * That made the card a minefield of small targets: the useful action is
 * "open this worktree", and picking a resource is one easy click away once
 * you are there. Now the whole card is one target and these just describe it.
 */
// The type line's brand icon and the gap after it. The lines beneath it are
// indented by both, to start where the type badge does.
const TYPE_LINE_ICON_SIZE = 14
const TYPE_LINE_ICON_GAP = 6
const TYPE_LINE_INDENT = TYPE_LINE_ICON_SIZE + TYPE_LINE_ICON_GAP

function FocusResourceLine({ r, notifyAll }: { r: ResourceDTO; notifyAll: boolean }) {
  const label = r.custom_name || r.title || r.id
  return (
    <Stack gap={2}>
      {/* The same first line as the worktree page's resource cards — brand
          icon, type badge, then this resource's icon and key — so a resource
          is introduced the same way on both pages. */}
      <ResourceTypeLine
        r={r}
        // With "Notify on all" on, the worktree's own bell says it once.
        trailing={!notifyAll && r.notify && r.type !== "link" ? <NotifyBell kind="explicit" /> : undefined}
      />
      {/* The unread dot sits in the gutter under the brand icon, so the title
          lines up with the type badge whether or not the dot is shown. */}
      <Group gap={TYPE_LINE_ICON_GAP} wrap="nowrap" align="center">
        <Box w={TYPE_LINE_ICON_SIZE} style={{ display: "flex", justifyContent: "center", flexShrink: 0 }}>
          <UnreadDot r={r} />
        </Box>
        <Text size="sm" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}><SearchHighlight text={label} /></Text>
      </Group>
    </Stack>
  )
}

export function WorktreeCard({ w, clickable = true }: WorktreeCardProps) {
  const [, navigate] = useLocation()
  const href = `/worktree/${encodeURIComponent(w.path)}`
  const name = worktreeName(w.path)
  const related = relatedSummary(w.related_by_type)
  // Settings' "Enable notifications" off hides the bell (the toggle is kept).
  const notificationsEnabled = useNotificationsEnabled()
  const allBell = Boolean(w.notify_all) && notificationsEnabled

  // Inside cmux, a matched workspace name is the card's headline, so the
  // worktree title steps down to a subtitle. Same shared query the section
  // itself reads — no extra request.
  const workspaces = useCmuxMatches(w.path)
  const hasWorkspace = workspaces.length > 0

  const { terms, resourcesByPath } = useSearchContext()
  const match = terms.length
    ? matchWorktree(
        w,
        workspaces.map((m) => m.title),
        resourcesByPath?.get(w.path) ?? w.focus_resources,
        terms,
      )
    : null
  // A via hit on a focus resource whose visible field (title, name, key)
  // holds the term is already shown, highlighted, on its focus line below.
  const suppressVia = Boolean(
    match?.field === "resource" && match.viaField && VISIBLE_FIELDS.has(match.viaField) &&
      w.focus_resources.some((r) => r.type === match.viaType && r.id === match.viaId),
  )

  // The anchor is the inner Box, not the Paper, because the cmux section
  // sits above it and must not be nested interactive content inside an <a>.
  const link = clickable
    ? {
        component: "a" as const,
        href,
        "aria-label": `open worktree ${name}`,
        "data-card-link": "true",
        onClick: (e: React.MouseEvent) => {
          // Let modified clicks (new tab, download) behave natively.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
          e.preventDefault()
          navigate(href)
        },
        style: { display: "block", textDecoration: "none", color: "inherit" },
      }
    : {}

  // The lighter background and hover belong to the WHOLE card, including the
  // cmux strip — the card is one surface, and lighting only its lower half
  // reads as a rendering bug. So the affordance flag lives on the Paper while
  // the anchor lives inside it; cards.css carries the matching focus rule for
  // the nested link.
  const affordance = clickable ? { "data-interactive": "true" } : {}
  // Lit while you hover an event or resource this worktree follows, and
  // lights them while you hover the card. Clickable cards only: the inert
  // copy in the detail-page header is not a destination.
  const crossHover = useCrossHover(clickable ? { kind: "worktree", path: w.path } : null)

  return (
    <Paper
      p="sm"
      withBorder
      {...affordance}
      {...crossHover}
      // Whole-card cue, from the backend's aggregate rather than the focus
      // lines: related resources are counted but never listed, so reading
      // focus_resources here would leave their unreads invisible.
      style={cardEdgeStyle(!!w.has_unread)}
    >
      <CmuxWorkspaceSection path={w.path} branch={w.branch} />
      <Box {...link}>
        <Stack gap={6}>
          <Group gap="xs" wrap="wrap">
            {/* Marks the worktree's own name, so it stays identifiable once
                the cmux workspace takes over as the card's headline. */}
            <Badge size="xs" color="blue" variant="light" style={{ flex: "none" }}>WORKTREE</Badge>
            <Text
              fw={hasWorkspace ? 600 : 700}
              size={hasWorkspace ? "sm" : "md"}
              c={hasWorkspace ? "dimmed" : undefined}
              style={{ overflowWrap: "anywhere" }}
            >
              <SearchHighlight text={name} />
            </Text>
            {!w.on_disk && <Badge size="xs" color="red">missing</Badge>}
            {/* Pushed to the right of the title row rather than the card's
                corner: the cmux strip owns the top edge, and a badge floating
                over it reads as belonging to the workspace, not the worktree. */}
            {allBell && (
              <Box ml="auto" style={{ display: "inline-flex" }}>
                <NotifyBell kind="implicit" tooltip="Notifications are on for all resources in this worktree" />
              </Box>
            )}
            <UnreadBadge unread={!!w.has_unread} count={w.unread_count} ml={allBell ? undefined : "auto"} />
          </Group>
          {/*
            Identity only: which repo, which branch. The counts that used to
            sit here ("1 PR, 1 issue") restated the resource list immediately
            below, and a worktree-level timestamp is not worth a line on a card
            that no longer shows per-resource ones either.
          */}
          <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
            <SearchHighlight text={[w.repo, w.branch].filter(Boolean).join(" · ")} />
          </Text>
          <MatchWhy match={suppressVia ? null : match} />
          {w.notes && (
            // Present only when the worktree opted in on its Notes tab. Read
            // only here: links render as text and task checkboxes are inert,
            // since the whole card is one link to the worktree.
            <Box>
              <Text size="xs" fw={600} c="dimmed">Notes:</Text>
              <NotesMarkdown text={w.notes} plainLinks />
            </Box>
          )}
          {w.focus_resources.length > 0 && (
            // Set apart from the identity/notes lines above it.
            <Stack gap="sm" mt="xs">
              {w.focus_resources.map((r) => (
                <FocusResourceLine key={`${r.type}:${r.id}`} r={r} notifyAll={Boolean(w.notify_all)} />
              ))}
            </Stack>
          )}
          {related && (
            // Related resources are not listed individually — they are the
            // ones you did not mark as the point of this worktree — so this
            // line is the only place their shape shows. Named by type, since
            // "2 related Slack threads" tells you where to look and a bare
            // total does not. Indented like the resource lines above, so it
            // reads as the tail of that list rather than a new fact.
            <Text size="xs" c="dimmed" pl={TYPE_LINE_INDENT}>
              {`+ ${related}`}
            </Text>
          )}
        </Stack>
      </Box>
    </Paper>
  )
}
