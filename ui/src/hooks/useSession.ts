import { useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api, HttpError, LOGIN_REQUIRED_EVENT } from "../api/client"

export type SessionState = "loading" | "authenticated" | "unauthenticated" | "error"

/**
 * Whether this browser is logged in. Refetches whenever any request reports
 * that login is required, e.g. after this device was revoked elsewhere.
 */
export function useSession(): { state: SessionState; error: unknown; retry: () => void } {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false, staleTime: Infinity })

  useEffect(() => {
    const onLoginRequired = () => { void qc.invalidateQueries({ queryKey: ["session"] }) }
    window.addEventListener(LOGIN_REQUIRED_EVENT, onLoginRequired)
    return () => window.removeEventListener(LOGIN_REQUIRED_EVENT, onLoginRequired)
  }, [qc])

  const retry = () => { void q.refetch() }
  if (q.isPending) return { state: "loading", error: null, retry }
  // Checked before data: after a refetch fails, TanStack keeps the last
  // successful data alongside the new error.
  if (q.error instanceof HttpError && q.error.status === 401) return { state: "unauthenticated", error: null, retry }
  if (q.isError) return { state: "error", error: q.error, retry }
  return { state: "authenticated", error: null, retry }
}
