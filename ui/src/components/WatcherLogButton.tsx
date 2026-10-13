import { useState } from "react"
import { ActionIcon, Tooltip } from "@mantine/core"
import { IconListDetails } from "@tabler/icons-react"
import type { WatcherLogScope } from "../api/types"
import { WatcherLogModal } from "./watcherlog/WatcherLogModal"

/**
 * Opens the watcher log. The modal is mounted only while open, so the log and
 * status queries — and their polling — exist only then. Nothing here costs a
 * request on an ordinary page view.
 */
export function WatcherLogButton({ scope }: { scope: WatcherLogScope }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tooltip label="Watcher log">
        <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Watcher log" onClick={() => setOpen(true)}>
          <IconListDetails size={16} />
        </ActionIcon>
      </Tooltip>
      {open && <WatcherLogModal scope={scope} onClose={() => setOpen(false)} />}
    </>
  )
}
