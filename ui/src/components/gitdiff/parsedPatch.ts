import { parsePatchFiles, type ChangeTypes, type FileDiffMetadata } from "@pierre/diffs"

/** One file of a loaded patch, with what the tree, toolbar and body need. */
export interface DiffFile {
  meta: FileDiffMetadata
  path: string
  prevPath?: string
  type: ChangeTypes
  additions: number
  deletions: number
  binary: boolean
  /** Starts folded: a lockfile, or too big to want open by default. */
  autoCollapse: boolean
}

// Generated files nobody reads line by line.
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "Cargo.lock"])
// Past this many changed lines a file is more likely generated or vendored
// than something to read in place; it can still be opened.
const COLLAPSE_OVER = 1500

const BINARY = /^(Binary files .* differ|GIT binary patch)$/m

/**
 * Splits a multi-file git patch into its files. `cacheKey` prefixes pierre's
 * per-file highlight cache keys, so it must change whenever the content can
 * (see DiffView) or the worker would serve a stale highlight.
 *
 * pierre leaves a binary file as an empty, hunkless diff, so binaries are
 * found here from git's own marker line. Each file of the patch starts with
 * a `diff --git` line and pierre returns them in order, so the n-th chunk is
 * the n-th file.
 */
export function parseDiff(patch: string, cacheKey: string): DiffFile[] {
  if (!patch.trim()) return []
  const metas = parsePatchFiles(patch, cacheKey).flatMap((p) => p.files)
  const chunks = patch.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "))
  const aligned = chunks.length === metas.length
  return metas.map((meta, i) => {
    let additions = 0
    let deletions = 0
    for (const h of meta.hunks) {
      additions += h.additionLines
      deletions += h.deletionLines
    }
    const base = meta.name.slice(meta.name.lastIndexOf("/") + 1)
    return {
      meta,
      path: meta.name,
      prevPath: meta.prevName,
      type: meta.type,
      additions,
      deletions,
      binary: aligned && BINARY.test(chunks[i]),
      autoCollapse: LOCKFILES.has(base) || additions + deletions > COLLAPSE_OVER,
    }
  })
}

/** The DOM id of a file's wrapper in the diff body, for scrollIntoView. */
export function fileAnchorId(path: string): string {
  return `diff-file-${encodeURIComponent(path)}`
}
