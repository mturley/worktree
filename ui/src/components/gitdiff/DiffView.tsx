import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ActionIcon, Anchor, Box, Button, Drawer, Group, SegmentedControl, Stack, Switch, Text, TextInput, Tooltip } from "@mantine/core"
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { Commit, DiffBase, DiffPatch, DiffRange } from "../../api/types"
import { useDiffCommits } from "../../hooks/useDiffData"
import { useDiffSelection } from "../../hooks/useDiffSelection"
import { useDiffView } from "../../hooks/useDiffView"
import { useIsWide } from "../../hooks/useIsWide"
import { useWorktreeGit } from "../../hooks/useWorktreeGit"
import { diffUnavailable } from "../../lib/diffLabels"
import { KeyHint } from "../search/KeyHint"
import { CompareSelect } from "./CompareSelect"
import { DiffBody, type DiffMode } from "./DiffBody"
import { DiffFileTree } from "./DiffFileTree"
import { parseDiff } from "./parsedPatch"
import { scrollToFile } from "./scrollToFile"
import { RangePicker } from "./RangePicker"

const MODE_KEY = "worktree.diffMode"
const SIDEBAR_KEY = "worktree.diffSidebar"
const SIDEBAR_WIDTH = 280

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
export default function DiffView({ path, headerHeight }: { path: string; headerHeight: number }) {
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

  // The status poll may be up to 5s older than the patch; without catching it
  // up, its older working fingerprint would flash Refresh after every load.
  useEffect(() => {
    if (shown) void qc.invalidateQueries({ queryKey: ["worktree-git", path] })
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
      {stale && (
        <Group gap={6} wrap="nowrap" data-testid="diff-stale">
          <Text size="xs" c="yellow">Files changed on disk ·</Text>
          <Button size="compact-xs" variant="light" color="yellow" onClick={() => reload()}>
            Refresh
          </Button>
        </Group>
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

  let body: ReactNode
  if (!git) body = <Message>Loading…</Message>
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
  else if (!shown) body = <Message>Loading…</Message>
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
      <Group gap="xs" wrap="nowrap" style={{ flex: "none", minHeight: 28 }} data-diff-breadcrumb>
        <Anchor component="button" type="button" size="sm" onClick={() => view.leave()}>
          ← Code
        </Anchor>
        <Text size="sm" c="dimmed">/</Text>
        <Text size="sm">Changes</Text>
        {wide && (
          <Text size="xs" c="dimmed" ml="auto">
            <KeyHint>Esc</KeyHint> to go back
          </Text>
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
      </Box>
      {!wide && (
        <Drawer opened={drawerOpen} onClose={() => setDrawerOpen(false)} title="Files" size="85%">
          {sidebar}
        </Drawer>
      )}
    </Box>
  )
}

function Message({ children, error }: { children: ReactNode; error?: boolean }) {
  return (
    <Text size="sm" c={error ? "red" : "dimmed"} p="xs">
      {children}
    </Text>
  )
}
