import { useEffect, useState } from "react"
import { Alert, Code, Grid, NavLink, Stack, Text } from "@mantine/core"
import { useWorktreeSlackThreads, type SlackThreadRef } from "../hooks/useWorktreeSlackThreads"
import { useThread } from "../hooks/useThread"
import { ThreadView } from "./slack/ThreadView"
import { defaultTabName, type Tab } from "../state/tabs"

interface SlackTabProps {
  path: string
}

function threadRefToTab(ref: SlackThreadRef): Tab {
  return {
    id: ref.id,
    channel: ref.channel,
    threadTs: ref.threadTs,
    name: defaultTabName(ref.channel, ref.threadTs),
    description: "",
  }
}

/**
 * True when a thread fetch failed because Slack isn't configured (the backend
 * returns 503 "slack not configured"). Distinguishes the "run setup" case
 * from a real per-thread load error so we can show a friendlier notice.
 */
function isNotConfigured(error: string | undefined): boolean {
  return !!error && error.includes("503")
}

export function SlackTab({ path }: SlackTabProps) {
  const threads = useWorktreeSlackThreads(path)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Default the selection to the first thread, and keep it valid if the set
  // of threads changes (e.g. a resource is added/removed out from under us).
  useEffect(() => {
    if (threads.length === 0) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (!selectedId || !threads.some((t) => t.id === selectedId)) {
      setSelectedId(threads[0].id)
    }
  }, [threads, selectedId])

  const selected = threads.find((t) => t.id === selectedId) ?? null
  const tab = selected ? threadRefToTab(selected) : null
  // useThread short-circuits on a null tab, so calling it unconditionally
  // keeps hook order stable across the empty/selected states.
  const thread = useThread(tab)

  if (threads.length === 0) {
    return (
      <Alert color="gray" variant="light" title="No Slack threads">
        <Text size="sm">
          No Slack threads. Add one with <Code>worktree add &lt;slack-thread-url&gt;</Code>.
        </Text>
      </Alert>
    )
  }

  return (
    <Grid gutter="md">
      <Grid.Col span={{ base: 12, sm: 4 }}>
        <Stack gap={2}>
          {threads.map((t) => (
            <NavLink
              key={t.id}
              active={t.id === selectedId}
              label={threadRefToTab(t).name}
              onClick={() => setSelectedId(t.id)}
              styles={{ label: { wordBreak: "break-all" } }}
            />
          ))}
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, sm: 8 }}>
        {isNotConfigured(thread.error) ? (
          <Alert color="yellow" variant="light" title="Slack not configured">
            <Text size="sm">
              Run <Code>worktree setup</Code> to enable Slack.
            </Text>
          </Alert>
        ) : tab ? (
          <ThreadView
            tab={tab}
            thread={thread}
            onUpdateTab={() => {}}
            onOpenThread={(url, opts) => {
              window.open(url, opts.background ? "_blank" : "_self", "noreferrer")
            }}
          />
        ) : null}
      </Grid.Col>
    </Grid>
  )
}
