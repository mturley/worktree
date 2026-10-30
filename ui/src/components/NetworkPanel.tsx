import { ActionIcon, Anchor, CopyButton, Group, Stack, Text, Tooltip } from "@mantine/core"
import { IconCheck, IconCopy, IconExternalLink } from "@tabler/icons-react"
import { formatRange, useListeners } from "../lib/listenersStore"
import { useOpenSettings } from "./settings/SettingsContext"

/** The Environment tab's Network column: the TCP ports this worktree's processes listen on. */
export function NetworkPanel({ path }: { path: string }) {
  const listeners = useListeners(path)
  const openSettings = useOpenSettings()
  const enabled = listeners?.enabled ?? true
  const ports = listeners?.ports ?? []
  return (
    <Stack gap={2}>
      <Group gap="xs" wrap="wrap">
        <Text size="sm" fw={600}>Network</Text>
        {enabled && (
          <Text size="xs" c="dimmed">
            {listeners?.range ? `Reserved ${formatRange(listeners.range)}` : "No reserved range"}
          </Text>
        )}
      </Group>
      {!enabled ? (
        <Text size="xs" c="dimmed">
          Port scanning is off.{" "}
          {openSettings && (
            <Anchor component="button" type="button" fz="xs" onClick={() => openSettings({ tab: "general" })}>
              Enable it in Settings
            </Anchor>
          )}
        </Text>
      ) : ports.length === 0 ? (
        <Text size="xs" c="dimmed" fs="italic">Nothing listening</Text>
      ) : (
        ports.map((p) => (
          <Group key={p.port} gap="xs" wrap="wrap">
            <Text size="xs" ff="monospace" fw={600} c={p.in_range ? undefined : "red"}>{p.port}</Text>
            <Text size="xs" c="dimmed">{p.addresses.join(", ")}</Text>
            <Text size="xs">{p.process} ({p.pid})</Text>
            <CopyButton value={String(p.pid)}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? "Copied" : "Copy PID"}>
                  <ActionIcon variant="subtle" color={copied ? "teal" : "gray"} size="xs" aria-label="Copy PID" onClick={copy}>
                    {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
            <ActionIcon
              component="a" href={`http://localhost:${p.port}`} target="_blank" rel="noreferrer"
              variant="subtle" color="gray" size="xs" aria-label={`Open localhost:${p.port}`}
            >
              <IconExternalLink size={12} />
            </ActionIcon>
          </Group>
        ))
      )}
    </Stack>
  )
}
