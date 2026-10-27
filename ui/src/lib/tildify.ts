import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"

/**
 * `path` with `~` for the home directory, as the server shows paths
 * (tildify in internal/webui/worktree_info_api.go): only where home is the
 * whole path or a parent of it, so "/Users/me2" is not under "/Users/me".
 * An absent home leaves the path as is.
 */
export function tildify(path: string, home?: string): string {
  const h = home?.replace(/\/+$/, "")
  if (!h) return path
  if (path === h) return "~"
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path
}

/** The server's home directory, from the session query the app already holds. */
export function useHomeDir(): string | undefined {
  // The same key, function and staleness as useSession: never a second fetch.
  const q = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false, staleTime: Infinity })
  return q.data?.home
}
