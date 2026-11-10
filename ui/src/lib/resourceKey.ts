/** Identifies one resource within a worktree. */
export interface ResourceKey {
  type: string
  id: string
}

/**
 * Encodes a key for the `?resource=` query param as `<type>:<encoded id>`.
 * The id is percent-encoded because ids legitimately contain `/`, `#`, and
 * (for Slack threads) `:`.
 */
export function serializeResourceKey(key: ResourceKey): string {
  return `${key.type}:${encodeURIComponent(key.id)}`
}

/**
 * The `resource=<value>` query fragment for a link built by hand, encoded the
 * way `URLSearchParams.set` (useSelectedResource) encodes it, so both kinds
 * of link read back the same. Never interpolate serializeResourceKey into a
 * query string directly: that drops a layer of encoding, and an id holding a
 * literal percent-escape (`a%20b`) would read back decoded (`a b`).
 */
export function resourceParam(key: ResourceKey): string {
  return `resource=${encodeURIComponent(serializeResourceKey(key))}`
}

/**
 * Parses a `?resource=` value. Splits on the FIRST colon only: a Slack
 * resource id is itself `channel:threadTs`, so everything after the first
 * colon belongs to the id. Returns null for anything malformed rather than
 * throwing, so a stale or hand-edited URL degrades to "nothing selected".
 */
export function parseResourceKey(raw: string | null | undefined): ResourceKey | null {
  if (!raw) return null
  const idx = raw.indexOf(":")
  if (idx <= 0) return null
  const type = raw.slice(0, idx)
  const rest = raw.slice(idx + 1)
  if (!type || !rest) return null
  let id: string
  try {
    id = decodeURIComponent(rest)
  } catch {
    id = rest // malformed percent-encoding: use the raw remainder
  }
  return { type, id }
}

export function resourceKeyEquals(a: ResourceKey | null, b: ResourceKey | null): boolean {
  if (a === null || b === null) return a === b
  return a.type === b.type && a.id === b.id
}
