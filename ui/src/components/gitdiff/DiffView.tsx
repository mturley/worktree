import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ActionIcon, Anchor, Box, Button, Drawer, Group, SegmentedControl, Stack, Switch, Text, TextInput, Tooltip } from "@mantine/core"
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api, HttpError } from "../../api/client"
import type { Commit, DiffBase, DiffPatch, DiffRange, PRThread, ReviewCommentItem } from "../../api/types"
import { useDiffCommits } from "../../hooks/useDiffData"
import { useDiffSelection } from "../../hooks/useDiffSelection"
import { useDiffView } from "../../hooks/useDiffView"
import { useIsWide } from "../../hooks/useIsWide"
import { useDeletedDrafts, useEditingCommentIds, useReviewComments } from "../../hooks/useReviewComments"
import { useReviewSidebar, useReviewSidebarTab } from "../../hooks/useReviewSidebar"
import { useWorktreeGit } from "../../hooks/useWorktreeGit"
import { diffUnavailable } from "../../lib/diffLabels"
import { countsAreUnread, toolbarLabel } from "../../lib/reviewCounts"
import { OpenInEditorButton } from "../OpenInEditorButton"
import { KeyHint } from "../search/KeyHint"
import { buildPrompt } from "./buildPrompt"
import { CompareSelect } from "./CompareSelect"
import type { CommentTarget } from "./commentRange"
import { DiffBody, type DiffMode } from "./DiffBody"
import { DiffFileTree } from "./DiffFileTree"
import { Loading } from "./Loading"
import { parseDiff } from "./parsedPatch"
import { ReviewSidebar } from "./ReviewSidebar"
import { scrollToComment, scrollToFile, scrollToPRThread } from "./scrollToFile"
import { usePRCommentsView } from "./usePRCommentsView"
import { GitSummary } from "./GitSummary"
import { RangePicker } from "./RangePicker"

const MODE_KEY = "worktree.diffMode"
const SIDEBAR_KEY = "worktree.diffSidebar"
const SIDEBAR_WIDTH = 280
const REVIEW_SIDEBAR_WIDTH = 340
// Until the list loads, no comments. Stable, so DiffBody's annotations are.
const NO_COMMENTS: ReviewCommentItem[] = []
// Which edit drafts are on screen: the sidebar's only while it is open.
const BOTH_VARIANTS = ["inline", "sidebar"] as const
const INLINE_ONLY = ["inline"] as const

function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
function writePref(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage blocked or full: the choice lasts for this page view.
  }
}

/**
 * One patch request: the selection it was made for, the commit list that
 * selection was made against, and a counter so Refresh always refetches.
 */
interface Request {
  base: DiffBase
  range: DiffRange
  ignoreWs: boolean
  /** The list the range's SHAs come from, so the picker can still describe it once the live list moves on. */
  commits: Commit[]
  n: number
}
type Loaded = DiffPatch & { request: Request }

const includesUncommitted = (r: DiffRange) => r === "all" || r.to === "uncommitted"
const rangeKey = (r: DiffRange) => (r === "all" ? "all" : `${r.from}..${r.to}`)

/**
 * The drill-down diff view, inside the worktree detail page under its real
 * header (see WorktreeDetailPage). Loaded with React.lazy, so pierre is a
 * separate chunk fetched on first entry.
 *
 * It PINS what it loaded: the patch is fetched for the selection current at
 * entry and kept, however the worktree moves underneath ("never shift under
 * the reader"). When what it shows could differ — the commit list changed,
 * or the selection includes uncommitted changes and the working tree moved —
 * it offers Refresh, which reloads with the live (possibly reset) selection.
 * Changing the selection or the whitespace switch is an explicit action and
 * reloads at once.
 */
export default function DiffView({
  path,
  repo,
  headerHeight,
  escHint = true,
  sidebarEscHint = false,
}: {
  path: string
  /** The worktree's repo, for the sidebar's git details. */
  repo?: string
  headerHeight: number
  /** Whether Esc's next step is leaving (the page's: a query in the search bar comes first). */
  escHint?: boolean
  /** Whether Esc's next step is closing the review comments sidebar. */
  sidebarEscHint?: boolean
}) {
  const view = useDiffView()
  const wide = useIsWide()
  const qc = useQueryClient()
  // Polled while the view is open; `fetch` keeps the background fetch going
  // so the behind count stays fresh, which never by itself raises Refresh.
  const git = useWorktreeGit(path, { fetch: true }).data

  // As in GitDiffPanel: the base picks the list, the list's id decides
  // whether the stored range still applies.
  const { base } = useDiffSelection(path, undefined)
  const unavailable = git ? diffUnavailable(git, base) : undefined
  const baseRef = base === "merge-base" ? git?.main_upstream : git?.tracking
  const commits = useDiffCommits(path, base, !!git?.on_disk && !unavailable, git?.fingerprint)
  const sel = useDiffSelection(path, commits.data?.list_id)

  const [ignoreWs, setIgnoreWs] = useState(false)
  const [request, setRequest] = useState<Request | null>(null)
  // The first load waits for the commit list, so a range left over from an
  // older list has already fallen back to "all".
  useEffect(() => {
    if (!request && commits.data)
      setRequest({ base: sel.base, range: sel.range, ignoreWs, commits: commits.data.commits, n: 0 })
  }, [request, commits.data, sel.base, sel.range, ignoreWs])

  /** Reloads with the live selection, overridden by whatever just changed. */
  const reload = useCallback(
    (over: Partial<Omit<Request, "n" | "commits">> = {}) => {
      const b = over.base ?? sel.base
      setRequest((r) => ({
        base: b,
        range: over.range ?? sel.range,
        ignoreWs: over.ignoreWs ?? ignoreWs,
        // A new base's list isn't loaded yet; its range is "all", which
        // needs no list to describe.
        commits: b === base ? (commits.data?.commits ?? []) : [],
        n: (r?.n ?? 0) + 1,
      }))
    },
    [sel.base, sel.range, ignoreWs, base, commits.data],
  )

  const patch = useQuery({
    // The commit snapshot is carried along, not part of the identity.
    queryKey: ["diff-patch", path, request && { ...request, commits: undefined }],
    queryFn: async (): Promise<Loaded> => {
      const r = request!
      return { ...(await api.diffPatch(path, r.base, r.range, r.ignoreWs)), request: r }
    },
    enabled: !!request,
    // Pinned: only a new request (entry, Refresh, a selection change) loads.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Keep showing the last diff while the next one loads, for this worktree only.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === path ? prev : undefined),
  })
  const shown = patch.data

  // Set when a load was asked for because the comment list's revs expired:
  // that load's revs are fresh, so the list is asked again at once.
  const refetchCommentsOnLoad = useRef(false)
  // The status poll may be up to 5s older than the patch; without catching it
  // up, its older working fingerprint would flash Refresh after every load.
  useEffect(() => {
    if (!shown) return
    void qc.invalidateQueries({ queryKey: ["worktree-git", path] })
    if (refetchCommentsOnLoad.current) {
      refetchCommentsOnLoad.current = false
      void qc.invalidateQueries({ queryKey: ["review-comments", path] })
    }
  }, [shown, qc, path])

  const stale =
    !!shown &&
    !patch.isFetching &&
    ((!!commits.data && commits.data.list_id !== shown.list_id) ||
      (includesUncommitted(shown.request.range) && !!git && git.working_fingerprint !== shown.working_fingerprint))

  // The worker's highlight cache is keyed by this prefix plus the file's
  // position, so it names everything the content depends on.
  const loadKey = shown
    ? `${shown.list_id}:${shown.working_fingerprint}:${shown.request.ignoreWs}:${shown.request.base}:${rangeKey(shown.request.range)}`
    : ""
  const files = useMemo(() => (shown ? parseDiff(shown.patch, loadKey) : []), [shown, loadKey])
  const additions = files.reduce((n, f) => n + f.additions, 0)
  const deletions = files.reduce((n, f) => n + f.deletions, 0)

  const [filter, setFilter] = useState("")
  const treeFiles = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files
  }, [files, filter])

  const [storedMode, setStoredMode] = useState<DiffMode>(() => (readPref(MODE_KEY) === "unified" ? "unified" : "split"))
  // A phone has no room for two columns.
  const mode: DiffMode = wide ? storedMode : "unified"
  const [collapsed, setCollapsed] = useState(() => readPref(SIDEBAR_KEY) === "collapsed")
  const [drawerOpen, setDrawerOpen] = useState(false)

  const [highlighted, setHighlighted] = useState<string | null>(view.file)
  // One scroll in flight at a time: a new jump (or leaving) cancels the last.
  const cancelScroll = useRef<(() => void) | null>(null)
  const scrollTo = useCallback((file: string) => {
    setHighlighted(file)
    cancelScroll.current?.()
    cancelScroll.current = scrollToFile(file)
  }, [])
  useEffect(() => () => cancelScroll.current?.(), [])
  // `&file=` lands on that file once, through the same path as a tree click;
  // scrollToFile waits for the wrapper to render and settle.
  const landed = useRef(false)
  useEffect(() => {
    const target = view.file
    if (landed.current || !target || !files.some((f) => f.path === target)) return
    landed.current = true
    scrollTo(target)
  }, [view.file, files, scrollTo])

  // Review comments, positioned for the view on screen. The list goes to
  // DiffBody as react-query hands it over, so its annotations stay put
  // across polls that change nothing (but not another view's: see below).
  const review = useReviewComments(path, shown ? { oldRev: shown.old_rev, newRev: shown.new_rev } : undefined)
  const comments = review.data ?? NO_COMMENTS
  const fresh = !!review.data && !review.isPlaceholderData
  // Comments deleted elsewhere while being edited stay in the sidebar until dismissed.
  const deletedDrafts = useDeletedDrafts(path).drafts
  const reviewCount = comments.length + deletedDrafts.filter((d) => !comments.some((c) => c.id === d.comment.id)).length
  const [reviewOpen, setReviewOpen] = useReviewSidebar()

  const revPair = shown ? `${shown.old_rev}..${shown.new_rev}` : undefined

  // A view change: anything that loads a different patch.
  const viewKey = shown ? `${loadKey}:${shown.old_rev}..${shown.new_rev}` : ""
  const [pendingComment, setPendingComment] = useState<CommentTarget | null>(null)
  // Refresh asks for a recheck: how the comments fared against the new revs.
  const recheckAsked = useRef(false)
  const [recheckKey, setRecheckKey] = useState<string | null>(null)
  // A jump to a comment in another view: waits through the view change it
  // asked for (`key` is that view), and no further.
  const [pendingJump, setPendingJump] = useState<{ id: number; key?: string } | null>(null)
  const seenViewKey = useRef(viewKey)
  useEffect(() => {
    if (viewKey === seenViewKey.current) return
    seenViewKey.current = viewKey
    setPendingComment(null)
    setRecheckKey(recheckAsked.current ? viewKey : null)
    recheckAsked.current = false
    setPendingJump((j) => (j && j.key === undefined ? { ...j, key: viewKey } : null))
  }, [viewKey])

  // The server forgets a view's revs once unused for a while; the list then
  // answers 404. A fresh load of the same view (its own request, never a
  // pending selection change) hands out fresh revs. Once per rev pair, until
  // the list loads again, so a load that doesn't help can't loop. Never while
  // a comment is being written or edited on screen: the load would move the
  // diff under it. A sidebar edit hidden by closing the sidebar doesn't count;
  // its draft outlives the load. Tries again as soon as the editor closes.
  const editingIds = useEditingCommentIds(path, reviewOpen ? BOTH_VARIANTS : INLINE_ONLY)
  const editorOpen = pendingComment !== null || editingIds.some((id) => comments.some((c) => c.id === id))
  const shownRequest = shown?.request
  const autoReloaded = useRef<string | null>(null)
  const reviewError = review.error
  useEffect(() => {
    if (fresh && !reviewError) autoReloaded.current = null
    if (!revPair || !shownRequest || !(reviewError instanceof HttpError) || reviewError.status !== 404) return
    if (editorOpen || autoReloaded.current === revPair) return
    autoReloaded.current = revPair
    refetchCommentsOnLoad.current = true
    reload({ base: shownRequest.base, range: shownRequest.range, ignoreWs: shownRequest.ignoreWs })
  }, [fresh, reviewError, revPair, shownRequest, reload, editorOpen])

  const [openFile, setOpenFile] = useState<{ file: string; n: number } | null>(null)
  const showComment = useCallback((c: ReviewCommentItem) => {
    setHighlighted(c.file)
    setOpenFile((o) => ({ file: c.file, n: (o?.n ?? 0) + 1 }))
    cancelScroll.current?.()
    cancelScroll.current = scrollToComment(c.file, c.id)
  }, [])
  useEffect(() => {
    if (!pendingJump || pendingJump.key !== viewKey || !fresh) return
    const c = comments.find((x) => x.id === pendingJump.id)
    if (c?.view?.status !== "shown") return
    setPendingJump(null)
    showComment(c)
  }, [pendingJump, viewKey, fresh, comments, showComment])

  // A PR thread the view shows, as showComment. Its inline card exists only
  // while "Show in diff view" is on; scrollToPRThread lands on the file
  // first and waits for the card, so it does without the switch too.
  const jumpThread = useCallback(
    (t: PRThread) => {
      if (!wide) setReviewOpen(false)
      if (t.view?.status !== "shown") {
        scrollTo(t.file)
        return
      }
      setHighlighted(t.file)
      setOpenFile((o) => ({ file: t.file, n: (o?.n ?? 0) + 1 }))
      cancelScroll.current?.()
      cancelScroll.current = scrollToPRThread(t.file, t.id)
    },
    [wide, setReviewOpen, scrollTo],
  )
  const pr = usePRCommentsView({
    path,
    view: shown ? { oldRev: shown.old_rev, newRev: shown.new_rev } : undefined,
    ready: !patch.isFetching,
    onJumpShown: jumpThread,
  })
  // What the sidebar has to show: local comments, the PINNED threads
  // (resolved ones too), or threads GitHub counts that the pinned list
  // doesn't have yet (its PR tab offers their Refresh).
  const pinnedThreads = pr.threads?.threads.length ?? 0
  const hasContent = reviewCount > 0 || pinnedThreads > 0 || pr.openThreads > 0 || pr.pendingComments > 0
  // Mounted while open, and once mounted it stays until closed: polls never
  // mount or unmount it (that would widen or narrow the diff under the
  // reader), nor does a Refresh's interval with nothing loaded. Only Mike's
  // click opens it, a `&prcomment` link, or an open state remembered from
  // earlier in this tab and shown at entry.
  const [sidebarKept, setSidebarKept] = useState(false)
  const sidebarMounted = reviewOpen && (sidebarKept || hasContent)
  if (sidebarMounted !== sidebarKept) setSidebarKept(sidebarMounted)
  // The toolbar button follows the live counts (a button appearing moves no
  // code), and stays while the sidebar is open, as its only close.
  const hasReview = reviewCount > 0 || pr.openThreads > 0 || pr.pendingComments > 0 || sidebarMounted
  const [, setReviewTab] = useReviewSidebarTab()
  const openReview = () => {
    // The button counting only PR comments opens where they are, not on an
    // empty Local tab.
    if (reviewCount === 0 && (pr.openThreads > 0 || pr.pendingComments > 0)) setReviewTab("pr")
    setSidebarKept(true)
    setReviewOpen(true)
  }
  // On entry, a remembered-open sidebar with nothing to show closes, once the
  // view's own lists are in (or the patch failed), so a later poll can't
  // open it. Never waits on the polled summary.
  const prSettled = pr.settled
  const entryChecked = useRef(false)
  useEffect(() => {
    if (entryChecked.current || !((review.data && prSettled) || patch.isError)) return
    entryChecked.current = true
    if (reviewOpen && !sidebarMounted) setReviewOpen(false)
  }, [review.data, prSettled, patch.isError, reviewOpen, sidebarMounted, setReviewOpen])
  // Afterwards it closes only when Mike's own action empties it: the last
  // local comment deleted or cleared (or a deleted-elsewhere draft
  // dismissed), with no PR threads pinned or counted, so the next first
  // comment doesn't open it. Only fresh lists count: a view change's
  // interval with no list is not a deletion.
  const lastLocal = useRef<number | null>(null)
  useEffect(() => {
    if (!fresh) return
    const was = lastLocal.current
    lastLocal.current = reviewCount
    if (was !== null && was > 0 && reviewCount === 0 && pinnedThreads === 0 && pr.openThreads === 0 && pr.pendingComments === 0 && reviewOpen) {
      setReviewOpen(false)
    }
  }, [fresh, reviewCount, pinnedThreads, pr.openThreads, pr.pendingComments, reviewOpen, setReviewOpen])
  // The tree's blue dots: every file a comment was made on, and those with
  // PR threads in the diff while they show.
  const prFiles = pr.files
  const commentedFiles = useMemo(() => new Set([...comments.map((c) => c.file), ...prFiles]), [comments, prFiles])

  const jump = (c: ReviewCommentItem) => {
    // The drawer covers the diff on a phone.
    if (!wide) setReviewOpen(false)
    switch (c.view?.status) {
      case "shown":
        showComment(c)
        break
      case "outdated":
        scrollTo(c.file)
        break
      case "not_in_view":
        sel.setBase(c.base)
        reload({ base: c.base, range: "all" })
        setPendingJump({ id: c.id })
        break
    }
  }

  const prompt = useMemo(
    () =>
      git && commits.data
        ? buildPrompt({
            directory: git.directory ?? path,
            branch: git.branch || undefined,
            baseRef: commits.data.base_ref,
            comments,
          })
        : undefined,
    [git, commits.data, path, comments],
  )
  const recheck = recheckKey === viewKey && fresh ? recheckSummary(comments) : undefined
  const reviewSidebar = () =>
    prompt !== undefined && (
      <ReviewSidebar
        path={path}
        comments={comments}
        viewKey={fresh ? revPair : undefined}
        prompt={prompt}
        onJump={jump}
        pr={{ summary: pr.summary, threads: pr.threads, prResource: pr.prResource, onJumpThread: jumpThread, onRefresh: pr.refresh }}
      />
    )

  // The selectors show the pinned selection (what is loaded or loading).
  const shownBase = request?.base ?? sel.base
  const shownRange = request?.range ?? sel.range
  const selectors = (labelPosition: "top" | "left") => (
    <>
      <CompareSelect
        value={shownBase}
        onChange={(b) => {
          sel.setBase(b)
          reload({ base: b, range: "all" })
        }}
        mainUpstream={git?.main_upstream}
        tracking={git?.tracking}
        labelPosition={labelPosition}
      />
      <RangePicker
        // While stale, the pinned list: the label and checkboxes describe
        // what is on screen, not a list it was never chosen from. Refresh
        // hands back to the live list.
        commits={(stale ? shown?.request.commits : undefined) ?? commits.data?.commits ?? []}
        uncommittedCount={git?.working.files ?? 0}
        range={shownRange}
        onChange={(r) => {
          sel.setRange(r)
          reload({ range: r })
        }}
        labelPosition={labelPosition}
        fullWidth={labelPosition === "top"}
        disabled={!!unavailable || !commits.data}
      />
    </>
  )

  const sidebar = (
    <Stack gap="sm" p={wide ? "xs" : 0}>
      {selectors("top")}
      {/* The Code tab's details, in one column to fit the sidebar. */}
      {git?.on_disk && <GitSummary git={git} repo={repo} oneColumn />}
      <TextInput
        size="xs"
        placeholder="Filter files"
        aria-label="Filter files"
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
      />
      <DiffFileTree
        files={treeFiles}
        selected={highlighted}
        commented={commentedFiles}
        onSelect={(f) => {
          setDrawerOpen(false)
          scrollTo(f)
        }}
      />
    </Stack>
  )

  const sidebarToggle = wide ? (
    <Tooltip label={collapsed ? "Show sidebar" : "Hide sidebar"}>
      <ActionIcon
        variant="subtle"
        color="gray"
        aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
        onClick={() => {
          writePref(SIDEBAR_KEY, collapsed ? "open" : "collapsed")
          setCollapsed(!collapsed)
        }}
      >
        {collapsed ? <IconLayoutSidebarLeftExpand size={18} /> : <IconLayoutSidebarLeftCollapse size={18} />}
      </ActionIcon>
    </Tooltip>
  ) : (
    <ActionIcon variant="subtle" color="gray" aria-label="Show files" onClick={() => setDrawerOpen(true)}>
      <IconLayoutSidebarLeftExpand size={18} />
    </ActionIcon>
  )

  const toolbar = (
    <Group gap="sm" wrap="wrap" align="center" px="xs" py={6} style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
      {sidebarToggle}
      {wide && collapsed && selectors("left")}
      {shown && (
        <Group gap={8} wrap="nowrap">
          <Text size="sm" fw={600}>{files.length === 1 ? "1 file changed" : `${files.length} files changed`}</Text>
          <Text size="xs" ff="monospace">
            <Text span inherit c="green">{`+${additions}`}</Text>{" "}
            <Text span inherit c="red">{`−${deletions}`}</Text>
          </Text>
        </Group>
      )}
      {(stale || pr.stale) && (
        <Group gap={6} wrap="nowrap" data-testid="diff-stale">
          <Text size="xs" c="yellow">
            {stale && pr.stale ? "Files changed on disk, new PR comments ·" : stale ? "Files changed on disk ·" : "New PR comments ·"}
          </Text>
          <Button
            size="compact-xs"
            variant="light"
            color="yellow"
            onClick={() => {
              // New PR comments alone reload only the threads: the code
              // on screen is still current, so it doesn't move. With the
              // code, the threads wait for the new patch's revs (`ready`).
              if (stale) {
                recheckAsked.current = true
                reload()
              }
              pr.refresh()
            }}
          >
            Refresh
          </Button>
        </Group>
      )}
      {recheck && (
        <Text size="xs" c="dimmed" data-testid="comment-recheck">
          {recheck}
        </Text>
      )}
      <Group gap="sm" wrap="nowrap" ml="auto">
        {wide && (
          <SegmentedControl
            size="xs"
            value={storedMode}
            onChange={(v) => {
              const m: DiffMode = v === "unified" ? "unified" : "split"
              writePref(MODE_KEY, m)
              setStoredMode(m)
            }}
            data={[
              { value: "split", label: "Split" },
              { value: "unified", label: "Unified" },
            ]}
          />
        )}
        <Switch
          size="xs"
          label="Hide whitespace"
          checked={ignoreWs}
          onChange={(e) => {
            const v = e.currentTarget.checked
            setIgnoreWs(v)
            reload({ ignoreWs: v })
          }}
        />
      </Group>
    </Group>
  )

  const unreadBlue = countsAreUnread(reviewCount, pr.unreadComments, pr.pendingComments)

  let body: ReactNode
  if (!git) body = <Box p="xs"><Loading size="sm" /></Box>
  else if (!git.on_disk) body = <Message>This worktree is not on disk.</Message>
  else if (unavailable) body = <Message>{unavailable}</Message>
  // The first request waits for the commit list, so without this a failed
  // list would leave the view on "Loading…" for good. Worded as GitDiffPanel.
  else if (commits.isError && !request)
    body = (
      <Message error>
        Could not load changes{baseRef ? ` against ${baseRef}` : ""}: {commits.error.message}
      </Message>
    )
  else if (patch.isError && !shown) body = <Message error>Could not load the diff: {patch.error.message}</Message>
  else if (!shown) body = <Box p="xs"><Loading size="sm" /></Box>
  else if (files.length === 0) body = <Message>No changes</Message>
  else
    body = (
      <DiffBody
        files={files}
        loadKey={loadKey}
        oldRev={shown.old_rev}
        newRev={shown.new_rev}
        mode={mode}
        path={path}
        highlighted={highlighted}
        height="100%"
        // Until the shown view's own list arrives, the last view's positions
        // would land on lines of this patch: none at all, then.
        comments={fresh ? comments : NO_COMMENTS}
        pending={pendingComment}
        onStartComment={setPendingComment}
        onPendingDone={() => setPendingComment(null)}
        // A new comment is made against the view on screen.
        view={{ base: shown.request.base, range: shown.request.range, oldRev: shown.old_rev, newRev: shown.new_rev }}
        openFile={openFile}
        prThreads={pr.inline}
      />
    )

  return (
    <Box
      data-diff-view
      style={{
        // Fills what the page leaves below its sticky header: the Stack's gap
        // above and its padding below. The document itself then has nothing
        // to scroll; the diff body and sidebar scroll instead (see the
        // comment in WorktreeDetailPage on why that's the exception here).
        height: `calc(100dvh - ${headerHeight}px - 2 * var(--mantine-spacing-md))`,
        minHeight: 240,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Padded below so the Esc hint clears the bordered body under it. */}
      <Group gap="xs" wrap="nowrap" pb="xs" style={{ flex: "none", minHeight: 28 }} data-diff-breadcrumb>
        {/* The Esc hint sits on the control that does the same, as "← all resources" has it. */}
        <Group gap={6} wrap="nowrap">
          <Anchor component="button" type="button" size="sm" onClick={() => view.leave()}>
            ← Worktree details
          </Anchor>
          {wide && escHint && <KeyHint>Esc</KeyHint>}
        </Group>
        <Text size="sm" c="dimmed">/</Text>
        {/* The branch, when there is one (empty when detached). */}
        <Text size="sm">{git?.branch ? `Changes (${git.branch})` : "Changes"}</Text>
        <OpenInEditorButton path={path} />
        {hasReview && (
          // Closed, with local comments or unread PR comments, filled in the
          // unread blue (as Mark all read: lighter on hover), so the review
          // in progress is hard to miss. Open, dimmer: it is the sidebar's
          // close, with Esc's hint inside when Esc would do the same.
          <Button
            ml="auto"
            size="xs"
            variant={!reviewOpen && unreadBlue ? "filled" : "light"}
            color={!reviewOpen && unreadBlue ? "blue" : undefined}
            vars={!reviewOpen && unreadBlue ? () => ({ root: { "--button-hover": "var(--mantine-color-blue-4)" } }) : undefined}
            rightSection={wide && reviewOpen && sidebarEscHint ? <KeyHint decorative>Esc</KeyHint> : undefined}
            onClick={() => (reviewOpen ? setReviewOpen(false) : openReview())}
          >
            {reviewOpen ? "Close comments sidebar" : toolbarLabel(reviewCount, pr.openThreads, pr.unreadComments, pr.pendingComments)}
          </Button>
        )}
      </Group>
      <Box
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          border: "1px solid var(--mantine-color-default-border)",
          borderRadius: "var(--mantine-radius-sm)",
          overflow: "hidden",
        }}
      >
        {wide && !collapsed && (
          <Box
            style={{
              width: SIDEBAR_WIDTH,
              flexShrink: 0,
              overflowY: "auto",
              borderRight: "1px solid var(--mantine-color-default-border)",
            }}
          >
            {sidebar}
          </Box>
        )}
        <Box style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {toolbar}
          {/* Absolutely filled so pierre's Virtualizer gets a definite height. */}
          <Box style={{ flex: 1, minHeight: 0, position: "relative" }}>
            <Box style={{ position: "absolute", inset: 0, padding: "var(--mantine-spacing-xs)" }}>{body}</Box>
          </Box>
        </Box>
        {wide && sidebarMounted && (
          <Box
            style={{
              width: REVIEW_SIDEBAR_WIDTH,
              flexShrink: 0,
              overflowY: "auto",
              borderLeft: "1px solid var(--mantine-color-default-border)",
            }}
          >
            {reviewSidebar()}
          </Box>
        )}
      </Box>
      {!wide && (
        <Drawer opened={drawerOpen} onClose={() => setDrawerOpen(false)} title="Files" size="85%">
          {sidebar}
        </Drawer>
      )}
      {!wide && (
        <Drawer
          opened={sidebarMounted}
          onClose={() => setReviewOpen(false)}
          position="right"
          size="85%"
          title="Review comments"
        >
          {reviewSidebar()}
        </Drawer>
      )}
    </Box>
  )
}

/** How the comments fared against a refreshed view: "2 still match, 1 moved", non-zero parts only. */
function recheckSummary(comments: ReviewCommentItem[]): string {
  let still = 0
  let moved = 0
  let outdated = 0
  for (const c of comments) {
    if (c.view?.status === "shown") {
      if (c.view.moved) moved++
      else still++
    } else if (c.view?.status === "outdated") outdated++
  }
  const parts: string[] = []
  if (still) parts.push(`${still} still match`)
  if (moved) parts.push(`${moved} moved`)
  if (outdated) parts.push(`${outdated} out of date`)
  return parts.join(", ")
}

function Message({ children, error }: { children: ReactNode; error?: boolean }) {
  return (
    <Text size="sm" c={error ? "red" : "dimmed"} p="xs">
      {children}
    </Text>
  )
}
