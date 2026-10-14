import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "../../api/client"
import type { Settings, WatcherAuthSettings, WatcherConfigSettings, WorktreeSettings } from "../../api/types"

export type SettingsFile = "worktree" | "watcher_auth" | "watcher_config"
export interface Drafts {
  worktree: WorktreeSettings
  watcher_auth: WatcherAuthSettings
  watcher_config: WatcherConfigSettings
}

const FILES: SettingsFile[] = ["worktree", "watcher_auth", "watcher_config"]

const savers: { [F in SettingsFile]: (d: Drafts[F]) => Promise<Settings> } = {
  worktree: (d) => api.saveWorktreeSettings(d),
  watcher_auth: (d) => api.saveWatcherAuthSettings(d),
  watcher_config: (d) => api.saveWatcherConfigSettings(d),
}

/** JSON with object keys sorted, so a reordered map isn't a change. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  )
}

const pick = (s: Settings): Drafts => ({ worktree: s.worktree, watcher_auth: s.watcher_auth, watcher_config: s.watcher_config })

/**
 * The Settings modal's edit buffer: one draft per file, compared with the
 * server's values for dirty state. Secrets are not in here — SecretField
 * replaces them directly.
 */
export function useSettingsDraft(server: Settings | undefined) {
  const [base, setBase] = useState<Drafts | null>(server ? pick(server) : null)
  const [drafts, setDrafts] = useState<Drafts | null>(server ? pick(server) : null)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<SettingsFile, string>>>({})

  // First load only; later server values arrive through save/rebase so a
  // background refetch never clobbers edits in progress.
  useEffect(() => {
    if (server && !base) {
      setBase(pick(server))
      setDrafts(pick(server))
    }
  }, [server, base])

  const dirty = useMemo(() => {
    const out = { worktree: false, watcher_auth: false, watcher_config: false }
    if (base && drafts) for (const f of FILES) out[f] = canonical(base[f]) !== canonical(drafts[f])
    return out
  }, [base, drafts])

  const restartCount = useMemo(() => {
    if (!base || !drafts) return 0
    const a = base.worktree.ui
    const b = drafts.worktree.ui
    return [
      a.https_port !== b.https_port,
      canonical(a.allowed_hosts) !== canonical(b.allowed_hosts),
      a.tls.cert_file !== b.tls.cert_file,
      a.tls.key_file !== b.tls.key_file,
    ].filter(Boolean).length
  }, [base, drafts])

  const update = useCallback(<F extends SettingsFile>(file: F, fn: (d: Drafts[F]) => Drafts[F]) => {
    setDrafts((d) => (d ? { ...d, [file]: fn(d[file]) } : d))
  }, [])

  const discard = useCallback(() => {
    setDrafts(base)
    setErrors({})
  }, [base])

  /** New server values for every file that has no unsaved edits. */
  const rebase = useCallback((s: Settings) => {
    const next = pick(s)
    setBase((b) => {
      setDrafts((d) => {
        if (!d || !b) return next
        const out = { ...d }
        for (const f of FILES) if (canonical(b[f]) === canonical(d[f])) (out as Record<SettingsFile, unknown>)[f] = next[f]
        return out
      })
      return next
    })
  }, [])

  const save = useCallback(async () => {
    const saved: SettingsFile[] = []
    const errs: Partial<Record<SettingsFile, string>> = {}
    let latest: Settings | undefined
    if (!drafts) return { saved, errors: errs }
    setSaving(true)
    for (const f of FILES) {
      if (!dirty[f]) continue
      try {
        latest = await (savers[f] as (d: unknown) => Promise<Settings>)(drafts[f])
        saved.push(f)
        const fresh = pick(latest)[f]
        setBase((b) => (b ? { ...b, [f]: fresh } : b))
        setDrafts((d) => (d ? { ...d, [f]: fresh } : d))
      } catch (e) {
        errs[f] = e instanceof Error ? e.message : String(e)
      }
    }
    setErrors(errs)
    setSaving(false)
    return { saved, errors: errs, settings: latest }
  }, [drafts, dirty])

  return { drafts, dirty, anyDirty: FILES.some((f) => dirty[f]), restartCount, update, discard, save, saving, errors, rebase }
}
