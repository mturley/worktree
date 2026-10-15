import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
import type { NotifyMode } from "../api/types"

const useSession = () => useQuery({ queryKey: ["session"], queryFn: api.session, retry: false, staleTime: Infinity })

/** The server's delivery path, from the session query the app already holds. */
export function useNotifyMode(): NotifyMode | undefined {
  return useSession().data?.notify_mode
}

/** Shown on every notify toggle while Settings has notifications off. */
export const NOTIFICATIONS_DISABLED_REASON = "Notifications are disabled in settings"

/**
 * The Settings modal's "Enable notifications". Off, every notify toggle is
 * disabled and the bells hide; the stored toggles stay, so turning it back on
 * restores them. Unknown (still loading) counts as on.
 */
export function useNotificationsEnabled(): boolean {
  return useSession().data?.notifications_enabled !== false
}
