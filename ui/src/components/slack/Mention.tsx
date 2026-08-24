import type { ReactNode } from "react"

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
export function Mention({ children }: { children: ReactNode }) {
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
      {children}
    </span>
  )
}
