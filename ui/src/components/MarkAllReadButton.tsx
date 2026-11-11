import { type ComponentProps, useState } from "react"
import { Alert, Box, Button, Checkbox, Flex, Group, Modal, ScrollArea, Stack, Text } from "@mantine/core"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ResourceDTO, TaskScope, TaskUnread, TimelineEvent } from "../api/types"
import { api } from "../api/client"
import { markRead as markThreadRead, restoreRead as restoreThreadRead } from "../api/slackApi"
import { useGlobalTimeline, useWorktreeTimeline } from "../hooks/useTimeline"
import { useTaskActivity } from "../hooks/useTaskDetail"
import { useIsWide } from "../hooks/useIsWide"
import { useButtonHotkey } from "../hooks/useButtonHotkey"
import { KeyHint } from "./search/KeyHint"
import { slackTabFromResource } from "./SlackThreadPane"
import { LoadMoreButton, TimelineFeed } from "./TimelineFeed"
import { ModalLayerProvider, useLayerTopmost, useModalLayer } from "./tasks/modal/modalLayer"
import { showUndoToast, undoAll } from "./UndoToast"
import { MARK_READ_BUTTON_PROPS, readChangeDidSomething } from "../lib/unread"

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** How each resource type is named in the modal, in display order. */
const KINDS = [
  { type: "pr", source: "GitHub", item: ["event", "events"], container: ["PR", "PRs"] },
  { type: "jira", source: "Jira", item: ["event", "events"], container: ["issue", "issues"] },
  { type: "slack", source: "Slack", item: ["message", "messages"], container: ["thread", "threads"] },
] as const

type Kind = (typeof KINDS)[number]["type"]

/** Takes one mark back. */
type Undo = () => Promise<unknown>

/**
 * One resource to mark read, and the write that does it. The write answers
 * with its undo, or null when it moved nothing (a cursor already past it).
 */
interface Target {
  /** The resource's key, "type:id", as its events name it. */
  key: string
  count: number
  /** How a failed undo names it: "#4521", "PROJ-1", "T12", a thread's name. */
  label: string
  mark: () => Promise<Undo | null>
}

/** A resource's short name, for an undo failure. */
function resourceLabel(r: ResourceDTO): string {
  if (r.type === "pr") return r.id.includes("#") ? `#${r.id.split("#").pop()}` : r.id
  if (r.type === "slack") return r.custom_name || r.title || "Slack thread"
  return r.id
}

const resourceKey = (type: string, id: string) => `${type}:${id}`

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
 *
 * Each undo restores the cursor the mark replaced: for GitHub/Jira the one the
 * server answers with, for Slack its cached last_read ("" when it has none,
 * which restores the whole thread unread — the only reading of a thread Slack
 * flags unread with no cursor).
 *
 * The count is the resource's OWN unread: unread_count also holds the unread
 * events of the tasks linking it (task_unread_count), and those are cleared
 * through each task's cursor (taskTarget), never the resource's. So a Slack
 * thread whose only unread is task activity (has_unread false) is no target
 * here — Slack is never told to mark it — and its tasks still are.
 */
function toTarget(r: ResourceDTO): Target | null {
  const count = (r.unread_count ?? 0) - (r.task_unread_count ?? 0)
  if (r.type === "slack") {
    const { channel, threadTs } = slackTabFromResource(r)
    if (!r.has_unread || !r.updated_ts || !threadTs) return null
    const latest = r.updated_ts
    const lastRead = r.last_read ?? ""
    // unread_count is at least 1 while has_unread (the server guarantees it);
    // the floor only guards an older cached response that predates it.
    return {
      key: resourceKey(r.type, r.id),
      count: Math.max(count, 1),
      label: resourceLabel(r),
      mark: async () => {
        await markThreadRead(channel, threadTs, latest)
        return () => restoreThreadRead(channel, threadTs, lastRead, latest)
      },
    }
  }
  if (count <= 0 || !r.unread_through_ts) return null
  const through = r.unread_through_ts
  const { type, id } = r
  return {
    key: resourceKey(type, id),
    count,
    label: resourceLabel(r),
    mark: async () => {
      const change = await api.markResourceRead({ type, id, through_ts: through })
      if (!readChangeDidSomething(change)) return null
      return () => api.restoreResourceRead({ type, id, ...change })
    },
  }
}

/**
 * An unread task as a mark-read target: marked through newest_ts, the newest
 * of the unread events GET /api/task-unread counted — what the modal showed,
 * so an agent event landing after it stays unread. Undone like a resource.
 */
function taskTarget(t: TaskUnread): Target {
  return {
    key: resourceKey("task", String(t.id)),
    count: t.count,
    label: `T${t.id}`,
    mark: async () => {
      const change = await api.taskRead({ id: t.id, through_ts: t.newest_ts })
      if (!readChangeDidSomething(change)) return null
      return () => api.taskReadRestore({ id: t.id, ...change })
    },
  }
}

/** The query key of a scope's unread tasks; under "tasks", so every task invalidation refreshes it. */
const taskUnreadKey = (scope: TaskScope) => ["tasks", "unread", scope] as const

/**
 * Where the preview column's events come from, and how its rows look. A
 * `task` previews that task's activity (its modal's Everything view); a
 * `worktree` previews that worktree's own feed; with neither, the global feed
 * (never archived: the button marks only resources a worktree follows). The
 * rest is passed through to the TimelineFeed, as the page's own feed sets it.
 *
 * There is deliberately no onSelectResource: a row clicked here opens its
 * details over the modal, leaving the modal open beneath, rather than
 * navigating away from the decision the modal is asking for.
 */
export type MarkAllReadFeed = { worktree?: string; task?: number } & Pick<
  ComponentProps<typeof TimelineFeed>,
  "showWorktrees" | "resolveResource" | "path" | "showResource"
>

/**
 * `hiddenTasks` are unchecked tasks: the server filters by type only, so
 * their events are dropped here, leaving the checked tasks' in view.
 */
type PreviewProps = { types: string[]; feed: MarkAllReadFeed; hiddenTasks?: ReadonlySet<number> }

/** One resource's unread events, from its worktree's feed. */
function ResourcePreview(props: { worktree: string; resource: ResourceDTO; feed: MarkAllReadFeed }) {
  const { type, id } = props.resource
  return <PreviewFeed feed={props.feed} tl={useWorktreeTimeline(props.worktree, { type, id }, [], true)} />
}

/** The global feed's unread events of `types`. */
function GlobalPreview(props: PreviewProps) {
  return <PreviewFeed {...props} tl={useGlobalTimeline(false, props.types, true)} />
}

/** One worktree's unread events of `types`. */
function WorktreePreview(props: PreviewProps & { worktree: string }) {
  return <PreviewFeed {...props} tl={useWorktreeTimeline(props.worktree, undefined, props.types, true)} />
}

/**
 * A task's unread activity from the checked sources. The task's feed has no
 * unread-only or type filter, so it is narrowed here, to the rows the confirm
 * would clear: unread events of a checked resource target, and of a checked
 * task. Anything else (a read row, an event of a resource no worktree
 * follows) is left out, so the preview never promises more than the mark.
 *
 * The narrowing is per page, so a page may hold no unread row while older
 * ones do: Load more stays offered while the feed has more.
 */
function TaskPreview({ task, feed, shows }: {
  task: number
  feed: MarkAllReadFeed
  shows: (e: TimelineEvent) => boolean
}) {
  const tl = useTaskActivity(task, { filter: "all" })
  const events = tl.events.filter((e) => e.unread && shows(e))
  if (!tl.isLoading && !tl.error && events.length === 0 && tl.hasMore) {
    return (
      <Stack gap="xs">
        <Text c="dimmed" size="sm">No unread activity in the newest events.</Text>
        <LoadMoreButton onLoadMore={tl.loadMore} loadingMore={tl.loadingMore} />
      </Stack>
    )
  }
  return <PreviewFeed feed={feed} tl={{ ...tl, events }} />
}

function PreviewFeed({ tl, feed, hiddenTasks }: Omit<PreviewProps, "types"> & {
  tl: ReturnType<typeof useGlobalTimeline>
}) {
  const { worktree: _, task: __, ...rest } = feed
  const events = hiddenTasks?.size
    ? tl.events.filter((e) => !(e.resource_type === "task" && hiddenTasks.has(Number(e.resource_id))))
    : tl.events
  return (
    <TimelineFeed
      {...rest}
      events={events}
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
 *
 * Every form also clears the unread tasks of its feed, `taskScope`: every
 * task on the home page, the worktree's tasks on its page, and the tasks
 * linking the resource in the single form — each through its own cursor
 * (taskTarget). The multi-resource form lists them as rows beside the
 * resource types, each checked by default and remembered as an exclusion
 * like the types; the single form marks them along with the resource.
 *
 * In the task modal (`feed.task`), `resources` are the task's resource links
 * and `taskScope` the task alone, so the rows are its linked resources by
 * source and the task's own unread as one task row — the same set its
 * combined_unread_count counts. A linked resource's cursor is shared by every
 * worktree following it, which is why it is only ever moved from here, by a
 * checkbox the user can see and uncheck.
 */
export function MarkAllReadButton({ resources, feed, taskScope, single = false, onMarked }: {
  resources: ResourceDTO[]
  feed: MarkAllReadFeed
  taskScope: TaskScope
  single?: boolean
  /** Called after a mark succeeds, for surfaces that show read state of their own. */
  onMarked?: () => void
}) {
  const [opened, setOpened] = useState(false)
  // Opened from the task modal it stacks over it: Esc closes only the top
  // modal (event details over this, then this), and it paints above.
  const { topmost, zIndex, layer } = useModalLayer(opened)
  // Whether the modal this button sits in (if any) is on top: R must not
  // open the confirm behind event details stacked over the task modal.
  const ownerTopmost = useLayerTopmost()
  const wide = useIsWide()
  const [unchecked, setUnchecked] = useState<ReadonlySet<Kind>>(new Set())
  const [uncheckedTasks, setUncheckedTasks] = useState<ReadonlySet<number>>(new Set())
  const qc = useQueryClient()

  // Live like `resources`: useSSE invalidates "tasks" on every new event, so
  // a task gaining unreads while the modal is open arrives (checked).
  // A failed fetch costs only the task rows; the resources still mark.
  const taskUnread = useQuery({ queryKey: taskUnreadKey(taskScope), queryFn: () => api.taskUnread(taskScope) })
  const tasks = taskUnread.data ?? []
  const selectedTasks = tasks.filter((t) => !uncheckedTasks.has(t.id))
  const taskCount = selectedTasks.reduce((n, t) => n + t.count, 0)

  const groups = KINDS.map((kind) => {
    const targets = resources
      .filter((r) => r.type === kind.type)
      .map(toTarget)
      .filter((t): t is Target => t !== null)
    return { kind, targets, count: targets.reduce((n, t) => n + t.count, 0) }
  }).filter((g) => g.targets.length > 0)
  const selected = groups.filter((g) => !unchecked.has(g.kind.type))
  const selectedTypes = selected.map((g) => g.kind.type)
  // The preview's types: "task" while any task is checked (the unchecked
  // ones are dropped from its rows, as hiddenTasks).
  const previewTypes: string[] = selectedTasks.length > 0 ? [...selectedTypes, "task"] : selectedTypes
  // The task preview's rows: those of a checked resource or task.
  const selectedKeys = new Set(selected.flatMap((g) => g.targets.map((t) => t.key)))
  const selectedTaskIds = new Set(selectedTasks.map((t) => t.id))
  const taskPreviewShows = (e: TimelineEvent) => e.resource_type === "task"
    ? selectedTaskIds.has(Number(e.resource_id))
    : selectedKeys.has(resourceKey(e.resource_type, e.resource_id))
  const anything = groups.length > 0 || tasks.length > 0
  const anySelected = selected.length > 0 || selectedTasks.length > 0

  // The home cards' focus lines, the worktrees' resource lists, the task
  // lists' dots and counts, and every timeline's dots and divider.
  const refreshUnreadSurfaces = () => {
    void qc.invalidateQueries({ queryKey: ["tasks"] })
    void qc.invalidateQueries({ queryKey: ["worktrees"] })
    void qc.invalidateQueries({ queryKey: ["resources"] })
    void qc.invalidateQueries({ queryKey: ["timeline"] })
  }

  const markAll = useMutation({
    // Parallel and independent: each call only moves one cursor forward, so a
    // partial failure leaves nothing inconsistent and a retry is safe. The
    // writes that landed are offered for undo even when another failed —
    // they moved cursors all the same.
    mutationFn: async () => {
      const summary = [
        ...selected.map((g) =>
          plural(g.count, `${g.kind.source} ${g.kind.item[0]}`, `${g.kind.source} ${g.kind.item[1]}`)),
        ...(taskCount > 0 ? [plural(taskCount, "task event", "task events")] : []),
      ].join(", ")
      const targets = [...selected.flatMap((g) => g.targets), ...selectedTasks.map(taskTarget)]
      const results = await Promise.allSettled(targets.map((t) => t.mark()))
      const undos = results.flatMap((r, i) =>
        r.status === "fulfilled" && r.value ? [{ label: targets[i].label, undo: r.value }] : [])
      if (undos.length > 0) {
        showUndoToast({
          message: `Marked ${summary} read`,
          undo: () => undoAll(undos),
          onSettled: refreshUnreadSurfaces,
        })
      }
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected")
      if (failed) throw failed.reason
    },
    onSuccess: () => {
      setOpened(false)
      onMarked?.()
    },
    // Settled, not success: a partial failure still moved some cursors, and
    // the surfaces showing them must catch up either way.
    onSettled: refreshUnreadSurfaces,
  })

  // R opens the preview, and Enter in it confirms (see useButtonHotkey) —
  // each only while its own modal is the top one, so neither reaches behind
  // a modal stacked over it.
  const openRef = useButtonHotkey("r", () => openModal(), anything && !opened && ownerTopmost)
  const confirmRef = useButtonHotkey("Enter", () => markAll.mutate(), opened && topmost && anySelected && !markAll.isPending)

  if (!anything && !opened) return null

  const openModal = () => {
    setUnchecked(new Set())
    setUncheckedTasks(new Set())
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
  const toggleTask = (id: number, checked: boolean) =>
    setUncheckedTasks((prev) => {
      const next = new Set(prev)
      if (checked) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <>
      {anything && (
        <Button
          size="compact-sm"
          {...MARK_READ_BUTTON_PROPS}
          onClick={openModal}
          ref={openRef}
          rightSection={<KeyHint decorative>R</KeyHint>}
        >
          Mark all read
        </Button>
      )}
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        closeOnEscape={topmost}
        zIndex={zIndex}
        title="Mark all read"
        centered
        size={singleResource ? "lg" : "xl"}
      >
        <ModalLayerProvider layer={layer}>
          <Stack gap="sm">
            {singleResource && feed.worktree ? (
              <Box>
                <Text size="sm" c="dimmed" mb="xs">
                  {/* Its tasks' events are in the preview too (a resource's
                      feed carries the tasks linking it), and are no "messages". */}
                  {singleGroup && taskCount === 0
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
                  {tasks.length > 0 && (
                    <Stack gap={6}>
                      <Text size="xs" c="dimmed" fw={600}>Tasks</Text>
                      {tasks.map((t) => (
                        <Checkbox
                          key={t.id}
                          checked={!uncheckedTasks.has(t.id)}
                          onChange={(e) => toggleTask(t.id, e.currentTarget.checked)}
                          label={
                            <>
                              <Text span fw={600} style={{ color: "var(--task-accent)" }}>{`T${t.id}`}</Text>
                              {` ${t.title}`}
                            </>
                          }
                          description={plural(t.count, "unread event", "unread events")}
                          styles={{ label: { overflowWrap: "anywhere" } }}
                        />
                      ))}
                    </Stack>
                  )}
                </Stack>
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" c="dimmed" mb="xs">The following activity will be marked as read</Text>
                  <ScrollArea.Autosize mah={wide ? "55vh" : "35vh"} type="auto" offsetScrollbars>
                    {/* Nothing checked lists nothing — and asks for nothing: an
                        empty resource_types means every type to the server. */}
                    {previewTypes.length === 0 ? null : feed.task !== undefined
                      ? <TaskPreview task={feed.task} feed={feed} shows={taskPreviewShows} />
                      : feed.worktree
                      ? <WorktreePreview worktree={feed.worktree} types={previewTypes} feed={feed} hiddenTasks={uncheckedTasks} />
                      : <GlobalPreview types={previewTypes} feed={feed} hiddenTasks={uncheckedTasks} />}
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
                disabled={!anySelected}
                onClick={() => markAll.mutate()}
                ref={confirmRef}
                // Focus lands here on open, not on the close button, which
                // Enter would otherwise belong to.
                data-autofocus
                rightSection={<KeyHint decorative>↵</KeyHint>}
              >
                Mark read
              </Button>
            </Group>
          </Stack>
        </ModalLayerProvider>
      </Modal>
    </>
  )
}
