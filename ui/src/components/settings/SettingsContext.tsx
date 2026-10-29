import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import type { CredService } from "../../api/types"
import { SettingsModal } from "../SettingsModal"

/** Where to open the Settings modal: a top-level tab and, for Connected Services, a service. */
export interface SettingsTarget {
  tab: "general" | "connected" | "notifications" | "ui-access" | "devices" | "logs"
  service?: CredService
}

const SETTINGS_TABS: SettingsTarget["tab"][] = ["general", "connected", "notifications", "ui-access", "devices", "logs"]

const Ctx = createContext<((target?: SettingsTarget) => void) | null>(null)

/**
 * The app's one Settings modal, openable from anywhere — the home page's
 * cog, or a "Re-enable it in Settings" link on a worktree page — at a
 * given tab.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState(false)
  const [target, setTarget] = useState<SettingsTarget | undefined>()
  const open = useCallback((t?: SettingsTarget) => {
    setTarget(t)
    setOpened(true)
  }, [])
  const close = useCallback(() => setOpened(false), [])
  const value = useMemo(() => open, [open])
  // A ?settings deep link (from the menu bar app's "More settings in web UI")
  // opens the modal once, then drops the param so a reload does not reopen it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (!params.has("settings")) return
    const tab = params.get("settings") as SettingsTarget["tab"] | ""
    open(tab && SETTINGS_TABS.includes(tab) ? { tab } : undefined)
    params.delete("settings")
    const rest = params.toString()
    window.history.replaceState(window.history.state, "", window.location.pathname + (rest ? "?" + rest : "") + window.location.hash)
  }, [open])
  return (
    <Ctx.Provider value={value}>
      {children}
      <SettingsModal opened={opened} onClose={close} target={target} />
    </Ctx.Provider>
  )
}

/** Opens Settings at a tab; null outside a SettingsProvider (some tests). */
export function useOpenSettings() {
  return useContext(Ctx)
}
