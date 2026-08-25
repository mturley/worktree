import { useState } from "react"
import { Alert, Code, Stack, Text } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { useThread } from "../hooks/useThread"
import { defaultTabName, type Tab } from "../state/tabs"
import { ResourceCard } from "./ResourceCard"
import { ThreadView } from "./slack/ThreadView"

interface SlackThreadPaneProps {
  resource: ResourceDTO
  /** Worktree path, needed by the remove control in the thread header. */
  path: string
  /** Refetch resources after the thread is removed. */
  onRemoved?: () => void
  /** Refetch the worktree's resources after a custom name/description save. */
  onResourceChanged?: () => void
}

/**
 * Turns a slack resource into the `Tab` shape the ported Slack UI
 * (useThread/ThreadView) expects. A slack resource id is `<channel>:<ts>`,
 * so the split is on the first colon — the thread ts itself contains a dot,
 * never a colon.
 */
export function slackTabFromResource(r: ResourceDTO): Tab {
  const idx = r.id.indexOf(":")
  const channel = idx > 0 ? r.id.slice(0, idx) : r.id
  const threadTs = idx > 0 ? r.id.slice(idx + 1) : ""
  return {
    id: r.id,
    channel,
    threadTs,
    name: r.custom_name || defaultTabName(channel, threadTs),
    description: r.custom_description || "",
  }
}

/**
 * True when a thread fetch failed because Slack isn't configured (the backend
 * returns 503). Distinguishes "run setup" from a real per-thread load error,
 * so the user isn't told to retry something that needs configuration.
 */
function isNotConfigured(error: string | undefined): boolean {
  return !!error && error.includes("503")
}

/**
 * The selected-resource pane's Slack branch: renders the thread itself where
 * a PR/Jira resource would show its filtered activity feed. There is
 * deliberately no resource summary card above it — ThreadView already has its
 * own title/description header, so a card would be duplicate chrome.
 */
export function SlackThreadPane({ resource, path, onRemoved, onResourceChanged }: SlackThreadPaneProps) {
  // Surfaces a failed "save thread details" write: the modal closes on submit,
  // so a rejected write would otherwise vanish and look like success.
  const [saveError, setSaveError] = useState<string | null>(null)
  const tab = slackTabFromResource(resource)
  const thread = useThread(tab)

  if (isNotConfigured(thread.error)) {
    return (
      <Alert color="yellow" variant="light" title="Slack not configured">
        <Text size="sm">
          Run <Code>worktree setup</Code> to enable Slack.
        </Text>
      </Alert>
    )
  }

  return (
    <Stack gap="sm">
      {saveError ? (
        <Alert
          color="red"
          variant="light"
          title="Couldn't save thread details"
          withCloseButton
          onClose={() => setSaveError(null)}
        >
          <Text size="sm">{saveError}</Text>
        </Alert>
      ) : null}
      {/*
        The same detail card heads every resource type. ThreadView used to
        carry its own header block plus a headerAction slot; needing that slot
        a second time was the signal the seam belonged here instead.
      */}
      <ResourceCard
        r={resource}
        path={path}
        onRemoved={onRemoved}
        variant="detail"
        onMetaChanged={() => onResourceChanged?.()}
      />
      <ThreadView
        tab={tab}
        thread={thread}
        onOpenThread={(url, opts) => {
          window.open(url, opts.background ? "_blank" : "_self", "noreferrer")
        }}
      />
    </Stack>
  )
}
