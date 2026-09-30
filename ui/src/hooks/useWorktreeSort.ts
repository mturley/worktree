import { useEffect, useState } from "react"
import { useCmux } from "../api/cmux"
import { resolveSortMode, type SortDir, type SortMode } from "../lib/worktreeSort"
import { SORT_PREF_KEYS, readCreatedDir, readSortMode, writeCreatedDir, writeSortMode } from "../lib/worktreeSortPref"

export interface WorktreeSort {
  /** The mode to apply, or null while it depends on a cmux answer not yet in. */
  mode: SortMode | null
  createdDir: SortDir
  cmuxAvailable: boolean
  setMode: (mode: SortMode) => void
  setCreatedDir: (dir: SortDir) => void
}

/**
 * The home page's worktree sort choice: remembered per browser and kept in
 * step across its open tabs, with a default that depends on whether cmux is
 * reachable. See resolveSortMode for how a saved "cmux" behaves when it is
 * not.
 */
export function useWorktreeSort(): WorktreeSort {
  const cmux = useCmux()
  const [saved, setSaved] = useState<SortMode | null>(readSortMode)
  const [createdDir, setDir] = useState<SortDir>(readCreatedDir)
  const cmuxAvailable = cmux.data?.available === true

  // A change in another tab arrives only as a storage event — the browser
  // never fires one in the tab that wrote. Re-read rather than trusting
  // newValue, so the same validation applies. A null key means the other
  // tab cleared storage outright.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && !SORT_PREF_KEYS.includes(e.key)) return
      setSaved(readSortMode())
      setDir(readCreatedDir())
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

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
