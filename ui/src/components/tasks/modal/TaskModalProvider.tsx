import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react"
import { useLocation, useSearch } from "wouter"

const PARAM = "task"

export interface TaskModal {
  /** The task whose modal is open, from `?task=<id>`; null when none (or the param is malformed). */
  openId: number | null
  open(id: number): void
  close(): void
}

const Ctx = createContext<TaskModal | null>(null)

function parseId(raw: string | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n > 0 ? n : null
}

/**
 * The open task modal lives in the URL as `?task=<id>`, so it is linkable,
 * survives a refresh, and the browser's Back button closes it. Other params
 * (the selected resource, its tab, the home worktree) are preserved, the same
 * way useSelectedResource writes its param.
 */
export function TaskModalProvider({ children }: { children: ReactNode }) {
  const search = useSearch()
  const [location, navigate] = useLocation()
  const openId = parseId(new URLSearchParams(search).get(PARAM))

  const setParam = useCallback(
    (value: string | null) => {
      const params = new URLSearchParams(search)
      if (value === null) params.delete(PARAM)
      else params.set(PARAM, value)
      const qs = params.toString()
      navigate(qs ? `${location}?${qs}` : location)
    },
    [search, location, navigate],
  )

  const open = useCallback((id: number) => setParam(String(id)), [setParam])
  const close = useCallback(() => setParam(null), [setParam])
  const value = useMemo(() => ({ openId, open, close }), [openId, open, close])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Opens and closes the single task detail modal mounted in App. */
export function useTaskModal(): TaskModal {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useTaskModal must be used inside TaskModalProvider")
  return ctx
}
