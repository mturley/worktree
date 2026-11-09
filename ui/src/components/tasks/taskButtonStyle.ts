import type { CSSProperties } from "react"

/**
 * A light Mantine Button in the task accent (lime text on a faint lime
 * tint), for the actions that make a task ("＋ Task", "Make task"), so they
 * read as part of the tasks view without the weight of a filled button
 * (solid fills are kept for unread actions). Mantine sets its button colours
 * as inline CSS variables, so these go in `style` (a class would lose to
 * them). Use with variant="light".
 */
export const TASK_BUTTON_STYLE = {
  "--button-bg": "color-mix(in srgb, var(--task-accent) 15%, transparent)",
  "--button-hover": "color-mix(in srgb, var(--task-accent) 25%, transparent)",
  "--button-color": "var(--task-accent)",
} as CSSProperties

/** The same for a light Mantine ActionIcon (the Slack message's "make task" icon). */
export const TASK_ICON_STYLE = {
  "--ai-bg": "color-mix(in srgb, var(--task-accent) 15%, transparent)",
  "--ai-hover": "color-mix(in srgb, var(--task-accent) 25%, transparent)",
  "--ai-color": "var(--task-accent)",
} as CSSProperties
