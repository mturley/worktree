import { Group } from "@mantine/core"
import { RefreshWatchersButton } from "./RefreshWatchersButton"
import { SettingsButton } from "./SettingsButton"
import { WatcherLogsButton } from "./watcherlog/WatcherLogsButton"

/**
 * The page-wide controls at the top right of every header: refresh the
 * watchers, the watcher logs, and Settings. The mini view leaves Settings
 * out (the menu bar app has its own) and opens the logs full-screen, since
 * its popover is too small for a modal.
 */
export function HeaderActions({ settings = true, fullScreenLogs }: { settings?: boolean; fullScreenLogs?: boolean }) {
  return (
    <Group gap={4} wrap="nowrap" data-testid="header-actions" style={{ flex: "none" }}>
      <RefreshWatchersButton />
      <WatcherLogsButton fullScreen={fullScreenLogs} />
      {settings && <SettingsButton />}
    </Group>
  )
}
