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
  leave: () => void
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
  const leave = useCallback(() => {
    const p = new URLSearchParams(search)
    p.delete("diff")
    p.delete("file")
    go(p)
  }, [search, go])

  return { open, file, enter, leave }
}
