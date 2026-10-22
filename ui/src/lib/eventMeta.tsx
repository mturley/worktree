import {
  IconAlertTriangle,
  IconBell,
  IconCheck,
  IconChecklist,
  IconEye,
  IconGitCommit,
  IconGitMerge,
  IconGitPullRequestClosed,
  IconLink,
  IconLinkOff,
  IconMessage,
  IconPencil,
  IconProgress,
  IconSquare,
  IconSquareCheck,
  IconSquareMinus,
  IconSquarePlus,
  IconTag,
  IconTarget,
  IconTrash,
  IconUserCheck,
  IconX,
} from "@tabler/icons-react"

/**
 * One mapping from an event type to its colour, icon and label, shared by
 * every surface that shows an event — the timeline dots and the row's type
 * badge today, filters later — so they cannot drift apart. Same role
 * resourceStatusMeta plays for resource status icons.
 *
 * Colour is per EVENT TYPE, not derived from source or kind. An earlier
 * version encoded source as hue and kind as shade; in practice that made
 * everything from one source look alike, which is the opposite of what a
 * mixed feed needs — you scan for "what happened", and the icon already
 * carries the rest.
 */
export interface EventMeta {
  /** Mantine colour name — usable directly as a Badge/Text `color`. */
  color: string
  /** Palette index. 5 reads well on the dark-only background. */
  shade: number
  /** Resolved CSS colour, for surfaces that need a raw value (the dot). */
  cssColor: string
  Icon: IconComponent
  /** Human-readable fallback label, when the event carries no type_label. */
  label: string
}

type IconComponent = typeof IconMessage

interface Entry {
  color: string
  Icon: IconComponent
  label: string
  /**
   * A raw CSS colour that overrides the palette shade for cssColor. Only the
   * task events use it: their colour is the one task accent, a CSS variable
   * (--task-accent) that is not a Mantine palette entry. `color` keeps the
   * nearest palette name for the surfaces that can only take one.
   */
  cssColor?: string
}

/**
 * A task event: the task accent, whatever the type, so a task's history reads
 * as one thing in a mixed feed. The icon and label tell the kinds apart.
 * "lime" is the palette's nearest match to the accent (electric lime).
 */
const task = (Icon: IconComponent, label: string): Entry =>
  ({ color: "lime", cssColor: "var(--task-accent)", Icon, label })

/**
 * Per-type colours. Types that genuinely mean the same outcome share one
 * (every CI failure is red), but distinct events get distinct colours even
 * when they come from the same service.
 */
const TYPES: Record<string, Entry> = {
  // GitHub — pull requests
  pr_comment: { color: "blue", Icon: IconMessage, label: "comment" },
  pr_review_comment: { color: "cyan", Icon: IconMessage, label: "review comment" },
  pr_review_requested: { color: "yellow", Icon: IconEye, label: "review requested" },
  pr_approved: { color: "green", Icon: IconCheck, label: "approved" },
  pr_merged: { color: "violet", Icon: IconGitMerge, label: "merged" },
  pr_closed: { color: "red", Icon: IconGitPullRequestClosed, label: "closed" },
  pr_reopened: { color: "teal", Icon: IconGitCommit, label: "reopened" },
  pr_new_commits: { color: "indigo", Icon: IconGitCommit, label: "new commits" },

  // Jira
  jira_comment: { color: "pink", Icon: IconMessage, label: "comment" },
  jira_status_change: { color: "grape", Icon: IconCheck, label: "status changed" },
  jira_assigned: { color: "orange", Icon: IconUserCheck, label: "assigned" },
  jira_description_changed: { color: "gray", Icon: IconGitCommit, label: "description changed" },
  jira_labels_changed: { color: "lime", Icon: IconTag, label: "labels changed" },

  // Slack
  slack_reply: { color: "grape", Icon: IconMessage, label: "reply" },

  // Tasks — worktree's own task events (internal/tasks/events.go). These
  // labels are fallbacks: the server sends its own type_label.
  task_created: task(IconChecklist, "created"),
  task_edited: task(IconPencil, "edited"),
  task_state_changed: task(IconProgress, "state changed"),
  task_deleted: task(IconTrash, "deleted"),
  task_linked: task(IconLink, "linked"),
  task_unlinked: task(IconLinkOff, "unlinked"),
  task_focus_changed: task(IconTarget, "focus changed"),
  task_event_linked: task(IconLink, "event linked"),
  task_event_unlinked: task(IconLinkOff, "event unlinked"),
  subtask_added: task(IconSquarePlus, "subtask added"),
  subtask_edited: task(IconPencil, "subtask edited"),
  subtask_checked: task(IconSquareCheck, "subtask checked"),
  subtask_unchecked: task(IconSquare, "subtask unchecked"),
  subtask_removed: task(IconSquareMinus, "subtask removed"),

  // Watcher's own bookkeeping
  watch_started: { color: "gray", Icon: IconBell, label: "watch started" },
  watcher_error: { color: "red", Icon: IconAlertTriangle, label: "watcher error" },
}

const DEFAULT_SHADE = 5

function entryFor(type: string): Entry {
  const hit = TYPES[type]
  if (hit) return hit

  // CI covers many variants (ci_passed, ci_check_failed,
  // ci_workflows_partial_failure…) and the library may add more. Matching on
  // substrings keeps a new variant coloured correctly without a release here.
  if (type.startsWith("ci_")) {
    if (type.includes("fail")) return { color: "red", Icon: IconX, label: "CI failed" }
    if (type.includes("pending")) return { color: "gray", Icon: IconGitCommit, label: "CI pending" }
    if (type.includes("pass")) return { color: "green", Icon: IconCheck, label: "CI passed" }
    return { color: "gray", Icon: IconCheck, label: "CI" }
  }

  // A task event type newer than this file (blockers, say) still reads as
  // task activity rather than as an anonymous grey event.
  if (type.startsWith("task_") || type.startsWith("subtask_")) {
    return task(IconChecklist, type.replace(/_/g, " "))
  }

  return { color: "gray", Icon: IconGitCommit, label: type || "event" }
}

/**
 * The label shown for an event: the library's own display name when it has
 * one, else this file's readable fallback — capitalised either way.
 *
 * Capitalising here rather than at each call site keeps the dot's tooltip and
 * the details modal's heading identical; they read the same events and looked
 * inconsistent when only one of them was title-cased. Already-capitalised
 * labels ("CI failed", "PR comments") pass through untouched.
 */
export function eventLabel(type: string, typeLabel?: string): string {
  const raw = typeLabel || eventMeta(type).label
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw
}

export function eventMeta(type: string): EventMeta {
  const { color, Icon, label, cssColor } = entryFor(type)
  return {
    color,
    shade: DEFAULT_SHADE,
    cssColor: cssColor ?? `var(--mantine-color-${color}-${DEFAULT_SHADE})`,
    Icon,
    label,
  }
}
