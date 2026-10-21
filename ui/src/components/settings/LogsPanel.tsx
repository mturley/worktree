import { Tabs } from "@mantine/core"
import { LogTab } from "../watcherlog/LogTab"
import { ResourceStatusTab } from "../watcherlog/ResourceStatusTab"

/**
 * The watcher log and per-resource poll status. Rendered only while the tab
 * is showing, and keepMounted={false} unmounts the hidden sub-tab, so their
 * polling runs only while one is on screen.
 */
export function LogsPanel({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <Tabs defaultValue="log" keepMounted={false}>
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
  )
}
