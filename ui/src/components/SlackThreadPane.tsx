import { useEffect, useState, type ReactNode } from "react"
import { Alert, Code, Group, Stack, Tabs, Text } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { useThread } from "../hooks/useThread"
import { defaultTabName, type Tab } from "../state/tabs"
import { useWatcherHealth } from "./WatcherAlert"
import { ResourceCard, type ResourceNotifyContext } from "./ResourceCard"
import { ThreadView } from "./slack/ThreadView"
import { useLinkedResources } from "../hooks/useLinkedResources"
import { useResourceTab } from "../hooks/useSelectedResource"
import { LinkedResourcesPanel, LinkedTabControls, linkedTabLabel } from "./linked/LinkedResourcesPanel"
import { UnreadMarkerDot } from "./UnreadMarkerDot"
import { hasUnread } from "../lib/unread"
import { TASKS_TAB, useResourceTasksPlacement } from "./tasks/TasksSection"

interface SlackThreadPaneProps {
  resource: ResourceDTO
  /** Worktree path, needed by the remove control in the thread header. */
  path: string
  /** Refetch resources after the thread is removed. */
  onRemoved?: () => void
  /** Refetch the worktree's resources after a custom name/description save. */
  onResourceChanged?: () => void
  /** Height (px) of the page's sticky header; see ThreadView's topInset. */
  topInset?: number
  /** Notification state for the card's switch; see ResourceNotifyContext. */
  notify?: ResourceNotifyContext
  /** A message to bring into view; see ThreadView. */
  focus?: { ts: string; key: number }
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
  return !!error && error.includes("503") && !isWatcherOff(error)
}

/** The same 503, but because the Slack watcher is off in Settings. */
function isWatcherOff(error: string | undefined): boolean {
  return !!error && error.includes("watcher is disabled")
}

/** The Slack pane's tabs, default first (see useResourceTab). */
const THREAD_TABS = ["thread", "linked", TASKS_TAB] as const

/**
 * The selected-resource pane's Slack branch: renders the thread itself where
 * a PR/Jira resource would show its filtered activity feed. There is
 * deliberately no resource summary card above it — ThreadView already has its
 * own title/description header, so a card would be duplicate chrome.
 */
export function SlackThreadPane({ resource, path, onRemoved, onResourceChanged, topInset, notify, focus }: SlackThreadPaneProps) {
  // Surfaces a failed "save thread details" write: the modal closes on submit,
  // so a rejected write would otherwise vanish and look like success.
  const [saveError, setSaveError] = useState<string | null>(null)
  const tab = slackTabFromResource(resource)
  // While the Slack watcher is off, don't fetch or stream the thread at all
  // (the server would refuse); it loads again once the watcher is back on.
  const slackOff = useWatcherHealth().data?.slack.enabled === false
  const thread = useThread(slackOff ? null : tab)
  const [urlTab, setPaneTab] = useResourceTab(THREAD_TABS)
  // A Tasks tab, or the list pinned between the card and the tab bar.
  const { tasks, shownTab: paneTab } = useResourceTasksPlacement(resource, urlTab, setPaneTab, "thread")
  // See ResourceDetailPane: link titles wait until the Linked tab is shown.
  const [linkedOpened, setLinkedOpened] = useState(paneTab === "linked")
  useEffect(() => {
    if (paneTab === "linked") setLinkedOpened(true)
  }, [paneTab])
  // A focus request (e.g. from an activity entry's details) targets a
  // message in the thread, so bring the Thread tab forward to show it. Not a
  // history step: the user didn't choose the tab, the navigation did.
  useEffect(() => {
    if (focus) setPaneTab("thread", { replace: true })
  }, [focus?.key])
  const linked = useLinkedResources(resource.type, resource.id, linkedOpened)

  /*
   * When the thread can't be shown, its notice stands where the thread
   * would, but the task list stays: tasks contact no external service.
   * Pinned, the panel comes first, as it sits above the tab bar elsewhere;
   * otherwise a minimal Thread · Tasks tab bar (no Linked tab: resolving
   * links contacts the services).
   */
  const withTasks = (notice: ReactNode) =>
    tasks.pinned ? (
      <>
        {tasks.pinnedPanel}
        {notice}
      </>
    ) : (
      <Tabs
        value={paneTab === TASKS_TAB ? TASKS_TAB : "thread"}
        keepMounted={false}
        onChange={(v) => {
          if (v) setPaneTab(v)
        }}
      >
        <Tabs.List>
          <Tabs.Tab value="thread">Thread</Tabs.Tab>
          {tasks.tab}
          {paneTab === TASKS_TAB && (
            <Group gap={4} wrap="nowrap" align="center" ml="auto" pb={4} style={{ flex: "none" }}>
              {tasks.toolbar}
            </Group>
          )}
        </Tabs.List>
        <Tabs.Panel value="thread" pt="sm">{notice}</Tabs.Panel>
        <Tabs.Panel value={TASKS_TAB} pt="sm">{tasks.tabPanelBody}</Tabs.Panel>
      </Tabs>
    )

  // Watcher off: the resource still shows, but the thread can't be loaded
  // (worktree doesn't contact Slack). ResourceDetailPane's WatcherAlert says
  // why, with a link to turn it back on.
  if (slackOff || isWatcherOff(thread.error)) {
    return (
      <Stack gap="sm">
        <ResourceCard r={resource} path={path} onRemoved={onRemoved} variant="detail" onMetaChanged={() => onResourceChanged?.()} notify={notify} />
        {withTasks(<Text size="sm" c="dimmed">The thread can't be shown while the Slack watcher is disabled.</Text>)}
      </Stack>
    )
  }

  if (isNotConfigured(thread.error)) {
    return (
      <Stack gap="sm">
        {withTasks(
          <Alert color="yellow" variant="light" title="Slack not configured">
            <Text size="sm">
              Run <Code>worktree setup</Code> to enable Slack.
            </Text>
          </Alert>,
        )}
      </Stack>
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
        notify={notify}
      />
      {/* Pinned, the task list sits between the card and the tab bar. */}
      {tasks.pinnedPanel}
      <Tabs
        value={paneTab}
        // Only the Thread panel stays mounted while hidden (its keepMounted
        // keeps the composer draft, scroll position and unread-divider
        // placement); the Linked panel remounts each time it is shown.
        keepMounted={false}
        onChange={(v) => {
          if (v) setPaneTab(v)
        }}
      >
        <Tabs.List>
          <Tabs.Tab
            value="thread"
            rightSection={
              // Unread replies you can't see from the Linked tab (Slack's own
              // read state, as on the thread's card).
              hasUnread(resource) && paneTab !== "thread" ? <UnreadMarkerDot label="unread replies" /> : undefined
            }
          >
            Thread
          </Tabs.Tab>
          <Tabs.Tab value="linked">{linkedTabLabel(linked.data)}</Tabs.Tab>
          {tasks.tab}
          {paneTab === "linked" && (
            <Group gap={4} wrap="nowrap" align="center" ml="auto" style={{ flex: "none" }}>
              <LinkedTabControls query={linked} />
            </Group>
          )}
          {paneTab === TASKS_TAB && (
            <Group gap={4} wrap="nowrap" align="center" ml="auto" pb={4} style={{ flex: "none" }}>
              {tasks.toolbar}
            </Group>
          )}
        </Tabs.List>
        <Tabs.Panel value="thread" pt="sm" keepMounted>
          <ThreadView
            tab={tab}
            thread={thread}
            topInset={topInset}
            focus={focus}
            onOpenThread={(url, opts) => {
              window.open(url, opts.background ? "_blank" : "_self", "noreferrer")
            }}
          />
        </Tabs.Panel>
        <Tabs.Panel value="linked" pt="sm">
          <LinkedResourcesPanel query={linked} path={path} />
        </Tabs.Panel>
        {!tasks.pinned && (
          <Tabs.Panel value={TASKS_TAB} pt="sm">
            {tasks.tabPanelBody}
          </Tabs.Panel>
        )}
      </Tabs>
    </Stack>
  )
}
