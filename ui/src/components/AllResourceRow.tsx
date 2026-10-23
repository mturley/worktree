import { Box, Button, Group, Text, Tooltip, UnstyledButton } from "@mantine/core"
import { IconGitBranch } from "@tabler/icons-react"
import { useState } from "react"
import { useLocation } from "wouter"
import { useResourceCmuxTab } from "../api/cmux"
import type { AllResourceDTO, ResourceWorktree } from "../api/types"
import { serializeResourceKey } from "../lib/resourceKey"
import { READ_BOX_BORDER, UNREAD_BG, UNREAD_BOX_BORDER, hasUnread } from "../lib/unread"
import { CopyLinkIcon } from "./CopyLinkIcon"
import { ResourceCardBody } from "./ResourceCard"
import { ExistingTabButtons, openLabel } from "./ResourceActions"
import { useCopyLink } from "./resourceActionHooks"
import { UnreadBadge } from "./UnreadBadge"
import { BlocksBadge, TaskCountBadge, openTasksLabel } from "./tasks/TaskCountBadge"
import { matchResource } from "../lib/search"
import { MatchWhy } from "./search/MatchWhy"
import { useSearchContext } from "./search/SearchContext"
import { ChooseWorktreeModal } from "./ChooseWorktreeModal"
import { useCrossHover } from "./CrossHoverContext"

const btn = { root: { flexShrink: 0 }, label: { whiteSpace: "nowrap" as const } }

function worktreeHref(wt: ResourceWorktree, r: AllResourceDTO): string {
  return `/worktree/${encodeURIComponent(wt.path)}?resource=${serializeResourceKey({ type: r.type, id: r.id })}`
}

/** Branch names, which is how the worktree cards are titled. */
function WorktreesLine({ worktrees }: { worktrees: ResourceWorktree[] }) {
  return (
    <Group gap={4} wrap="nowrap" mt={2} style={{ minWidth: 0 }}>
      <IconGitBranch size={12} aria-hidden style={{ flexShrink: 0, color: "var(--mantine-color-dimmed)" }} />
      <Text size="xs" c="dimmed" truncate="end" style={{ minWidth: 0 }}>
        {worktrees.map((w) => w.branch || w.path).join(", ")}
      </Text>
    </Group>
  )
}

/**
 * Open / Copy link, as the Linked Resources rows have them. There is no
 * Details button: the row itself is the way to the resource's worktree.
 */
export function AllResourceActions({ r }: { r: AllResourceDTO }) {
  const existing = useResourceCmuxTab(r.worktrees[0]?.path, r.type, r.url)
  const { copied, copy } = useCopyLink(r.url)
  const label = openLabel(r.type)

  return (
    <Button.Group className="compound-group" style={{ flexShrink: 0 }}>
      {r.url && (existing ? (
        <ExistingTabButtons url={r.url} label={label} switchLabel={`${label} (switch)`} existing={existing} />
      ) : (
        <Button size="xs" variant="subtle" component="a" href={r.url} target="_blank" rel="noreferrer" styles={btn}>
          {label}
        </Button>
      ))}
      {r.url && (
        <Tooltip label={copied ? "Copied!" : "Copy link"}>
          <Button size="xs" variant="subtle" px="xs" aria-label="Copy link" onClick={() => void copy()} styles={{ root: { flexShrink: 0 } }}>
            <CopyLinkIcon />
          </Button>
        </Tooltip>
      )}
    </Button.Group>
  )
}

/**
 * One resource on the home page's Resources tab: the list card's contents
 * (type line with status, title, metadata) plus the worktrees following it,
 * with the actions beside it as on a Linked Resources row. Wraps the actions
 * below on a narrow viewport rather than crushing the text.
 *
 * The whole row opens the resource in its worktree, as an Activity event
 * row does — or, when several worktrees follow it, asks which. The open and
 * copy buttons keep their own clicks. The row can't be one button the way an
 * event row is (it holds those buttons), so the content is the button, for
 * the keyboard, and the row catches clicks in its padding too.
 *
 * Unread rows are boxed and washed blue as timeline events are — a row in a
 * list rather than a card, so the event treatment, not the card's edge. Every
 * row carries the same-width border so the text never shifts on mark-read.
 */
export function AllResourceRow({ r }: { r: AllResourceDTO }) {
  const [, navigate] = useLocation()
  const [choosing, setChoosing] = useState(false)
  const unread = hasUnread(r)
  const openTasks = r.open_task_count ?? 0
  const blocks = r.blocks_count ?? 0
  const { terms } = useSearchContext()
  const crossHover = useCrossHover({ kind: "resource", type: r.type, id: r.id, paths: r.worktrees.map((w) => w.path) })

  const go = (w: ResourceWorktree) => navigate(worktreeHref(w, r))
  const activate = () => {
    if (r.worktrees.length > 1) setChoosing(true)
    else if (r.worktrees[0]) go(r.worktrees[0])
  }

  return (
    <>
      <Group
        // The Linked Resources rows' faint divider, between read rows only:
        // an unread row's box already sets it apart.
        className={unread ? undefined : "linked-item"}
        data-testid="all-resource-row"
        data-resource-row="true"
        data-unread={unread || undefined}
        {...crossHover}
        onClick={activate}
        justify="space-between"
        gap="xs"
        wrap="wrap"
        align="center"
        px="xs"
        // More room above the content than below it: the divider sits on the
        // row's top edge, and the text read as crowded against it. An unread
        // row has no divider, so its box gets even padding instead.
        pt={unread ? 8 : 12}
        pb={unread ? 8 : 6}
        style={{
          border: unread ? UNREAD_BOX_BORDER : READ_BOX_BORDER,
          background: unread ? UNREAD_BG : undefined,
          borderRadius: "var(--mantine-radius-sm)",
        }}
      >
        {/* No onClick of its own: its click (or Enter) bubbles to the row's. */}
        <UnstyledButton
          aria-label={`view ${r.custom_name || r.title || r.id}`}
          style={{ flex: "1 1 260px", minWidth: 0, textAlign: "left", cursor: "inherit" }}
        >
          <ResourceCardBody
            r={r}
            aside={unread || openTasks > 0 || blocks > 0 ? (
              <>
                {unread && <UnreadBadge unread count={r.unread_count} />}
                <TaskCountBadge count={openTasks} title={openTasksLabel(openTasks)} />
                <BlocksBadge count={blocks} />
              </>
            ) : undefined}
          />
          <WorktreesLine worktrees={r.worktrees} />
          <MatchWhy match={terms.length ? matchResource(r, terms) : null} />
        </UnstyledButton>
        {/* Stops at the actions, so opening or copying never also navigates.
            React bubbles through portals by component, not DOM, so this
            also covers the switch button's menu. */}
        <Box onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
          <AllResourceActions r={r} />
        </Box>
      </Group>
      {/* Outside the row, which would otherwise take every click in it. */}
      <ChooseWorktreeModal
        r={choosing ? r : null}
        worktrees={r.worktrees}
        onPick={(path) => {
          setChoosing(false)
          const w = r.worktrees.find((x) => x.path === path)
          if (w) go(w)
        }}
        onClose={() => setChoosing(false)}
      />
    </>
  )
}
