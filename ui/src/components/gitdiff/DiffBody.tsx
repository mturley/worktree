/// <reference types="vite/client" />
import { useCallback, useEffect, useState } from "react"
import { ActionIcon, Box, Group, Text } from "@mantine/core"
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react"
import type { FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs"
import { FileDiff, Virtualizer, WorkerPoolContextProvider } from "@pierre/diffs/react"
// The PORTABLE worker: the plain worker.js fails under Vite with
// `Theme "pierre-dark" has not been resolved` (spike finding), and for the
// same reason no `theme` is passed below, only `themeType`.
import DiffsWorker from "@pierre/diffs/worker/worker-portable.js?worker"
import { api } from "../../api/client"
import { OpenFileInEditorIcon } from "./OpenFileInEditorIcon"
import { fileAnchorId, type DiffFile } from "./parsedPatch"

export type DiffMode = "split" | "unified"

const poolOptions = { workerFactory: () => new DiffsWorker() }
const highlighterOptions = {}

/**
 * The diff view's body: one pierre `FileDiff` per file inside pierre's
 * `Virtualizer`, which is its own scroll container and so is given an
 * explicit height. Each file sits in a wrapper with a stable id
 * (`fileAnchorId`) for `scrollIntoView`; pierre renders in shadow DOM, so the
 * wrappers are also what tests and the rest of the page can see.
 *
 * `oldRev`/`newRev` are the resolved revisions the patch was computed
 * between; expanding unchanged lines fetches both sides at exactly those,
 * so it keeps working while the view is stale.
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
      <Virtualizer style={{ height, overflow: "auto" }}>
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
            >
              {f.binary ? (
                <BinaryPlaceholder file={f} path={path} />
              ) : (
                <FileDiff
                  fileDiff={f.meta}
                  options={{
                    diffStyle: mode,
                    themeType: "dark",
                    stickyHeader: true,
                    collapsed: !isOpen,
                    expansionLineCount: 20,
                    loadDiffFiles,
                  }}
                  renderHeaderPrefix={() => (
                    <HeaderPrefix file={f} path={path} open={isOpen} onToggle={() => setOpen(f.path, !isOpen)} />
                  )}
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
 * A fixed-width column ahead of pierre's file icon and name, so the chevrons
 * and editor icons line up down the page whatever the file's name.
 */
function HeaderPrefix({
  file,
  path,
  open,
  onToggle,
}: {
  file: DiffFile
  path: string
  open: boolean
  onToggle?: () => void
}) {
  return (
    <Group gap={2} wrap="nowrap" style={{ width: 52, flexShrink: 0 }}>
      {onToggle ? (
        <ActionIcon size="sm" variant="subtle" color="gray" aria-label={open ? `Collapse ${file.path}` : `Expand ${file.path}`} onClick={onToggle}>
          {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        </ActionIcon>
      ) : (
        <Box style={{ width: 22 }} />
      )}
      <OpenFileInEditorIcon path={path} file={file.path} disabled={file.type === "deleted"} />
    </Group>
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
      <HeaderPrefix file={file} path={path} open={false} />
      <Text size="sm" ff="monospace" truncate style={{ flex: 1, minWidth: 0 }}>
        {file.prevPath ? `${file.prevPath} → ${file.path}` : file.path}
      </Text>
      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
        {file.type === "new" ? "Binary file added" : file.type === "deleted" ? "Binary file deleted" : "Binary file changed"}
      </Text>
    </Group>
  )
}
