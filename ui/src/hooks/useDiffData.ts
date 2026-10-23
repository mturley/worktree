import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
import type { DiffBase, DiffRange } from "../api/types"

// The fingerprint (from useWorktreeGit) is in each key so a commit, fetch or
// working-tree edit refetches; it is not sent to the server.

export function useDiffCommits(path: string, base: DiffBase, enabled: boolean, fingerprint: string | undefined) {
  return useQuery({
    queryKey: ["diff-commits", path, base, fingerprint],
    queryFn: () => api.diffCommits(path, base),
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
    enabled: enabled && !!path,
  })
}
