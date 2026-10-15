import { useState } from "react"
import { ActionIcon, Tooltip } from "@mantine/core"
import { IconSettings } from "@tabler/icons-react"
import { SettingsModal } from "./SettingsModal"
import { useOpenSettings } from "./settings/SettingsContext"

export function SettingsButton() {
  const openSettings = useOpenSettings()
  // Without the app's SettingsProvider (tests rendering a page alone), the
  // button keeps a modal of its own.
  const [opened, setOpened] = useState(false)
  return (
    <>
      <Tooltip label="Settings">
        <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Settings"
          onClick={() => (openSettings ? openSettings() : setOpened(true))}>
          <IconSettings size={16} />
        </ActionIcon>
      </Tooltip>
      {!openSettings && <SettingsModal opened={opened} onClose={() => setOpened(false)} />}
    </>
  )
}
