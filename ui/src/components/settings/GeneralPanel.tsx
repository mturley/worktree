import { Alert, Anchor, Code, Stack, TagsInput, Text, TextInput } from "@mantine/core"
import type { Settings, WorktreeSettings } from "../../api/types"
import { Toggle } from "../Toggle"
import { KeyPath, PersistedTo, SettingsSection } from "./parts"

interface Props {
  settings: Settings
  draft: WorktreeSettings
  update: (fn: (d: WorktreeSettings) => WorktreeSettings) => void
  error?: string
  /** Jump to the Watcher Auth tab. */
  onShowWatcherAuth: () => void
}

/** worktree's config.yaml, except the ui.* keys (UIAccessPanel). */
export function GeneralPanel({ settings, draft, update, error, onShowWatcherAuth }: Props) {
  const env = settings.environment
  return (
    <Stack gap="lg">
      <PersistedTo path={settings.paths.worktree} />
      {error && <Alert color="red" title="Couldn't save config.yaml">{error}</Alert>}

      <SettingsSection title="Interface">
        <Toggle
          label="Enable cmux features"
          description="Workspace headers, tab controls, Follow cmux focus, cmux notifications and the 📬 unread title prefix."
          checked={draft.cmux_features_enabled}
          disabled={!env.in_cmux}
          onChange={(e) => { const on = e.currentTarget.checked; update((d) => ({ ...d, cmux_features_enabled: on })) }}
          tooltip={env.in_cmux ? undefined : "The worktree UI server is not running inside cmux, so there are no cmux features to turn on or off."}
        />
        <TextInput
          label="Editor"
          description={<>Command used by <Code>worktree open</Code> to open a worktree. <KeyPath path="editor" /></>}
          placeholder="$EDITOR"
          value={draft.editor}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, editor: v })) }}
          ff="monospace"
        />
      </SettingsSection>

      <SettingsSection title="Worktrees">
        <TextInput
          label="Worktrees base directory"
          description={<>Where new worktrees are created. <KeyPath path="worktrees_base" /></>}
          placeholder="~/.worktrees"
          value={draft.worktrees_base}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, worktrees_base: v })) }}
          ff="monospace"
        />
        {env.worktrees_base_env && (
          <Text size="xs" c="yellow">$WORKTREES_BASE is set in the server's environment and overrides this value.</Text>
        )}
      </SettingsSection>

      <SettingsSection title="Jira">
        <TagsInput
          label="Project keys"
          description={<>Prefixes detected in branch names and PR titles. <KeyPath path="jira.projects" /></>}
          placeholder="Add key…"
          value={draft.jira.projects}
          onChange={(v) => update((d) => ({ ...d, jira: { ...d.jira, projects: v } }))}
        />
        <TagsInput
          label="Alias hosts"
          description={<>Old hostnames whose /browse/KEY links still count as Jira issues. <KeyPath path="jira.alias_hosts" /></>}
          placeholder="Add host…"
          value={draft.jira.alias_hosts}
          onChange={(v) => update((d) => ({ ...d, jira: { ...d.jira, alias_hosts: v } }))}
        />
        <Text size="xs" c="dimmed">
          Jira host, email and token are on the <Anchor component="button" size="xs" onClick={onShowWatcherAuth}>Watcher Auth</Anchor> tab.
        </Text>
      </SettingsSection>
    </Stack>
  )
}
