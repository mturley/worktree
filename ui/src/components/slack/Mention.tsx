import { createContext, useContext, type ReactNode } from "react"
import type { UserGroup } from "../../api/slackApi"

/**
 * A Slack-style mention pill: dark blue background, light blue text.
 *
 * Shared by BOTH render paths — `RichText` (typed rich_text blocks, the
 * primary path) and `lib/mrkdwn.tsx` (the mrkdwn-string fallback) — so a
 * mention looks identical however the message reached us. Put the styling
 * here rather than at the call sites; duplicating it is how the two paths
 * drift apart.
 *
 * The colours are deliberately scheme-independent: Slack renders mentions as
 * a blue chip regardless, and the app defaults to dark. If this ever needs to
 * follow the Mantine colour scheme, this is the single place to change.
 */
/**
 * The workspace's user-group directory, keyed by subteam id.
 *
 * Supplied via context rather than threaded as a prop because the mention
 * renderers (`renderAngleToken`, `renderElement`) are plain functions several
 * layers deep, not components — passing a groups argument through all of them
 * would mean churning every signature and call site for one leaf lookup.
 */
export const SlackGroupsContext = createContext<Record<string, UserGroup>>({})

/** Resolves a subteam id to what Slack shows: its handle, then its name. */
export function useGroupLabel(groupId: string | undefined): string | undefined {
  const groups = useContext(SlackGroupsContext)
  if (!groupId) return undefined
  const g = groups[groupId]
  return g?.Handle || g?.Name || undefined
}

export function Mention({ children, groupId }: { children?: ReactNode; groupId?: string }) {
  const groupLabel = useGroupLabel(groupId)
  // A resolved group wins; otherwise fall back to whatever the caller passed
  // (typically the bare id) — never a generic word.
  const label = groupLabel ? `@${groupLabel}` : children
  return (
    <span
      data-slack-mention="true"
      style={{
        backgroundColor: "var(--mantine-color-blue-9)",
        color: "var(--mantine-color-blue-2)",
        borderRadius: "3px",
        padding: "0 2px",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  )
}
