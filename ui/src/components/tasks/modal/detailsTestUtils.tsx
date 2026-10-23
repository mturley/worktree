import type { ReactNode } from "react"
import { render } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { Notifications } from "@mantine/notifications"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { TaskDetail } from "../../../api/types"
import { taskDetailKey, useTaskDetail } from "../../../hooks/useTaskDetail"
import { TaskModalProvider } from "./TaskModalProvider"

/** Test-only helpers for the Details tab's section tests. */

export const detail = (extra: Partial<TaskDetail> = {}): TaskDetail => ({
  id: 1, ref: "T1", title: "task 1", description: "", state: "not_started", priority: "none", starred: false,
  rank: "r", created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-21T00:00:00Z", archived: false,
  links: [], implicit_worktrees: [], subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, blocker_labels: [],
  detail_links: [], implicit: [], subtasks: [], event_links: [], blockers: [], blocks: [], ...extra,
})

function Live({ id, children }: { id: number; children: (t: TaskDetail) => ReactNode }) {
  const q = useTaskDetail(id)
  return q.data ? <>{children(q.data)}</> : null
}

/**
 * Renders `ui` against the task detail held in the query cache, as the modal
 * does: a mutation's response lands in the cache and re-renders it. Inside a
 * TaskModalProvider, so sections that open another task can, with
 * Notifications, so a section's toasts (an undo) render.
 */
export function renderDetail(initial: TaskDetail, ui: (t: TaskDetail) => ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(taskDetailKey(initial.id), initial)
  const utils = render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider client={qc}>
        <TaskModalProvider>
          <Live id={initial.id}>{ui}</Live>
        </TaskModalProvider>
      </QueryClientProvider>
    </MantineProvider>,
  )
  return { ...utils, qc }
}

/**
 * Stubs layout for keyboard drags: every `rowSel` element is a 40px row,
 * stacked in document order, and every `dropSel` element spans the rows it
 * contains. dnd-kit measures nothing else that matters here.
 */
export function stubRowLayout(rowSel: string, dropSel: string, overlaySel?: string) {
  const ROW = 40
  const rect = (top: number, height: number) =>
    ({ x: 0, y: top, top, left: 0, width: 300, height, right: 300, bottom: top + height, toJSON: () => ({}) }) as DOMRect
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>(rowSel))
  return function (this: Element) {
    const all = rows()
    if (this.matches(rowSel)) return rect(all.indexOf(this as HTMLElement) * ROW, ROW)
    if (this.matches(dropSel)) {
      const inner = all.filter((l) => this.contains(l))
      if (inner.length === 0) return rect(0, 0)
      return rect(all.indexOf(inner[0]) * ROW, inner.length * ROW)
    }
    if (overlaySel && this.matches(overlaySel)) return rect(0, ROW)
    return rect(0, 0)
  }
}
