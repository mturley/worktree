import { Text, Tooltip } from "@mantine/core"
import { IconAlertTriangleFilled } from "@tabler/icons-react"
import type { WatcherStatus } from "../api/types"

/**
 * Marks a watcher that is currently failing, with its error in a tooltip.
 *
 * Shared so the source toggles and the Activity header cannot disagree about
 * what a broken watcher looks like. Renders nothing when the watcher is
 * healthy or unknown, so callers can place it unconditionally.
 */
export function WatcherErrorMark({ status }: { status?: WatcherStatus }) {
  if (!status?.has_error) return null
  return (
    <Tooltip label={status.error_message || "This watcher's last run failed"} multiline w={280} withArrow>
      <Text
        span
        c="red"
        style={{ display: "inline-flex", marginLeft: 4 }}
        aria-label={`${status.name} watcher failing`}
      >
        <IconAlertTriangleFilled size={12} />
      </Text>
    </Tooltip>
  )
}
