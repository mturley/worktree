import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
import type { NotifyMode } from "../api/types"

/** The server's delivery path, from the session query the app already holds. */
export function useNotifyMode(): NotifyMode | undefined {
  return useQuery({ queryKey: ["session"], queryFn: api.session, retry: false, staleTime: Infinity }).data?.notify_mode
}
