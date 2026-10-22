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

/** Brings the notification's worktree/resource up in this tab, unless it already is. */
export function openNotificationTarget(msg: NotificationMsg): void {
  const href = notificationHref(msg)
  const target = new URL(href, window.location.origin)
  const here = new URL(window.location.href)
  const sameResource =
    here.pathname === target.pathname &&
    ["resource", "task"].every((k) => (here.searchParams.get(k) ?? "") === (target.searchParams.get(k) ?? ""))
  if (!sameResource) navigate(withHomeParam(href))
}
