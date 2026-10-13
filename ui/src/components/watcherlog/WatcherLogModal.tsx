import { useState } from "react"
import { Badge, Button, Group, Modal, Tabs } from "@mantine/core"
import type { WatcherLogScope } from "../../api/types"
import { LogTab } from "./LogTab"
import { ResourceStatusTab } from "./ResourceStatusTab"

const RESOURCE_LABEL: Record<string, string> = { pr: "This PR", jira: "This issue", slack: "This thread" }

export function scopeLabel(scope: WatcherLogScope): string {
  if (scope.resource) return `${RESOURCE_LABEL[scope.resource.type] ?? "This resource"}: ${scope.resource.name}`
  if (scope.worktree) return "This worktree"
  return "All resources"
}

export function WatcherLogModal({ scope: initial, onClose }: { scope: WatcherLogScope; onClose: () => void }) {
  const [scope, setScope] = useState<WatcherLogScope>(initial)
  const scoped = !!(scope.resource || scope.worktree)
  return (
    <Modal
      opened
      onClose={onClose}
      size="xl"
      title={
        <Group gap="xs">
          <span>Watcher log</span>
          <Badge variant="light" color="gray" tt="none">{scopeLabel(scope)}</Badge>
          {scoped && (
            <Button size="compact-xs" variant="subtle" onClick={() => setScope({})}>
              Show all
            </Button>
          )}
        </Group>
      }
    >
      <Tabs defaultValue="log" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="log">Log</Tabs.Tab>
          <Tabs.Tab value="status">Resource Status</Tabs.Tab>
        </Tabs.List>
        {/* key: widening the scope resets each tab's state and cursors. */}
        <Tabs.Panel value="log" pt="sm">
          <LogTab key={JSON.stringify(scope)} scope={scope} />
        </Tabs.Panel>
        <Tabs.Panel value="status" pt="sm">
          <ResourceStatusTab key={JSON.stringify(scope)} scope={scope} />
        </Tabs.Panel>
      </Tabs>
    </Modal>
  )
}
