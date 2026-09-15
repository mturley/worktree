import { useState } from "react"
import { ActionIcon, Tooltip } from "@mantine/core"
import { IconDevices } from "@tabler/icons-react"
import { DevicesModal } from "./DevicesModal"

export function DevicesButton() {
  const [opened, setOpened] = useState(false)
  return (
    <>
      <Tooltip label="Devices">
        <ActionIcon variant="default" aria-label="Devices" onClick={() => setOpened(true)}>
          <IconDevices size={16} />
        </ActionIcon>
      </Tooltip>
      <DevicesModal opened={opened} onClose={() => setOpened(false)} />
    </>
  )
}
