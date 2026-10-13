import { useState } from "react"
import { Alert, Loader, Modal, Stack, Tabs } from "@mantine/core"
import { useMutation, useQuery, useQueryClient, type Query } from "@tanstack/react-query"
import { api } from "../api/client"
import { DevicesPanel } from "./DevicesPanel"
import { Toggle } from "./Toggle"

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

/** The cmux toggle, and the settings that join it later. */
function GeneralPanel({ active }: { active: boolean }) {
  const qc = useQueryClient()
  const settings = useQuery({ queryKey: settingsKey, queryFn: api.settings, enabled: active })
  const update = useMutation({
    mutationFn: (patch: { cmux_features_enabled: boolean }) => api.updateSettings(patch),
    onSuccess: (next) => {
      qc.setQueryData(settingsKey, next)
      // The server's gate has already moved; refetch what it gates so cmux
      // controls appear or vanish now rather than on the next interval.
      void qc.invalidateQueries({ predicate: affectedByCmux })
    },
  })

  if (settings.isLoading) return <Loader size="sm" />
  if (settings.error) {
    return <Alert color="red" title="Couldn't load settings">{settings.error.message}</Alert>
  }
  const inCmux = settings.data?.in_cmux === true
  // While a save is in flight, show the value being saved.
  const enabled = update.isPending ? update.variables.cmux_features_enabled : settings.data?.cmux_features_enabled !== false

  return (
    <Stack gap="sm">
      <Toggle
        label="Enable cmux features"
        description="Workspace headers, tab controls, Follow cmux focus, cmux notifications and the 📬 unread title prefix."
        checked={enabled}
        disabled={!inCmux || update.isPending}
        onChange={(e) => update.mutate({ cmux_features_enabled: e.currentTarget.checked })}
        tooltip={inCmux ? undefined : "The worktree UI server is not running inside cmux, so there are no cmux features to turn on or off."}
      />
      {update.error && (
        <Alert color="red" title="Couldn't save the setting">{update.error.message}</Alert>
      )}
    </Stack>
  )
}

/** The home page's settings: General, and every logged-in device. */
export function SettingsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<string | null>("general")
  return (
    <Modal opened={opened} onClose={onClose} title="Settings" size="lg">
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="general">General</Tabs.Tab>
          <Tabs.Tab value="devices">Devices</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="general" pt="md">
          <GeneralPanel active={opened && tab === "general"} />
        </Tabs.Panel>
        <Tabs.Panel value="devices" pt="md">
          <DevicesPanel active={opened && tab === "devices"} />
        </Tabs.Panel>
      </Tabs>
    </Modal>
  )
}
