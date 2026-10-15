import { useEffect, useState } from "react"
import { Alert, Box, Button, Group, Loader, Modal, Tabs, Text } from "@mantine/core"
import { useQuery, useQueryClient, type Query } from "@tanstack/react-query"
import { api } from "../api/client"
import { DevicesPanel } from "./DevicesPanel"
import { GeneralPanel } from "./settings/GeneralPanel"
import { UIAccessPanel } from "./settings/UIAccessPanel"
import { ConnectedServicesPanel } from "./settings/ConnectedServicesPanel"
import { tabDirty, type SettingsTab } from "./settings/tabDirty"
import { useSettingsDraft } from "./settings/useSettingsDraft"
import type { SettingsTarget } from "./settings/SettingsContext"
import type { CredService } from "../api/types"

export const settingsKey = ["settings"] as const

/**
 * Every cmux-backed query (["cmux"], ["cmux-tree", path],
 * ["cmux-browser-tabs"], ["cmux-groups"]) plus the session, whose
 * notify_mode follows the cmux toggle.
 */
const affectedByCmux = (q: Pick<Query, "queryKey">) => {
  const head = q.queryKey[0]
  return typeof head === "string" && (head.startsWith("cmux") || head === "session")
}

/**
 * The home page's settings. The config tabs share one draft and one
 * Save/Discard footer, which covers secrets too: Replace tests a new one and
 * holds it in the draft (memory only), and Save writes it. Devices manages
 * logins and has no draft.
 */
export function SettingsModal({ opened, onClose, target }: { opened: boolean; onClose: () => void; target?: SettingsTarget }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<string | null>("general")
  const [service, setService] = useState<CredService>("github")
  // Each open at a target (a "Re-enable it in Settings" link) lands there.
  useEffect(() => {
    if (!opened || !target) return
    setTab(target.tab)
    if (target.service) setService(target.service)
  }, [opened, target])
  const [confirmClose, setConfirmClose] = useState(false)
  // Bumped on Discard and after a save, to remount panels holding local rows.
  const [resetToken, setResetToken] = useState(0)
  const settings = useQuery({ queryKey: settingsKey, queryFn: api.settings, enabled: opened })
  const draft = useSettingsDraft(settings.data)

  // The modal stays mounted between opens, so adopt each refetch. rebase keeps
  // files with unsaved edits, and is a no-op for dirty flags on identical data.
  const { rebase } = draft
  useEffect(() => {
    if (settings.data) rebase(settings.data)
  }, [settings.data, rebase])

  // Nothing left to lose (e.g. saved while the confirm showed).
  useEffect(() => {
    if (!draft.anyDirty) setConfirmClose(false)
  }, [draft.anyDirty])

  const discard = () => {
    draft.discard()
    setResetToken((n) => n + 1)
  }

  const requestClose = () => {
    if (draft.anyDirty) setConfirmClose(true)
    else onClose()
  }

  const save = async () => {
    const wasCmux = draft.drafts && settings.data
      ? draft.drafts.worktree.cmux_features_enabled !== settings.data.worktree.cmux_features_enabled
      : false
    // A GET already in flight could land after setQueryData and rebase clean
    // files back to the old values.
    await qc.cancelQueries({ queryKey: settingsKey })
    const out = await draft.save()
    if (out.saved.includes("watcher_config")) setResetToken((n) => n + 1)
    if (out.settings) qc.setQueryData(settingsKey, out.settings)
    if (wasCmux && out.saved.includes("worktree")) void qc.invalidateQueries({ predicate: affectedByCmux })
    // Watcher toggles change what the detail views may fetch and show.
    if (out.saved.includes("worktree")) {
      void qc.invalidateQueries({ queryKey: ["watcher-health"] })
      void qc.invalidateQueries({ queryKey: ["linked"] })
    }
  }

  // Tabs and files don't line up one to one, so each tab marks only its own keys.
  const dirty: Record<SettingsTab, boolean> = settings.data && draft.drafts
    ? tabDirty(settings.data, draft.drafts, draft.secrets)
    : { general: false, connected: false, github: false, jira: false, slack: false, "ui-access": false }
  const label = (name: string, value: SettingsTab) =>
    <>{name}{dirty[value] ? <Text span c="orange" ml={4}>●</Text> : null}</>

  const body = (() => {
    if (settings.error && !settings.data) return <Alert color="red" title="Couldn't load settings">{settings.error.message}</Alert>
    if (settings.isLoading || (settings.data && !draft.drafts)) return <Loader size="sm" />
    return null
  })()

  return (
    <Modal opened={opened} onClose={requestClose} title="Settings" size="xl">
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="general">{label("General", "general")}</Tabs.Tab>
          <Tabs.Tab value="connected">{label("Connected Services", "connected")}</Tabs.Tab>
          <Tabs.Tab value="ui-access">{label("UI Access", "ui-access")}</Tabs.Tab>
          <Tabs.Tab value="devices">Devices</Tabs.Tab>
        </Tabs.List>
        {/* A native disabled fieldset locks every field and button of the
            config tabs while Save runs; the tab list stays usable. */}
        <fieldset disabled={draft.saving} aria-busy={draft.saving} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <Tabs.Panel value="general" pt="md">
            {body ?? (settings.data && draft.drafts && (
              <GeneralPanel
                settings={settings.data}
                draft={draft.drafts.worktree}
                update={(fn) => draft.update("worktree", fn)}
                error={draft.errors.worktree}
              />
            ))}
          </Tabs.Panel>
          <Tabs.Panel value="connected" pt="md">
            {body ?? (settings.data && draft.drafts && (
              <ConnectedServicesPanel
                settings={settings.data}
                drafts={draft.drafts}
                update={draft.update}
                errors={draft.errors}
                active={opened && tab === "connected"}
                secrets={draft.secrets}
                setSecret={draft.setSecret}
                setInvalid={(m) => draft.setInvalid("watcher_config", m)}
                resetToken={resetToken}
                dirty={dirty}
                service={service}
                onServiceChange={setService}
              />
            ))}
          </Tabs.Panel>
          <Tabs.Panel value="ui-access" pt="md">
            {body ?? (settings.data && draft.drafts && (
              <UIAccessPanel
                settings={settings.data}
                draft={draft.drafts.worktree}
                update={(fn) => draft.update("worktree", fn)}
                error={draft.errors.worktree}
                secrets={draft.secrets}
                setSecret={draft.setSecret}
              />
            ))}
          </Tabs.Panel>
        </fieldset>
        <Tabs.Panel value="devices" pt="md">
          <DevicesPanel active={opened && tab === "devices"} />
        </Tabs.Panel>
      </Tabs>

      {confirmClose && (
        <Alert role="alert" color="yellow" mt="md" title="Discard unsaved changes?">
          <Group gap="xs" mt="xs">
            <Button size="xs" variant="default" onClick={() => setConfirmClose(false)}>Keep editing</Button>
            <Button size="xs" color="red" onClick={() => { discard(); setConfirmClose(false); onClose() }}>Discard and close</Button>
          </Group>
        </Alert>
      )}

      {tab !== "devices" && (
        <Box mt="md" pt="sm" style={{ borderTop: "1px solid var(--mantine-color-default-border)", position: "sticky", bottom: 0, background: "var(--mantine-color-body)" }}>
          <Group justify="space-between">
            <Text size="xs" c={draft.anyDirty ? "orange" : "dimmed"}>
              {draft.anyDirty
                ? `● Unsaved changes${draft.restartCount ? ` · ${draft.restartCount} ${draft.restartCount === 1 ? "needs" : "need"} a restart` : ""}`
                : "No unsaved changes"}
            </Text>
            <Group gap="xs">
              <Button size="xs" variant="subtle" disabled={!draft.anyDirty || draft.saving} onClick={discard}>Discard</Button>
              <Button size="xs" disabled={!draft.anyDirty} loading={draft.saving} onClick={save}>Save</Button>
            </Group>
          </Group>
        </Box>
      )}
    </Modal>
  )
}
