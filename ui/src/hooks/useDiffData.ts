import { useQuery, type Query } from "@tanstack/react-query"
import { api } from "../api/client"
import type { DiffBase, DiffRange } from "../api/types"

// The fingerprint (from useWorktreeGit) is in each key so a commit, fetch or
// working-tree edit refetches; it is not sent to the server.
//
// Each refetch is a new key, so without placeholder data every poll that
// moves the fingerprint would blank the list to "Loading…". Keep showing the
// previous answer while the next loads, but only for the same worktree and
// base: another worktree's (or base's) list must never stand in.
function sameWorktreeAndBase(path: string, base: DiffBase) {
  return <T,>(prev: T | undefined, prevQuery: Query<T, Error, T, readonly unknown[]> | undefined) =>
    prevQuery && prevQuery.queryKey[1] === path && prevQuery.queryKey[2] === base ? prev : undefined
}

export function useDiffCommits(path: string, base: DiffBase, enabled: boolean, fingerprint: string | undefined) {
  return useQuery({
    queryKey: ["diff-commits", path, base, fingerprint],
    queryFn: () => api.diffCommits(path, base),
    placeholderData: sameWorktreeAndBase(path, base),
    enabled: enabled && !!path,
  })
}

export function useDiffFiles(
  path: string,
  base: DiffBase,
  range: DiffRange,
  enabled: boolean,
  fingerprint: string | undefined,
) {
  return useQuery({
    queryKey: ["diff-files", path, base, range, fingerprint],
    queryFn: () => api.diffFiles(path, base, range),
    placeholderData: sameWorktreeAndBase(path, base),
    enabled: enabled && !!path,
  })
}
