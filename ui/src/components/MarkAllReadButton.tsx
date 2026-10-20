import { type ComponentProps, useState } from "react"
import { Alert, Box, Button, Checkbox, Flex, Group, Modal, ScrollArea, Stack, Text } from "@mantine/core"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ResourceDTO } from "../api/types"
import { api } from "../api/client"
import { markRead as markThreadRead } from "../api/slackApi"
import { useGlobalTimeline, useWorktreeTimeline } from "../hooks/useTimeline"
import { useIsWide } from "../hooks/useIsWide"
import { useButtonHotkey } from "../hooks/useButtonHotkey"
import { KeyHint } from "./search/KeyHint"
import { slackTabFromResource } from "./SlackThreadPane"
import { TimelineFeed } from "./TimelineFeed"

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** How each resource type is named in the modal, in display order. */
const KINDS = [
  { type: "pr", source: "GitHub", item: ["event", "events"], container: ["PR", "PRs"] },
  { type: "jira", source: "Jira", item: ["event", "events"], container: ["issue", "issues"] },
  { type: "slack", source: "Slack", item: ["message", "messages"], container: ["thread", "threads"] },
] as const

type Kind = (typeof KINDS)[number]["type"]

/** One resource to mark read, and the write that does it. */
interface Target {
  count: number
  mark: () => Promise<unknown>
}

/**
 * The resource as a mark-read target, or null when it has nothing unread or
 * lacks the timestamp to mark it through.
 *
 * Everything is marked through what the user was SHOWN, never "now":
 *   - GitHub/Jira through unread_through_ts — the newest of the events its
 *     unread_count counted, from the same server snapshot.
 *   - Slack through its cached updated_ts — the latest message as of the
 *     poll that flagged it unread. Slack owns the cursor, so this writes to
 *     Slack itself; the server re-polls the thread before answering.
 * Anything newer stays unread, as the per-resource button keeps events that
 * arrive after render. A resource missing its timestamp (an older server, a
 * thread never fully polled) is skipped rather than guessed at.
 */
function toTarget(r: ResourceDTO): Target | null {
  const count = r.unread_count ?? 0
  if (r.type === "slack") {
    const { channel, threadTs } = slackTabFromResource(r)
    if (!r.has_unread || !r.updated_ts || !threadTs) return null
    const latest = r.updated_ts
    // unread_count is at least 1 while has_unread (the server guarantees it);
    // the floor only guards an older cached response that predates it.
    return { count: Math.max(count, 1), mark: () => markThreadRead(channel, threadTs, latest) }
  }
  if (count <= 0 || !r.unread_through_ts) return null
  const through = r.unread_through_ts
  return { count, mark: () => api.markResourceRead({ type: r.type, id: r.id, through_ts: through }) }
}

/**
 * Where the preview column's events come from, and how its rows look. A
 * `worktree` previews that worktree's own feed; without one, the global feed
 * (never archived: the button marks only resources a worktree follows). The
 * rest is passed through to the TimelineFeed, as the page's own feed sets it.
 *
 * There is deliberately no onSelectResource: a row clicked here opens its
 * details over the modal, leaving the modal open beneath, rather than
 * navigating away from the decision the modal is asking for.
 */
export type MarkAllReadFeed = { worktree?: string } & Pick<
  ComponentProps<typeof TimelineFeed>,
  "showWorktrees" | "resolveResource" | "path" | "showResource"
>

type PreviewProps = { types: string[]; feed: MarkAllReadFeed }

/** One resource's unread events, from its worktree's feed. */
function ResourcePreview(props: { worktree: string; resource: ResourceDTO; feed: MarkAllReadFeed }) {
  const { type, id } = props.resource
  return <PreviewFeed types={[]} feed={props.feed} tl={useWorktreeTimeline(props.worktree, { type, id }, [], true)} />
}

/** The global feed's unread events of `types`. */
function GlobalPreview(props: PreviewProps) {
  return <PreviewFeed {...props} tl={useGlobalTimeline(false, props.types, true)} />
}

/** One worktree's unread events of `types`. */
function WorktreePreview(props: PreviewProps & { worktree: string }) {
  return <PreviewFeed {...props} tl={useWorktreeTimeline(props.worktree, undefined, props.types, true)} />
}

function PreviewFeed({ tl, feed }: PreviewProps & {
  tl: ReturnType<typeof useGlobalTimeline>
}) {
  const { worktree: _, ...rest } = feed
  return (
    <TimelineFeed
      {...rest}
      events={tl.events}
      loading={tl.isLoading}
      error={tl.error}
      hasMore={tl.hasMore}
      onLoadMore={tl.loadMore}
      loadingMore={tl.loadingMore}
      emptyText="No unread activity."
    />
  )
}

/**
 * Clears unread activity across a worktree's resources, one checkbox per
 * resource type that has any — "Mark 3 GitHub events in 2 PRs as read" —
 * all checked by default. Only the checked types are marked.
 *
 * Unchecked types are remembered as EXCLUSIONS, not checked ones as
 * inclusions, so a type that gains unreads while the modal is open (a poll
 * landed) arrives checked like the rest. Reopening starts fully checked.
 *
 * The counts are read live from `resources`, so a poll landing while the
 * modal is open updates the numbers and what gets sent together.
 *
 * `single` is the one-resource form, for a selected resource's own feed:
 * `resources` holds just that resource and `feed.worktree` its worktree.
 * There is only one thing to mark, so no checkboxes — the modal is the
 * preview of its unread events alone.
 */
export function MarkAllReadButton({ resources, feed, single = false }: {
  resources: ResourceDTO[]
  feed: MarkAllReadFeed
  single?: boolean
}) {
  const [opened, setOpened] = useState(false)
  const wide = useIsWide()
  const [unchecked, setUnchecked] = useState<ReadonlySet<Kind>>(new Set())
  const qc = useQueryClient()

  const groups = KINDS.map((kind) => {
    const targets = resources
      .filter((r) => r.type === kind.type)
      .map(toTarget)
      .filter((t): t is Target => t !== null)
    return { kind, targets, count: targets.reduce((n, t) => n + t.count, 0) }
  }).filter((g) => g.targets.length > 0)
  const selected = groups.filter((g) => !unchecked.has(g.kind.type))
  const selectedTypes = selected.map((g) => g.kind.type)

  const markAll = useMutation({
    // Parallel and independent: each call only moves one cursor forward, so a
    // partial failure leaves nothing inconsistent and a retry is safe.
    mutationFn: () => Promise.all(selected.flatMap((g) => g.targets.map((t) => t.mark()))),
    onSuccess: () => setOpened(false),
    // Settled, not success: a partial failure still moved some cursors, and
    // the surfaces showing them must catch up either way: the home cards'
    // focus lines, the worktrees' resource lists, and every timeline's dots
    // and divider.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["worktrees"] })
      void qc.invalidateQueries({ queryKey: ["resources"] })
      void qc.invalidateQueries({ queryKey: ["timeline"] })
    },
  })

  // R opens the preview, and R again in it confirms (see useButtonHotkey).
  const openRef = useButtonHotkey("r", () => openModal(), groups.length > 0 && !opened)
  const confirmRef = useButtonHotkey("r", () => markAll.mutate(), opened && selected.length > 0 && !markAll.isPending)

  if (groups.length === 0 && !opened) return null

  const openModal = () => {
    setUnchecked(new Set())
    markAll.reset()
    setOpened(true)
  }

  const singleResource = single && feed.worktree ? resources[0] : undefined
  const singleGroup = singleResource ? groups[0] : undefined

  const toggle = (type: Kind, checked: boolean) =>
    setUnchecked((prev) => {
      const next = new Set(prev)
      if (checked) next.delete(type)
      else next.add(type)
      return next
    })

  return (
    <>
      {groups.length > 0 && (
        <Button
          size="compact-sm"
          // Filled blue, not the theme's primary: primaryColor is "accent"
          // (purple), and this button clears the very blue the unread boxes
          // and bars are drawn in. Same treatment as UnreadBadge, so every
          // unread affordance reads as one colour.
          variant="filled"
          color="blue"
          // `vars`, not `styles`: Mantine sets --button-hover itself from the
          // color prop, and a styles.root value loses to it. Lighter rather
          // than Mantine's darker default — on a dark background, darkening
          // reads as the button dimming rather than responding.
          vars={() => ({ root: { "--button-hover": "var(--mantine-color-blue-4)" } })}
          onClick={openModal}
          ref={openRef}
          rightSection={<KeyHint decorative>R</KeyHint>}
        >
          Mark all read
        </Button>
      )}
      <Modal opened={opened} onClose={() => setOpened(false)} title="Mark all read" centered size={singleResource ? "lg" : "xl"}>
        <Stack gap="sm">
          {singleResource && feed.worktree ? (
            <Box>
              <Text size="sm" c="dimmed" mb="xs">
                {singleGroup
                  ? `The following ${plural(singleGroup.count, singleGroup.kind.item[0], singleGroup.kind.item[1])} will be marked as read`
                  : "The following activity will be marked as read"}
              </Text>
              <ScrollArea.Autosize mah={wide ? "55vh" : "35vh"} type="auto" offsetScrollbars>
                <ResourcePreview worktree={feed.worktree} resource={singleResource} feed={feed} />
              </ScrollArea.Autosize>
            </Box>
          ) : (
            // Side by side when wide; on a phone the preview stacks below.
            <Flex direction={wide ? "row" : "column"} gap="md">
              <Stack gap="sm" style={wide ? { flex: "0 0 240px" } : undefined}>
                {groups.map(({ kind, targets, count }) => (
                  <Checkbox
                    key={kind.type}
                    checked={!unchecked.has(kind.type)}
                    onChange={(e) => toggle(kind.type, e.currentTarget.checked)}
                    label={`Mark ${plural(count, `${kind.source} ${kind.item[0]}`, `${kind.source} ${kind.item[1]}`)}`
                      + ` in ${plural(targets.length, kind.container[0], kind.container[1])} as read`}
                  />
                ))}
              </Stack>
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" c="dimmed" mb="xs">The following activity will be marked as read</Text>
                <ScrollArea.Autosize mah={wide ? "55vh" : "35vh"} type="auto" offsetScrollbars>
                  {/* Nothing checked lists nothing — and asks for nothing: an
                      empty resource_types means every type to the server. */}
                  {selectedTypes.length === 0 ? null : feed.worktree
                    ? <WorktreePreview worktree={feed.worktree} types={selectedTypes} feed={feed} />
                    : <GlobalPreview types={selectedTypes} feed={feed} />}
                </ScrollArea.Autosize>
              </Box>
            </Flex>
          )}
          {markAll.isError && (
            <Alert color="red">{String((markAll.error as Error)?.message || markAll.error)}</Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setOpened(false)}>Cancel</Button>
            <Button
              color="blue"
              loading={markAll.isPending}
              disabled={selected.length === 0}
              onClick={() => markAll.mutate()}
              ref={confirmRef}
              rightSection={<KeyHint decorative>R</KeyHint>}
            >
              Mark read
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  )
}
