import { useState } from "react"
import { ActionIcon, Tooltip } from "@mantine/core"
import { IconAlertTriangleFilled, IconFileText } from "@tabler/icons-react"
import { useWatchers } from "../../hooks/useWatchers"
import { useWatcherHealth } from "../WatcherAlert"
import type { CredService } from "../../api/types"
import { serviceName } from "../settings/watcherText"
import { WatcherLogsModal } from "./WatcherLogsModal"

/** "GitHub", "GitHub and Jira", "GitHub, Jira and Slack". */
function joinNames(names: string[]) {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/**
 * Opens the watcher logs. Becomes a red warning while any watcher is
 * failing (its last error is newer than its last success), naming them in
 * the tooltip. A watcher turned off in Settings is not failing.
 */
export function WatcherLogsButton({ fullScreen }: { fullScreen?: boolean }) {
  const [opened, setOpened] = useState(false)
  const { data } = useWatchers()
  // A watcher turned off is never polled again, so its last error would
  // otherwise stay "newer than its last success" for good.
  const health = useWatcherHealth().data
  const failing = (data?.watchers ?? [])
    .filter((w) => w.has_error && health?.[w.name as CredService]?.enabled !== false)
    .map((w) => serviceName[w.name as CredService] ?? w.name)
  const warn = failing.length > 0
  const label = warn
    ? `${joinNames(failing)} ${failing.length === 1 ? "watcher" : "watchers"} failing — open logs`
    : "Watcher logs"
  return (
    <>
      <Tooltip label={label}>
        <ActionIcon
          variant="subtle"
          color={warn ? "red" : "gray"}
          size="sm"
          aria-label={warn ? "Watcher logs (watchers failing)" : "Watcher logs"}
          onClick={() => setOpened(true)}
        >
          {warn ? <IconAlertTriangleFilled size={16} /> : <IconFileText size={16} />}
        </ActionIcon>
      </Tooltip>
      <WatcherLogsModal opened={opened} onClose={() => setOpened(false)} fullScreen={fullScreen} />
    </>
  )
}
