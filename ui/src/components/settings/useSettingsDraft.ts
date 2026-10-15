import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../../api/client"
import type { CredService, Settings, WatcherAuthSettings, WatcherConfigSettings, WorktreeSettings } from "../../api/types"

export type SettingsFile = "worktree" | "watcher_auth" | "watcher_config"
export interface Drafts {
  worktree: WorktreeSettings
  watcher_auth: WatcherAuthSettings
  watcher_config: WatcherConfigSettings
}

const FILES: SettingsFile[] = ["worktree", "watcher_auth", "watcher_config"]

/** A secret held unsaved in the modal: already tested (if testable), written on Save. */
export type SecretKey = "ui_password" | "github_token" | "jira_token" | "slack_token" | "slack_cookie"
export type PendingSecrets = Partial<Record<SecretKey, string>>
const secretFile: Record<SecretKey, SettingsFile> = {
  ui_password: "worktree",
  github_token: "watcher_auth",
  jira_token: "watcher_auth",
  slack_token: "watcher_auth",
  slack_cookie: "watcher_auth",
}
const hasPending = (p: PendingSecrets, f: SettingsFile) =>
  (Object.keys(p) as SecretKey[]).some((k) => secretFile[k] === f)

const savers: { [F in SettingsFile]: (d: Drafts[F]) => Promise<Settings> } = {
  worktree: (d) => api.saveWorktreeSettings(d),
  watcher_auth: (d) => api.saveWatcherAuthSettings(d),
  watcher_config: (d) => api.saveWatcherConfigSettings(d),
}

/** JSON with object keys sorted, so a reordered map isn't a change. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  )
}

const pick = (s: Settings): Drafts => ({ worktree: s.worktree, watcher_auth: s.watcher_auth, watcher_config: s.watcher_config })

/**
 * The Settings modal's edit buffer: one draft per file, compared with the
 * server's values for dirty state, plus the secrets replaced but not yet
 * saved. Secrets are never in the server values; a pending one lives only
 * here, in memory, until Save writes it or Discard drops it.
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
  const [secrets, setSecretsState] = useState<PendingSecrets>({})
  const secretsRef = useRef(secrets)
  const setSecrets = useCallback((v: PendingSecrets) => { secretsRef.current = v; setSecretsState(v) }, [])
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
    if (base && drafts) for (const f of FILES) out[f] = canonical(base[f]) !== canonical(drafts[f]) || hasPending(secrets, f)
    return out
  }, [base, drafts, secrets])

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

  /** Hold a secret for Save (value), or drop the pending one (null). */
  const setSecret = useCallback((key: SecretKey, value: string | null) => {
    const next = { ...secretsRef.current }
    if (value === null) delete next[key]
    else next[key] = value
    setSecrets(next)
  }, [setSecrets])

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
    setSecrets({})
    setErrors({})
  }, [setDrafts, setSecrets])

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
    const startDrafts = draftsRef.current
    if (savingRef.current || !startDrafts || !baseRef.current) return { saved, errors: errs }
    savingRef.current = true
    setSaving(true)
    try {
      // Skipped (not just empty) without pending secrets: awaiting it would let
      // an edit made just after Save leak into the files read below.
      const secretsOut = Object.keys(secretsRef.current).length
        ? await saveSecrets(startDrafts, secretsRef.current)
        : { errors: {}, written: [] }
      Object.assign(errs, secretsOut.errors)
      if (secretsOut.written.length) {
        // Drop only what was written, and only if it wasn't changed meanwhile.
        const next = { ...secretsRef.current }
        for (const [k, v] of secretsOut.written) if (next[k] === v) delete next[k]
        setSecrets(next)
        // The replaces changed auth.yaml (Jira host/email, Slack's domain):
        // adopt those, keeping any field the user has edited since loading.
        try {
          latest = await api.settings()
          const b = baseRef.current
          const d = draftsRef.current
          if (b && d) {
            setBase({ ...b, watcher_auth: latest.watcher_auth })
            setDrafts({ ...d, watcher_auth: keepEdits(b.watcher_auth, d.watcher_auth, latest.watcher_auth) })
          }
        } catch {
          // The secrets are saved; the next refetch picks up their *_set flags.
        }
      }
      for (const f of FILES) {
        const sent = draftsRef.current?.[f]
        const b = baseRef.current
        if (!sent || !b || canonical(b[f]) === canonical(sent)) continue
        // A refused credential leaves its file unsaved: Jira's host change,
        // for one, only makes sense with the token that failed.
        if (errs[f]) continue
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
  }, [setBase, setDrafts, setSecrets])

  return { drafts, dirty, anyDirty: FILES.some((f) => dirty[f]), restartCount, update, discard, save, saving, errors, rebase, setInvalid, invalid, secrets, setSecret }
}

/** Each watcher_auth field the user left as loaded takes the fresh value. */
function keepEdits(base: WatcherAuthSettings, draft: WatcherAuthSettings, fresh: WatcherAuthSettings): WatcherAuthSettings {
  const pick = (b: string, d: string, f: string) => (b === d ? f : d)
  return {
    jira: { host: pick(base.jira.host, draft.jira.host, fresh.jira.host), email: pick(base.jira.email, draft.jira.email, fresh.jira.email) },
    slack: { workspace_domain: pick(base.slack.workspace_domain, draft.slack.workspace_domain, fresh.slack.workspace_domain) },
  }
}

const credLabel = { github: "GitHub token", jira: "Jira API token", slack: "Slack credentials" } as const

/**
 * Writes every pending secret, each through its validate-then-write route.
 * A refused one stays pending with an error on its file. Returns what was
 * written, as [key, value] pairs.
 */
async function saveSecrets(drafts: Drafts, pending: PendingSecrets) {
  const errors: Partial<Record<SettingsFile, string>> = {}
  const written: [SecretKey, string][] = []
  const fail = (f: SettingsFile, msg: string) => { errors[f] = errors[f] ? `${errors[f]} ${msg}` : msg }

  if (pending.ui_password !== undefined) {
    try {
      await api.replacePassword(pending.ui_password)
      written.push(["ui_password", pending.ui_password])
    } catch (e) {
      fail("worktree", `UI password: ${e instanceof Error ? e.message : String(e)}.`)
    }
  }
  const creds: [CredService, SecretKey[], Parameters<typeof api.replaceCredential>[1]][] = []
  if (pending.github_token !== undefined) creds.push(["github", ["github_token"], { token: pending.github_token }])
  if (pending.jira_token !== undefined) {
    creds.push(["jira", ["jira_token"], { token: pending.jira_token, host: drafts.watcher_auth.jira.host, email: drafts.watcher_auth.jira.email }])
  }
  if (pending.slack_token !== undefined || pending.slack_cookie !== undefined) {
    creds.push(["slack", ["slack_token", "slack_cookie"], { token: pending.slack_token, cookie: pending.slack_cookie }])
  }
  for (const [svc, keys, body] of creds) {
    try {
      const r = await api.replaceCredential(svc, body)
      if (r.ok) {
        for (const k of keys) {
          const v = pending[k]
          if (v !== undefined) written.push([k, v])
        }
      } else {
        fail("watcher_auth", `${credLabel[svc]}: ${r.detail || r.kind}. It was not saved.`)
      }
    } catch (e) {
      fail("watcher_auth", `${credLabel[svc]}: ${e instanceof Error ? e.message : String(e)}. It was not saved.`)
    }
  }
  return { errors, written }
}
