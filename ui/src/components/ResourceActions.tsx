import { useState } from "react"
import { Button, Tooltip } from "@mantine/core"
import type { ResourceDTO } from "../api/types"

const COPIED_FEEDBACK_MS = 1500

/** Names the destination for a resource type, e.g. "Open in GitHub". */
export function openInLabel(type: string): string {
  switch (type) {
    case "pr":
      return "Open in GitHub"
    case "jira":
      return "Open in Jira"
    case "slack":
      return "Open in Slack"
    default:
      return "Open"
  }
}

/**
 * "Open in <service>" paired with a copy-link button, mirroring the compound
 * control in the Slack thread's ActionBar so the two read the same.
 *
 * Lives on the detail card rather than the list cards: a list card is a
 * single click target for selection, and an inner link there is easy to hit
 * by accident when you meant to select.
 */
export function ResourceActions({ r }: { r: ResourceDTO }) {
  const [copied, setCopied] = useState(false)
  if (!r.url) return null

  const label = openInLabel(r.type)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(r.url)
      setCopied(true)
      setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    } catch {
      // Clipboard access can be denied; the open button still works, so
      // failing silently is better than an error state on a convenience.
    }
  }

  return (
    <Button.Group style={{ flexShrink: 0 }}>
      <Tooltip label={label}>
        <Button
          size="xs"
          variant="light"
          component="a"
          href={r.url}
          target="_blank"
          rel="noreferrer"
          // The detail card is not itself a click target, but keep this from
          // bubbling in case the card is ever made selectable.
          onClick={(e) => e.stopPropagation()}
          styles={{ root: { flexShrink: 0 }, label: { whiteSpace: "nowrap" } }}
        >
          {label}
        </Button>
      </Tooltip>
      <Tooltip label={copied ? "Copied!" : "Copy link"}>
        <Button
          size="xs"
          variant="light"
          px="xs"
          aria-label="Copy link"
          onClick={(e) => {
            e.stopPropagation()
            void handleCopy()
          }}
          styles={{ root: { flexShrink: 0 } }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </Button>
      </Tooltip>
    </Button.Group>
  )
}
