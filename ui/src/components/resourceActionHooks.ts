import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import { cmuxBrowserTabsKey } from "../api/cmux"
import type { CmuxBrowserTab } from "../api/types"

const COPIED_FEEDBACK_MS = 1500

/** Copy a URL with brief "Copied!" feedback. Shared by every copy-link button. */
export function useCopyLink(url: string) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    } catch {
      // Clipboard access can be denied; failing silently beats an error
      // state on a convenience.
    }
  }
  return { copied, copy }
}

/**
 * Switch cmux to the tab already showing `url`. If the tab has gone since
 * the last poll, open the URL anyway and re-read the tabs so the label stops
 * claiming one.
 */
export function useSwitchToTab(url: string, existing: CmuxBrowserTab) {
  const qc = useQueryClient()
  return async () => {
    let ok = false
    try {
      ok = (await api.cmuxFocusTab(existing.workspaceId, existing.surface)).ok
    } catch {
      // Treated like a refusal below.
    }
    if (ok) return
    window.open(url, "_blank", "noreferrer")
    void qc.invalidateQueries({ queryKey: cmuxBrowserTabsKey })
  }
}
