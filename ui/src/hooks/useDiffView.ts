import { useCallback } from "react"
import { useLocation, useSearch } from "wouter"

/**
 * Whether the diff view is open, in the URL as `?diff` (and `&file=<path>`,
 * `&prcomment=<id>`), beside whatever else is there (`q`, `resource`).
 * `enter` pushes a history entry so back closes the view.
 */
export function useDiffView(): {
  open: boolean
  file: string | null
  enter: (file?: string) => void
  /** Closes the view; `set` params are written in the same navigation (see below). */
  leave: (set?: Record<string, string>, drop?: readonly string[]) => void
  /** A PR comment to go to on entry (the activity modal's "Go to comment in diff view"). */
  prComment: number | null
  /** Drops `prcomment` once handled, replacing the history entry; the view stays open. */
  dropPRComment: () => void
} {
  const search = useSearch()
  const [location, navigate] = useLocation()
  const params = new URLSearchParams(search)
  const open = params.has("diff")
  const file = open ? params.get("file") : null
  const rawPR = open ? params.get("prcomment") : null
  const prNum = rawPR === null ? NaN : Number(rawPR)
  const prComment = Number.isInteger(prNum) && prNum > 0 ? prNum : null

  const go = useCallback(
    (p: URLSearchParams, replace = false) => {
      // URLSearchParams writes a valueless param as "diff=" and spaces as "+".
      const qs = p.toString().replace(/(^|&)diff=(?=&|$)/, "$1diff").replace(/\+/g, "%20")
      navigate(qs ? `${location}?${qs}` : location, { replace })
    },
    [location, navigate],
  )

  const enter = useCallback(
    (f?: string) => {
      const p = new URLSearchParams(search)
      p.set("diff", "")
      if (f === undefined) p.delete("file")
      else p.set("file", f)
      go(p)
    },
    [search, go],
  )
  // Each navigation here rebuilds the URL from this render's params, so a
  // second write in the same tick (the search box's setQ after leave) would
  // drop the first: `set` and `drop` let the caller leave and write in one step.
  const leave = useCallback(
    (set?: Record<string, string>, drop?: readonly string[]) => {
      const p = new URLSearchParams(search)
      p.delete("diff")
      p.delete("file")
      p.delete("prcomment")
      for (const k of drop ?? []) p.delete(k)
      for (const [k, v] of Object.entries(set ?? {})) p.set(k, v)
      go(p)
    },
    [search, go],
  )

  const dropPRComment = useCallback(() => {
    const p = new URLSearchParams(search)
    if (!p.has("prcomment")) return
    p.delete("prcomment")
    go(p, true)
  }, [search, go])

  return { open, file, enter, leave, prComment, dropPRComment }
}
