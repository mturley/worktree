import { useCallback } from "react"
import { useLocation, useSearch } from "wouter"

/**
 * Whether the diff view is open, in the URL as `?diff` (and `&file=<path>`),
 * beside whatever else is there (`q`, `resource`). `enter` pushes a history
 * entry so back closes the view.
 */
export function useDiffView(): {
  open: boolean
  file: string | null
  enter: (file?: string) => void
  /** Closes the view; `set` params are written in the same navigation (see below). */
  leave: (set?: Record<string, string>, drop?: readonly string[]) => void
} {
  const search = useSearch()
  const [location, navigate] = useLocation()
  const params = new URLSearchParams(search)
  const open = params.has("diff")
  const file = open ? params.get("file") : null

  const go = useCallback(
    (p: URLSearchParams) => {
      // URLSearchParams writes a valueless param as "diff=" and spaces as "+".
      const qs = p.toString().replace(/(^|&)diff=(?=&|$)/, "$1diff").replace(/\+/g, "%20")
      navigate(qs ? `${location}?${qs}` : location)
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
      for (const k of drop ?? []) p.delete(k)
      for (const [k, v] of Object.entries(set ?? {})) p.set(k, v)
      go(p)
    },
    [search, go],
  )

  return { open, file, enter, leave }
}
