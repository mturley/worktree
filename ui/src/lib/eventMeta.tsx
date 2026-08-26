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
 * One mapping from an event type to its colour and icon, shared by every
 * surface that shows an event — the timeline dots today, badges or filters
 * later — so they cannot drift apart. Same role resourceStatusMeta plays for
 * resource status icons.
 *
 * Two axes, per the Phase F decision:
 *   hue   = where the event came from (github / jira / slack / watcher)
 *   shade = what kind of thing happened
 *
 * Shade runs BRIGHTER as significance rises, because the UI is dark-only: a
 * merge or a failed build should catch the eye more than another comment.
 * Mantine palettes run 0 (lightest) to 9 (darkest), so the brighter end is
 * the lower index.
 */
export type EventKind = "comment" | "activity" | "status"

const SHADE: Record<EventKind, number> = {
  comment: 7, // chatter — present but recessive
  activity: 5, // someone did something to the resource
  status: 3, // the resource changed state — the loudest
}

type IconComponent = typeof IconMessage

export interface EventMeta {
  /** Mantine colour name, from the event's source. */
  hue: string
  kind: EventKind
  /** Resolved CSS colour, hue + shade. */
  color: string
  Icon: IconComponent
  /** Human-readable, for tooltips and aria labels. */
  label: string
}

function hueFor(type: string): string {
  if (type.startsWith("jira_")) return "blue"
  if (type.startsWith("slack_")) return "grape"
  if (type.startsWith("watch")) return "gray"
  // pr_* and ci_* are both GitHub.
  return "indigo"
}

function kindAndIcon(type: string): { kind: EventKind; Icon: IconComponent; label: string } {
  switch (type) {
    // --- comments -------------------------------------------------------
    case "pr_comment":
    case "pr_review_comment":
    case "jira_comment":
    case "slack_reply":
      return { kind: "comment", Icon: IconMessage, label: "comment" }

    // --- activity -------------------------------------------------------
    case "pr_review_requested":
      return { kind: "activity", Icon: IconEye, label: "review requested" }
    case "pr_new_commits":
      return { kind: "activity", Icon: IconGitCommit, label: "new commits" }
    case "jira_assigned":
      return { kind: "activity", Icon: IconUserCheck, label: "assigned" }
    case "jira_labels_changed":
      return { kind: "activity", Icon: IconTag, label: "labels changed" }
    case "jira_description_changed":
      return { kind: "activity", Icon: IconGitCommit, label: "description changed" }

    // --- status ---------------------------------------------------------
    case "pr_approved":
      return { kind: "status", Icon: IconCheck, label: "approved" }
    case "pr_merged":
      return { kind: "status", Icon: IconGitMerge, label: "merged" }
    case "pr_closed":
      return { kind: "status", Icon: IconGitPullRequestClosed, label: "closed" }
    case "pr_reopened":
      return { kind: "status", Icon: IconGitCommit, label: "reopened" }
    case "jira_status_change":
      return { kind: "status", Icon: IconCheck, label: "status changed" }
    case "watcher_error":
      return { kind: "status", Icon: IconAlertTriangle, label: "watcher error" }
    case "watch_started":
      return { kind: "activity", Icon: IconBell, label: "watch started" }
  }

  // CI covers many variants (ci_passed, ci_workflows_partial_failure, …).
  // Matching on substrings keeps new library variants working without a
  // release here: an unmapped ci_* still lands in the right family.
  if (type.startsWith("ci_")) {
    if (type.includes("fail")) return { kind: "status", Icon: IconX, label: "CI failed" }
    if (type.includes("pending")) return { kind: "activity", Icon: IconGitCommit, label: "CI pending" }
    if (type.includes("pass")) return { kind: "status", Icon: IconCheck, label: "CI passed" }
    return { kind: "status", Icon: IconCheck, label: "CI" }
  }

  return { kind: "activity", Icon: IconGitCommit, label: type || "event" }
}

export function eventMeta(type: string): EventMeta {
  const hue = hueFor(type)
  const { kind, Icon, label } = kindAndIcon(type)
  return {
    hue,
    kind,
    color: `var(--mantine-color-${hue}-${SHADE[kind]})`,
    Icon,
    label,
  }
}
