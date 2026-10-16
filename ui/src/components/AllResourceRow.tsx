import { Box, Button, Group, Menu, Text, Tooltip } from "@mantine/core"
import { IconChevronDown, IconGitBranch } from "@tabler/icons-react"
import { useLocation } from "wouter"
import { useResourceCmuxTab } from "../api/cmux"
import type { AllResourceDTO, ResourceWorktree } from "../api/types"
import { serializeResourceKey } from "../lib/resourceKey"
import { READ_BOX_BORDER, UNREAD_BG, UNREAD_BOX_BORDER, hasUnread } from "../lib/unread"
import { CopyLinkIcon } from "./CopyLinkIcon"
import { ResourceCardBody } from "./ResourceCard"
import { ExistingTabButtons, openLabel as openTooltip, serviceName } from "./ResourceActions"
import { useCopyLink } from "./resourceActionHooks"
import { UnreadBadge } from "./UnreadBadge"
import { matchResource } from "../lib/search"
import { MatchWhy } from "./search/MatchWhy"
import { useSearchContext } from "./search/SearchContext"

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
 * Details / open / Copy link, as the Linked Resources rows have them, but
 * with Details going to the FIRST worktree that follows the resource — this
 * list spans all of them. When more than one follows it, a chevron offers
 * the others.
 */
export function AllResourceActions({ r }: { r: AllResourceDTO }) {
  const [, navigate] = useLocation()
  const first = r.worktrees[0]
  const existing = useResourceCmuxTab(first?.path, r.type, r.url)
  const { copied, copy } = useCopyLink(r.url)
  const openLabel = serviceName(r.type) || "Open"

  return (
    <Button.Group className="compound-group" style={{ flexShrink: 0 }}>
      {first && (
        <Tooltip label={`View in ${first.branch || first.path}`}>
          <Button size="xs" variant="light" styles={btn} onClick={() => navigate(worktreeHref(first, r))}>
            Details
          </Button>
        </Tooltip>
      )}
      {r.worktrees.length > 1 && (
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <Button size="xs" variant="light" px={6} aria-label="Other worktrees" styles={{ root: { flexShrink: 0 } }}>
              <IconChevronDown size={14} />
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>View in worktree</Menu.Label>
            {r.worktrees.map((w) => (
              <Menu.Item key={w.path} onClick={() => navigate(worktreeHref(w, r))}>
                {w.branch || w.path}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      )}
      {r.url && (existing ? (
        <ExistingTabButtons url={r.url} label={openLabel} switchLabel={`${openLabel} (switch)`} existing={existing} />
      ) : (
        <Tooltip label={openTooltip(r.type)}>
          <Button size="xs" variant="subtle" component="a" href={r.url} target="_blank" rel="noreferrer" styles={btn}>
            {openLabel}
          </Button>
        </Tooltip>
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
 * Unread rows are boxed and washed blue as timeline events are — a row in a
 * list rather than a card, so the event treatment, not the card's edge. Every
 * row carries the same-width border so the text never shifts on mark-read.
 */
export function AllResourceRow({ r }: { r: AllResourceDTO }) {
  const unread = hasUnread(r)
  const { terms } = useSearchContext()
  return (
    <Group
      // The Linked Resources rows' faint divider, between read rows only:
      // an unread row's box already sets it apart.
      className={unread ? undefined : "linked-item"}
      data-testid="all-resource-row"
      data-unread={unread || undefined}
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
      <Box style={{ flex: "1 1 260px", minWidth: 0 }}>
        <ResourceCardBody r={r} aside={unread ? <UnreadBadge unread count={r.unread_count} /> : undefined} />
        <WorktreesLine worktrees={r.worktrees} />
        <MatchWhy match={terms.length ? matchResource(r, terms) : null} />
      </Box>
      <AllResourceActions r={r} />
    </Group>
  )
}
