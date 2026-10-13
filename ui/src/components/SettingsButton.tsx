import { useState } from "react"
import { ActionIcon, Tooltip } from "@mantine/core"
import { IconSettings } from "@tabler/icons-react"
import { SettingsModal } from "./SettingsModal"

export function SettingsButton() {
  const [opened, setOpened] = useState(false)
  return (
    <>
      <Tooltip label="Settings">
        <ActionIcon variant="default" aria-label="Settings" onClick={() => setOpened(true)}>
          <IconSettings size={16} />
        </ActionIcon>
      </Tooltip>
      <SettingsModal opened={opened} onClose={() => setOpened(false)} />
    </>
  )
}
