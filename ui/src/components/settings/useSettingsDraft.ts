import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  const [base, setBaseState] = useState<Drafts | null>(server ? pick(server) : null)
  const [drafts, setDraftsState] = useState<Drafts | null>(server ? pick(server) : null)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<SettingsFile, string>>>({})
  // Refs mirror the state so callbacks read current values and never call one
  // setter from inside another's updater (updaters must be pure).
  const baseRef = useRef(base)
  const draftsRef = useRef(drafts)
  const savingRef = useRef(false)
  // Files whose draft fails client-side validation: save() skips them.
  const invalidRef = useRef<Partial<Record<SettingsFile, string>>>({})
  const [invalid, setInvalidState] = useState<Partial<Record<SettingsFile, string>>>({})
  const setBase = useCallback((v: Drafts | null) => { baseRef.current = v; setBaseState(v) }, [])
  const setDrafts = useCallback((v: Drafts | null) => { draftsRef.current = v; setDraftsState(v) }, [])

  // First load only; later server values arrive through save/rebase so a
  // background refetch never clobbers edits in progress.
  useEffect(() => {
    if (server && !baseRef.current) {
      setBase(pick(server))
      setDrafts(pick(server))
    }
  }, [server, setBase, setDrafts])

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
    const d = draftsRef.current
    if (d) setDrafts({ ...d, [file]: fn(d[file]) })
  }, [setDrafts])

  /** Mark a file's draft invalid (message) or valid again (null). */
  const setInvalid = useCallback((file: SettingsFile, message: string | null) => {
    const next = { ...invalidRef.current }
    if (message) next[file] = message
    else delete next[file]
    invalidRef.current = next
    setInvalidState(next)
  }, [])

  const discard = useCallback(() => {
    invalidRef.current = {}
    setInvalidState({})
    setDrafts(baseRef.current)
    setErrors({})
  }, [setDrafts])

  /** New server values for every file that has no unsaved edits. */
  const rebase = useCallback((s: Settings) => {
    const next = pick(s)
    const b = baseRef.current
    const d = draftsRef.current
    if (!d || !b) {
      setDrafts(next)
    } else {
      const out = { ...d }
      for (const f of FILES) if (canonical(b[f]) === canonical(d[f])) (out as Record<SettingsFile, unknown>)[f] = next[f]
      setDrafts(out)
    }
    setBase(next)
  }, [setBase, setDrafts])

  const save = useCallback(async () => {
    const saved: SettingsFile[] = []
    const errs: Partial<Record<SettingsFile, string>> = {}
    let latest: Settings | undefined
    if (savingRef.current || !draftsRef.current || !baseRef.current) return { saved, errors: errs }
    savingRef.current = true
    setSaving(true)
    try {
      for (const f of FILES) {
        const sent = draftsRef.current?.[f]
        const b = baseRef.current
        if (!sent || !b || canonical(b[f]) === canonical(sent)) continue
        const bad = invalidRef.current[f]
        if (bad) {
          errs[f] = bad
          continue
        }
        try {
          latest = await (savers[f] as (d: unknown) => Promise<Settings>)(sent)
          saved.push(f)
          const fresh = pick(latest)[f]
          if (baseRef.current) setBase({ ...baseRef.current, [f]: fresh })
          // Keep edits made while the PUT was in flight; the baseline still moves.
          const cur = draftsRef.current
          if (cur && canonical(cur[f]) === canonical(sent)) setDrafts({ ...cur, [f]: fresh })
        } catch (e) {
          errs[f] = e instanceof Error ? e.message : String(e)
        }
      }
      setErrors(errs)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
    return { saved, errors: errs, settings: latest }
  }, [setBase, setDrafts])

  return { drafts, dirty, anyDirty: FILES.some((f) => dirty[f]), restartCount, update, discard, save, saving, errors, rebase, setInvalid, invalid }
}
