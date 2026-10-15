import { Alert, Button, Code, Group, Stack, Text, Textarea } from "@mantine/core"
import type { Settings, WorktreeSettings } from "../../api/types"
import { Toggle } from "../Toggle"
import { KeyPath, PersistedTo, SettingsSection } from "./parts"

interface Props {
  settings: Settings
  draft: WorktreeSettings
  update: (fn: (d: WorktreeSettings) => WorktreeSettings) => void
  error?: string
}

const PLACEHOLDERS: [string, string][] = [
  ["$event", "the event's title"],
  ["$resource", "the resource's key and (truncated) name"],
  ["$description", "the event's description, on one line and truncated"],
  ["$worktree", "the worktree's directory name"],
  ["$cmuxtitle", "the worktree's cmux workspace title, if it has one"],
]

/** worktree's config.yaml notifications.* section. */
export function NotificationsPanel({ settings, draft, update, error }: Props) {
  const n = draft.notifications
  const fallback = settings.environment.default_notify_command
  const set = (patch: Partial<WorktreeSettings["notifications"]>) =>
    update((d) => ({ ...d, notifications: { ...d.notifications, ...patch } }))
  return (
    <Stack gap="lg">
      <PersistedTo path={settings.paths.worktree} />
      {error && <Alert color="red" title="Couldn't save config.yaml">{error}</Alert>}

      <SettingsSection title="Notifications">
        <Toggle
          label="Enable notifications"
          description={<>
            Off, nothing notifies and the notify toggles are disabled; each worktree's and resource's toggles are
            kept and come back when this is turned on. <KeyPath path="notifications.disabled" />
          </>}
          checked={n.enabled}
          onChange={(e) => { const on = e.currentTarget.checked; set({ enabled: on }) }}
        />
      </SettingsSection>

      <SettingsSection title="Custom command">
        <Toggle
          label="Trigger custom command for each notification"
          description={<>Runs alongside the cmux or browser notification. <KeyPath path="notifications.command_enabled" /></>}
          checked={n.command_enabled}
          disabled={!n.enabled}
          tooltip={n.enabled ? undefined : "Notifications are disabled"}
          onChange={(e) => { const on = e.currentTarget.checked; set({ command_enabled: on }) }}
        />
        <Textarea
          label="Command"
          description={<>
            Run with <Code>sh -c</Code>. The placeholders are shell variables, so keep them inside double quotes;
            their values are never run as commands. <KeyPath path="notifications.command" />
          </>}
          placeholder={fallback}
          value={n.command}
          disabled={!n.enabled || !n.command_enabled}
          onChange={(e) => { const v = e.currentTarget.value; set({ command: v }) }}
          autosize
          minRows={1}
          ff="monospace"
          styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
        />
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2}>
            {PLACEHOLDERS.map(([k, v]) => (
              <Text key={k} size="xs" c="dimmed"><Code>{k}</Code> {v}</Text>
            ))}
          </Stack>
          <Button
            size="compact-xs"
            variant="subtle"
            disabled={!n.enabled || !n.command_enabled || n.command === fallback}
            onClick={() => set({ command: fallback })}
          >
            Reset to default
          </Button>
        </Group>
      </SettingsSection>
    </Stack>
  )
}
