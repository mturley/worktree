import { navigate } from "wouter/use-browser-location"
import type { NotificationMsg } from "../api/types"
import { serializeResourceKey } from "./resourceKey"
import { withHomeParam } from "./homeWorktree"

/** Where clicking a notification goes: the worktree, with the resource selected. */
export function notificationHref(msg: NotificationMsg): string {
  // A burst summary spanning several worktrees has no one worktree to open.
  if (!msg.worktree_path) return "/"
  const base = `/worktree/${encodeURIComponent(msg.worktree_path)}`
  if (!msg.resource_type) return base
  // A task notification opens the task modal over its worktree.
  if (msg.resource_type === "task") return `${base}?task=${encodeURIComponent(msg.resource_id)}`
  return `${base}?resource=${serializeResourceKey({ type: msg.resource_type, id: msg.resource_id })}`
}

/**
 * Shows msg as a browser notification. False when this browser can't
 * (no API, or permission not granted); the caller acks that so the server
 * tries another tab.
 */
export function showBrowserNotification(msg: NotificationMsg, onClick: () => void): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false
  const n = new Notification(msg.title, {
    body: [msg.subtitle, msg.body].filter(Boolean).join("\n"),
    tag: msg.tag,
    icon: "/favicon.svg",
  })
  n.onclick = () => {
    window.focus()
    onClick()
    n.close()
  }
  return true
}

/**
 * Brings the notification's worktree/resource/task up in this tab, unless it
 * already is.
 *
 * On the target's own worktree page, only the ONE param the target sets
 * (`resource` or `task`) is compared and written; the other is kept as it
 * is. A resource notification must not close an open task modal, and a task
 * notification opens its modal over the selected resource rather than
 * dropping the selection. A worktree-wide notification sets neither, so
 * being on that worktree at all is enough.
 */
export function openNotificationTarget(msg: NotificationMsg): void {
  const href = notificationHref(msg)
  const target = new URL(href, window.location.origin)
  const here = new URL(window.location.href)
  if (here.pathname !== target.pathname) {
    navigate(withHomeParam(href))
    return
  }
  const key = ["task", "resource"].find((k) => target.searchParams.has(k))
  if (!key) return
  const value = target.searchParams.get(key) ?? ""
  if (here.searchParams.get(key) === value) return
  here.searchParams.set(key, value)
  navigate(withHomeParam(here.pathname + here.search + here.hash))
}
