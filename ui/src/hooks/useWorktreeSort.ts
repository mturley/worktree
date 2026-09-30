import { useState } from "react"
import { useCmux } from "../api/cmux"
import { resolveSortMode, type SortDir, type SortMode } from "../lib/worktreeSort"
import { readCreatedDir, readSortMode, writeCreatedDir, writeSortMode } from "../lib/worktreeSortPref"

export interface WorktreeSort {
  /** The mode to apply, or null while it depends on a cmux answer not yet in. */
  mode: SortMode | null
  createdDir: SortDir
  cmuxAvailable: boolean
  setMode: (mode: SortMode) => void
  setCreatedDir: (dir: SortDir) => void
}

/**
 * The home page's worktree sort choice: remembered per browser, with a
 * default that depends on whether cmux is reachable. See resolveSortMode for
 * how a saved "cmux" behaves when it is not.
 */
export function useWorktreeSort(): WorktreeSort {
  const cmux = useCmux()
  const [saved, setSaved] = useState<SortMode | null>(readSortMode)
  const [createdDir, setDir] = useState<SortDir>(readCreatedDir)
  const cmuxAvailable = cmux.data?.available === true
  return {
    mode: resolveSortMode(saved, cmux.isPending, cmuxAvailable),
    createdDir,
    cmuxAvailable,
    setMode: (mode) => {
      writeSortMode(mode)
      setSaved(mode)
    },
    setCreatedDir: (dir) => {
      writeCreatedDir(dir)
      setDir(dir)
    },
  }
}
