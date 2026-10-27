import type { CSSProperties } from "react"

/**
 * A filled Mantine Button in the task accent (lime, dark text), for the
 * actions that make a task ("＋ task", "Make task"), so they read as part of
 * the tasks view. Mantine sets its button colours as inline CSS variables, so
 * these go in `style` (a class would lose to them). Use with variant="filled".
 */
export const TASK_BUTTON_STYLE = {
  "--button-bg": "var(--task-accent)",
  "--button-hover": "color-mix(in srgb, var(--task-accent) 85%, var(--mantine-color-dark-9))",
  "--button-color": "var(--mantine-color-dark-9)",
} as CSSProperties
