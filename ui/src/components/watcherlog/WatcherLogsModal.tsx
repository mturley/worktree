import { Modal, Tabs } from "@mantine/core"
import { LogTab } from "./LogTab"
import { ResourceStatusTab } from "./ResourceStatusTab"

/**
 * The watcher log and per-resource poll status, opened from the header's
 * logs button. The body renders only while the modal is open, and
 * keepMounted={false} unmounts the hidden sub-tab, so their polling runs
 * only while one is on screen.
 */
export function WatcherLogsModal({ opened, onClose, fullScreen }: { opened: boolean; onClose: () => void; fullScreen?: boolean }) {
  return (
    <Modal opened={opened} onClose={onClose} title="Watcher logs" size="xl" fullScreen={fullScreen}>
      {opened && (
        <Tabs defaultValue="log" keepMounted={false} variant="pills">
          <Tabs.List>
            <Tabs.Tab value="log">Watcher log</Tabs.Tab>
            <Tabs.Tab value="status">Resource status</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="log" pt="sm">
            <LogTab />
          </Tabs.Panel>
          <Tabs.Panel value="status" pt="sm">
            <ResourceStatusTab />
          </Tabs.Panel>
        </Tabs>
      )}
    </Modal>
  )
}
