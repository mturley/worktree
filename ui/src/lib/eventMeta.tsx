import {
  IconAlertTriangle,
  IconBell,
  IconCheck,
  IconEye,
  IconGitCommit,
  IconGitMerge,
  IconGitPullRequestClosed,
  IconMessage,
  IconTag,
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
}

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

  return { color: "gray", Icon: IconGitCommit, label: type || "event" }
}

export function eventMeta(type: string): EventMeta {
  const { color, Icon, label } = entryFor(type)
  return {
    color,
    shade: DEFAULT_SHADE,
    cssColor: `var(--mantine-color-${color}-${DEFAULT_SHADE})`,
    Icon,
    label,
  }
}
