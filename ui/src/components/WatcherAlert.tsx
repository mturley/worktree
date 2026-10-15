import { Alert, Anchor } from "@mantine/core"
import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
import type { CredService } from "../api/types"
import { useOpenSettings } from "./settings/SettingsContext"
import { serviceForType, serviceName } from "./settings/watcherText"

/** Same idle rate as useWatchers: health only changes when a poll lands or Settings saves. */
const HEALTH_MS = 15_000

export function useWatcherHealth() {
  return useQuery({
    queryKey: ["watcher-health"],
    queryFn: api.watcherHealth,
    refetchInterval: HEALTH_MS,
    placeholderData: (prev) => prev,
  })
}

/**
 * On a resource's detail view, says when its service's watcher is off, or
 * when every poll of that service is failing (bad credentials, most likely,
 * or no network) — the latter goes away by itself after one successful
 * poll. Either way, with a link to that service's Settings tab.
 */
export function WatcherAlert({ type }: { type: string }) {
  const svc = serviceForType(type)
  const health = useWatcherHealth()
  const openSettings = useOpenSettings()
  const h = svc ? health.data?.[svc] : undefined
  if (!svc || !h) return null
  const link = (text: string) => openSettings
    ? <Anchor component="button" type="button" fz="sm" onClick={() => openSettings({ tab: "connected", service: svc as CredService })}>{text}</Anchor>
    : text
  const name = serviceName[svc]
  if (!h.enabled) {
    return (
      <Alert color="yellow" variant="light" p="xs" data-testid="watcher-alert">
        The {name} watcher is disabled. No new activity will appear. {link("Re-enable it in settings")}
      </Alert>
    )
  }
  if (h.failing) {
    return (
      <Alert color="red" variant="light" p="xs" data-testid="watcher-alert" title={undefined}>
        {name} authentication failed. Check your internet connection or {link("replace your token in settings")}
      </Alert>
    )
  }
  return null
}
