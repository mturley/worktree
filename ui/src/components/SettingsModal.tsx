import { useEffect, useState } from "react"
import { Alert, Box, Button, Group, Loader, Modal, Tabs, Text } from "@mantine/core"
import { useQuery, useQueryClient, type Query } from "@tanstack/react-query"
import { api } from "../api/client"
import { DevicesPanel } from "./DevicesPanel"
import { GeneralPanel } from "./settings/GeneralPanel"
import { WatcherAuthPanel } from "./settings/WatcherAuthPanel"
import { WatcherConfigPanel } from "./settings/WatcherConfigPanel"
import { useSettingsDraft, type SettingsFile } from "./settings/useSettingsDraft"

const settingsKey = ["settings"] as const

/**
 * Every cmux-backed query (["cmux"], ["cmux-tree", path],
 * ["cmux-browser-tabs"], ["cmux-groups"]) plus the session, whose
 * notify_mode follows the cmux toggle.
 */
const affectedByCmux = (q: Pick<Query, "queryKey">) => {
  const head = q.queryKey[0]
  return typeof head === "string" && (head.startsWith("cmux") || head === "session")
}

const tabFile: Record<string, SettingsFile | undefined> = {
  general: "worktree",
  "watcher-auth": "watcher_auth",
  "watcher-config": "watcher_config",
}

/**
 * The home page's settings. The three config tabs share one draft and one
 * Save/Discard footer; secrets are replaced in place by SecretField and
 * never sit in the draft. Devices manages logins and has no draft.
 */
export function SettingsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<string | null>("general")
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

  const refetchAfterSecret = async () => {
    try {
      const fresh = await qc.fetchQuery({ queryKey: settingsKey, queryFn: api.settings })
      draft.rebase(fresh)
    } catch {
      // The replace itself succeeded; the next open or refetch picks up the new *_set flags.
    }
  }

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
    const out = await draft.save()
    if (out.saved.includes("watcher_config")) setResetToken((n) => n + 1)
    if (out.settings) qc.setQueryData(settingsKey, out.settings)
    if (wasCmux && out.saved.includes("worktree")) void qc.invalidateQueries({ predicate: affectedByCmux })
  }

  const label = (name: string, value: string) => {
    const f = tabFile[value]
    return <>{name}{f && draft.dirty[f] ? <Text span c="orange" ml={4}>●</Text> : null}</>
  }

  const body = (() => {
    if (settings.error && !settings.data) return <Alert color="red" title="Couldn't load settings">{settings.error.message}</Alert>
    if (settings.isLoading || (settings.data && !draft.drafts)) return <Loader size="sm" />
    return null
  })()

  return (
    <Modal opened={opened} onClose={requestClose} title="Settings" size="lg">
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="general">{label("General", "general")}</Tabs.Tab>
          <Tabs.Tab value="watcher-auth">{label("Watcher Auth", "watcher-auth")}</Tabs.Tab>
          <Tabs.Tab value="watcher-config">{label("Watcher Config", "watcher-config")}</Tabs.Tab>
          <Tabs.Tab value="devices">Devices</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="general" pt="md">
          {body ?? (settings.data && draft.drafts && (
            <GeneralPanel
              settings={settings.data}
              draft={draft.drafts.worktree}
              update={(fn) => draft.update("worktree", fn)}
              error={draft.errors.worktree}
              onSecretSaved={refetchAfterSecret}
              onShowWatcherAuth={() => setTab("watcher-auth")}
            />
          ))}
        </Tabs.Panel>
        <Tabs.Panel value="watcher-auth" pt="md">
          {body ?? (settings.data && draft.drafts && (
            <WatcherAuthPanel
              settings={settings.data}
              draft={draft.drafts.watcher_auth}
              update={(fn) => draft.update("watcher_auth", fn)}
              error={draft.errors.watcher_auth}
              active={opened && tab === "watcher-auth"}
              onSecretSaved={refetchAfterSecret}
            />
          ))}
        </Tabs.Panel>
        <Tabs.Panel value="watcher-config" pt="md">
          {body ?? (settings.data && draft.drafts && (
            <WatcherConfigPanel
              key={resetToken}
              settings={settings.data}
              draft={draft.drafts.watcher_config}
              update={(fn) => draft.update("watcher_config", fn)}
              error={draft.errors.watcher_config}
            />
          ))}
        </Tabs.Panel>
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
