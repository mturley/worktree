/// <reference types="vite/client" />
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActionIcon, Box, Group, Stack, Text } from "@mantine/core"
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react"
import type { DiffLineAnnotation, FileDiffLoadedFiles, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs"
import { FileDiff, Virtualizer, WorkerPoolContextProvider } from "@pierre/diffs/react"
// The PORTABLE worker: the plain worker.js fails under Vite with
// `Theme "pierre-dark" has not been resolved` (spike finding), and for the
// same reason no `theme` is passed below, only `themeType`.
import DiffsWorker from "@pierre/diffs/worker/worker-portable.js?worker"
import { api } from "../../api/client"
import type { DiffBase, DiffRange, ReviewCommentItem } from "../../api/types"
import { useDeletedDrafts } from "../../hooks/useReviewComments"
import { lineInHunks, pierreSide, toCommentTarget, type CommentTarget } from "./commentRange"
import { OpenFileInEditorIcon } from "./OpenFileInEditorIcon"
import { NewCommentCard, ReviewCommentCard } from "./ReviewCommentCard"
import { fileAnchorId, type DiffFile } from "./parsedPatch"
import { DIFF_SCROLLER_CLASS } from "./scrollToFile"

export type DiffMode = "split" | "unified"

/** The view a new comment is made in: what it is created against. */
export interface CommentView {
  base: DiffBase
  range: DiffRange
  oldRev: string
  newRev: string
}

/** What one pierre annotation holds: the comments ending on its line, and the one being written there. */
export interface CommentAnnotation {
  items: ReviewCommentItem[]
  pending?: CommentTarget
}

const poolOptions = { workerFactory: () => new DiffsWorker() }
const highlighterOptions = {}

/**
 * The diff view's body: one pierre `FileDiff` per file inside pierre's
 * `Virtualizer`, which is its own scroll container and so is given an
 * explicit height. Each file sits in a wrapper with a stable id
 * (`fileAnchorId`) for scrollToFile; pierre renders in shadow DOM, so the
 * wrappers are also what tests and the rest of the page can see.
 *
 * `oldRev`/`newRev` are the resolved revisions the patch was computed
 * between; expanding unchanged lines fetches both sides at exactly those,
 * so it keeps working while the view is stale.
 *
 * Review comments the view shows sit inside the diff as pierre annotations,
 * under the line they end on; the gutter's "+" starts a new one there.
 */
export function DiffBody({
  files,
  loadKey,
  oldRev,
  newRev,
  mode,
  path,
  highlighted,
  height,
  comments,
  pending,
  onStartComment,
  onPendingDone,
  view,
  openFile,
}: {
  files: DiffFile[]
  /** Changes with every load; folds reset with it. */
  loadKey: string
  oldRev: string
  newRev: string
  mode: DiffMode
  path: string
  highlighted: string | null
  height: string
  /** Every comment; those the view shows render inline. */
  comments: ReviewCommentItem[]
  /** Where a new comment is being written, if anywhere. */
  pending: CommentTarget | null
  onStartComment: (t: CommentTarget) => void
  onPendingDone: () => void
  view: CommentView
  /** Each new value unfolds that file. */
  openFile: { file: string; n: number } | null
}) {
  // Per-file fold overrides on top of each file's default (autoCollapse),
  // for this load only.
  const [folds, setFolds] = useState<{ key: string; open: Record<string, boolean> }>({ key: loadKey, open: {} })
  const open = folds.key === loadKey ? folds.open : {}
  const setOpen = useCallback(
    (file: string, value: boolean) =>
      setFolds((f) => ({ key: loadKey, open: { ...(f.key === loadKey ? f.open : {}), [file]: value } })),
    [loadKey],
  )
  // Jumping to a file (the tree, `&file=`) means wanting to read it.
  useEffect(() => {
    if (highlighted) setOpen(highlighted, true)
  }, [highlighted, setOpen])
  // So is jumping to a comment in it; `n` asks again for the same file.
  const openFileName = openFile?.file
  const openFileN = openFile?.n
  useEffect(() => {
    if (openFileName !== undefined) setOpen(openFileName, true)
  }, [openFileName, openFileN, setOpen])

  // The comments to place: those the view shows, and the ones deleted
  // elsewhere while being edited, at their last place, until dismissed. That
  // place is a line of the view it was deleted in, so only that view has it.
  const deleted = useDeletedDrafts(path).drafts
  const placed = useMemo(() => {
    const shown = comments.filter((c) => c.view?.status === "shown")
    const ids = new Set(comments.map((c) => c.id))
    const gone = deleted
      .filter((d) => d.view === `${oldRev}..${newRev}`)
      .map((d) => d.comment)
      .filter((c) => !ids.has(c.id) && c.view?.status === "shown")
    return [...shown, ...gone]
  }, [comments, deleted, oldRev, newRev])

  // pierre compares options shallowly, so the gutter callback must not change
  // with every render of the page above.
  const startRef = useRef(onStartComment)
  useEffect(() => {
    startRef.current = onStartComment
  })
  const startComment = useCallback((t: CommentTarget) => startRef.current(t), [])

  const loadDiffFiles = useCallback(
    async (fd: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
      const newFile = api
        .diffFileContents(path, newRev, fd.name)
        .then((contents) => ({ name: fd.name, contents, cacheKey: `${loadKey}:new:${fd.name}` }))
      // A pure rename has no old side to show beyond the name.
      if (fd.type === "new" || fd.type === "rename-pure") return { oldFile: null, newFile: await newFile }
      const oldName = fd.prevName ?? fd.name
      const oldFile = api
        .diffFileContents(path, oldRev, oldName)
        .then((contents) => ({ name: oldName, contents, cacheKey: `${loadKey}:old:${oldName}` }))
      const [o, n] = await Promise.all([oldFile, newFile])
      return { oldFile: o, newFile: n }
    },
    [path, oldRev, newRev, loadKey],
  )

  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      <Virtualizer className={DIFF_SCROLLER_CLASS} style={{ height, overflow: "auto" }}>
        {files.map((f) => {
          const isOpen = open[f.path] ?? !f.autoCollapse
          const lit = f.path === highlighted
          return (
            <Box
              key={f.path}
              id={fileAnchorId(f.path)}
              data-diff-file={f.path}
              data-highlighted={lit || undefined}
              mb="sm"
              style={{
                borderRadius: 6,
                outline: lit ? "2px solid var(--mantine-color-blue-filled)" : undefined,
                outlineOffset: -2,
              }}
              // The whole file header toggles the fold, like the chevron.
              // pierre has no header click callback, and the header lives in
              // its shadow DOM, so listen here: a click inside the shadow root
              // reaches React retargeted to pierre's host, with the real path
              // still in composedPath(). React's own delegation means nothing
              // to attach or detach as pierre re-renders. The chevron and the
              // editor icon stop their clicks before they get here.
              onClick={f.binary ? undefined : (e) => {
                if (isHeaderClick(e.nativeEvent)) setOpen(f.path, !isOpen)
              }}
            >
              {f.binary ? (
                <BinaryPlaceholder file={f} path={path} />
              ) : (
                <CommentableFileDiff
                  file={f}
                  open={isOpen}
                  onToggle={() => setOpen(f.path, !isOpen)}
                  mode={mode}
                  path={path}
                  loadDiffFiles={loadDiffFiles}
                  comments={placed}
                  pending={pending}
                  onStartComment={startComment}
                  onPendingDone={onPendingDone}
                  view={view}
                />
              )}
            </Box>
          )
        })}
      </Virtualizer>
    </WorkerPoolContextProvider>
  )
}

/**
 * One file's pierre diff with its review comments. The options and
 * annotations are memoised, as pierre redraws when either changes and the
 * comment list is polled.
 */
function CommentableFileDiff({
  file: f,
  open,
  onToggle,
  mode,
  path,
  loadDiffFiles,
  comments,
  pending,
  onStartComment,
  onPendingDone,
  view,
}: {
  file: DiffFile
  open: boolean
  onToggle: () => void
  mode: DiffMode
  path: string
  loadDiffFiles: (fd: FileDiffMetadata) => Promise<FileDiffLoadedFiles>
  comments: ReviewCommentItem[]
  pending: CommentTarget | null
  onStartComment: (t: CommentTarget) => void
  onPendingDone: () => void
  view: CommentView
}) {
  const { meta } = f
  const { annotations, expand } = useMemo(() => {
    // The old side is named as it was before a rename.
    const fileOn = (side: CommentTarget["side"]) => (side === "old" ? (meta.prevName ?? meta.name) : meta.name)
    const groups = new Map<string, DiffLineAnnotation<CommentAnnotation>>()
    const at = (side: CommentTarget["side"], line: number) => {
      const key = `${side}:${line}`
      let a = groups.get(key)
      if (!a) {
        a = { side: pierreSide(side), lineNumber: line, metadata: { items: [] } }
        groups.set(key, a)
      }
      return a.metadata
    }
    let expand = false
    for (const c of comments) {
      if (c.file !== fileOn(c.side)) continue
      const start = c.view?.start_line ?? c.start_line
      const end = c.view?.end_line ?? c.end_line
      at(c.side, end).items.push(c)
      // Lines outside every hunk are folded away, and the comment with them.
      if (!lineInHunks(meta, c.side, start) || !lineInHunks(meta, c.side, end)) expand = true
    }
    if (pending && pending.file === fileOn(pending.side)) at(pending.side, pending.end).pending = pending
    return { annotations: [...groups.values()], expand }
  }, [meta, comments, pending])

  const onGutterUtilityClick = useCallback(
    (range: SelectedLineRange) => {
      const t = toCommentTarget(f, range)
      if (t) onStartComment(t)
    },
    [f, onStartComment],
  )
  const options = useMemo(
    () => ({
      diffStyle: mode,
      themeType: "dark" as const,
      stickyHeader: true,
      collapsed: !open,
      expansionLineCount: 20,
      expandUnchanged: expand,
      loadDiffFiles,
      unsafeCSS: HEADER_CSS,
      enableGutterUtility: true,
      onGutterUtilityClick,
    }),
    [mode, open, expand, loadDiffFiles, onGutterUtilityClick],
  )

  return (
    <FileDiff<CommentAnnotation>
      fileDiff={meta}
      options={options}
      lineAnnotations={annotations}
      renderAnnotation={({ metadata: { items, pending: target } }) => (
        <Stack gap={4} p={4}>
          {items.map((c) => (
            <ReviewCommentCard
              key={c.id}
              path={path}
              comment={c}
              variant="inline"
              viewKey={`${view.oldRev}..${view.newRev}`}
            />
          ))}
          {target && (
            <NewCommentCard
              // A new target is a new comment, with an empty editor.
              key={`${target.side}:${target.start}-${target.end}`}
              path={path}
              target={target}
              view={view}
              onDone={onPendingDone}
            />
          )}
        </Stack>
      )}
      renderHeaderPrefix={() => <FoldToggle file={f} open={open} onToggle={onToggle} />}
      renderHeaderFilenameSuffix={() => <EditorIcon file={f} path={path} />}
    />
  )
}

// pierre's header is inside its shadow root, out of reach of page styles;
// unsafeCSS is its supported way in.
const HEADER_CSS = "[data-diffs-header] { cursor: pointer; }"

/** Whether a click landed on a pierre file header (any part of it). */
function isHeaderClick(e: MouseEvent): boolean {
  return e.composedPath().some((n) => n instanceof Element && n.hasAttribute("data-diffs-header"))
}

/**
 * The fold chevron, ahead of pierre's file icon and name. It stops its click,
 * which would otherwise also reach the header's own toggle and undo it.
 */
function FoldToggle({ file, open, onToggle }: { file: DiffFile; open: boolean; onToggle: () => void }) {
  return (
    <ActionIcon
      size="sm"
      variant="subtle"
      color="gray"
      aria-label={open ? `Collapse ${file.path}` : `Expand ${file.path}`}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
    </ActionIcon>
  )
}

/**
 * Open in editor, right after the file's name as in the Code tab's list. Its
 * click is stopped too, so opening the file doesn't also fold it.
 */
function EditorIcon({ file, path }: { file: DiffFile; path: string }) {
  return (
    <span style={{ display: "inline-flex", marginLeft: 4 }} onClick={(e) => e.stopPropagation()}>
      <OpenFileInEditorIcon path={path} file={file.path} disabled={file.type === "deleted"} />
    </span>
  )
}

/** A binary file: no lines to show, so a row in place of the diff. */
function BinaryPlaceholder({ file, path }: { file: DiffFile; path: string }) {
  return (
    <Group
      gap="xs"
      wrap="nowrap"
      px="xs"
      py={8}
      style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 6 }}
    >
      {/* Where the chevron sits on the other files, so the names line up. */}
      <Box style={{ width: 22, flexShrink: 0 }} />
      <Text size="sm" ff="monospace" truncate style={{ minWidth: 0 }}>
        {file.prevPath ? `${file.prevPath} → ${file.path}` : file.path}
      </Text>
      <EditorIcon file={file} path={path} />
      <Text size="xs" c="dimmed" ml="auto" style={{ flexShrink: 0 }}>
        {file.type === "new" ? "Binary file added" : file.type === "deleted" ? "Binary file deleted" : "Binary file changed"}
      </Text>
    </Group>
  )
}
