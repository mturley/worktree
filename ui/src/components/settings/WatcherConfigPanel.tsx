import { useState } from "react"
import { Alert, Input, Stack, TagsInput } from "@mantine/core"
import type { Settings, WatcherConfigSettings } from "../../api/types"
import { KeyValueTable } from "./KeyValueTable"
import { KeyPath, PersistedTo, SettingsSection } from "./parts"

/**
 * Every key of the watcher library's config.yaml. Custom fields are edited
 * as local rows (see KeyValueTable); the modal remounts this panel (via
 * key) on Discard and Save so the rows re-read the draft.
 */
export function WatcherConfigPanel({ settings, draft, update, error }: {
  settings: Settings
  draft: WatcherConfigSettings
  update: (fn: (d: WatcherConfigSettings) => WatcherConfigSettings) => void
  error?: string
}) {
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(draft.jira.custom_fields))
  const setFields = (next: [string, string][]) => {
    setRows(next)
    const map = Object.fromEntries(next.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v.trim()]))
    update((d) => ({ jira: { ...d.jira, custom_fields: map } }))
  }
  return (
    <Stack gap="lg">
      <PersistedTo path={settings.paths.watcher_config} />
      {error && <Alert color="red" title="Couldn't save watcher config.yaml">{error}</Alert>}
      <SettingsSection title="Jira">
        <TagsInput
          label="Bot usernames"
          description={<>Comment and changelog authors to treat as bots. <KeyPath path="jira.bot_usernames" /></>}
          placeholder="Add username…"
          value={draft.jira.bot_usernames}
          onChange={(v) => update((d) => ({ jira: { ...d.jira, bot_usernames: v } }))}
        />
        <Input.Wrapper
          label="Custom fields"
          description={<>Friendly name → Jira field ID. The poller fetches and caches these. <KeyPath path="jira.custom_fields" /></>}
        >
          <KeyValueTable rows={rows} onChange={setFields} keyPlaceholder="epic_key" valuePlaceholder="customfield_10014" />
        </Input.Wrapper>
      </SettingsSection>
    </Stack>
  )
}
