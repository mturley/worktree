import type { AutocompleteItem, User, UserGroup } from '../../../api/slackApi'
import { tokenFor } from './tokens'

export interface LocalContext {
  /** Thread participants, already loaded by the thread view. */
  users: Record<string, User>
  /** Workspace user groups, already loaded by the thread view. */
  groups: Record<string, UserGroup>
}

const SPECIALS: Array<{ id: string; detail: string }> = [
  { id: 'here', detail: 'Notify everyone online in this channel' },
  { id: 'channel', detail: 'Notify everyone in this channel' },
  { id: 'everyone', detail: 'Notify everyone in the workspace' },
]

function matches(query: string, ...fields: Array<string | undefined>): boolean {
  const q = query.toLowerCase()
  return fields.some((f) => (f ?? '').toLowerCase().includes(q))
}

/**
 * Candidates answerable instantly from data the thread view already holds, so
 * the menu paints on the first keystroke rather than after a round trip.
 * The server's results are merged in when they arrive (see mergeCandidates).
 *
 * Only "@" has local answers: emoji and channels are not part of the thread
 * payload.
 */
export function localCandidates(
  trigger: '@' | ':' | '#',
  query: string,
  ctx: LocalContext,
): AutocompleteItem[] {
  if (trigger !== '@') {
    return []
  }
  const out: AutocompleteItem[] = []

  for (const u of Object.values(ctx.users)) {
    if (query && !matches(query, u.DisplayName, u.RealName, u.Name)) {
      continue
    }
    out.push({
      kind: 'user',
      id: u.ID,
      label: u.DisplayName || u.RealName || u.Name || u.ID,
      detail: u.Name,
      avatar: u.Avatar72,
      token: tokenFor({ kind: 'user', id: u.ID }),
    })
  }

  for (const g of Object.values(ctx.groups)) {
    if (query && !matches(query, g.Handle, g.Name)) {
      continue
    }
    out.push({
      kind: 'group',
      id: g.ID,
      label: `@${g.Handle || g.Name}`,
      detail: g.Name,
      token: tokenFor({ kind: 'group', id: g.ID }),
    })
  }

  for (const s of SPECIALS) {
    if (query && !s.id.includes(query.toLowerCase())) {
      continue
    }
    out.push({
      kind: 'special',
      id: s.id,
      label: `@${s.id}`,
      detail: s.detail,
      token: tokenFor({ kind: 'special', id: s.id }),
    })
  }

  return out
}

/**
 * Merges server results into the locally-derived list, deduping on
 * (kind, id) with local entries winning.
 *
 * Consequence, by design: the menu can reorder ONCE, when remote results
 * land. It never reorders after that, and the caller tracks the highlighted
 * item by (kind, id) rather than by index so a merge cannot move the
 * selection under the user's keyboard.
 */
export function mergeCandidates(
  local: AutocompleteItem[],
  remote: AutocompleteItem[],
): AutocompleteItem[] {
  const seen = new Set(local.map((c) => `${c.kind}:${c.id}`))
  return [...local, ...remote.filter((c) => !seen.has(`${c.kind}:${c.id}`))]
}
