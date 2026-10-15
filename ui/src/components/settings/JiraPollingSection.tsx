import { useState } from "react"
import { Input, TagsInput } from "@mantine/core"
import type { WatcherConfigSettings } from "../../api/types"
import { KeyValueTable } from "./KeyValueTable"
import { KeyPath, SettingsSection } from "./parts"

/** Inline error per row: a blank name with an ID, or a name an earlier row already uses. */
function fieldErrors(rows: [string, string][]): (string | undefined)[] {
  const seen = new Set<string>()
  return rows.map(([k, v]) => {
    const name = k.trim()
    if (!name) return v.trim() ? "Name is required" : undefined
    if (seen.has(name)) return `Duplicate name "${name}"`
    seen.add(name)
    return undefined
  })
}

/**
 * Every key of the watcher library's config.yaml (all Jira). Custom fields
 * are edited as local rows (see KeyValueTable); the modal remounts this
 * section (via key) on Discard and Save so the rows re-read the draft.
 */
export function JiraPollingSection({ file, draft, update, setInvalid }: {
  /** The watcher config.yaml path, shown on the section. */
  file: string
  draft: WatcherConfigSettings
  update: (fn: (d: WatcherConfigSettings) => WatcherConfigSettings) => void
  /** Mark this file's draft invalid (Save then skips it) or valid again. */
  setInvalid: (message: string | null) => void
}) {
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(draft.jira.custom_fields))
  const rowErrors = fieldErrors(rows)
  const setFields = (next: [string, string][]) => {
    setRows(next)
    setInvalid(fieldErrors(next).find(Boolean) ?? null)
    const map = Object.fromEntries(next.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v.trim()]))
    update((d) => ({ jira: { ...d.jira, custom_fields: map } }))
  }
  return (
    <SettingsSection title="Polling" file={file}>
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
        <KeyValueTable rows={rows} onChange={setFields} rowErrors={rowErrors} keyPlaceholder="epic_key" valuePlaceholder="customfield_10014" />
      </Input.Wrapper>
    </SettingsSection>
  )
}
