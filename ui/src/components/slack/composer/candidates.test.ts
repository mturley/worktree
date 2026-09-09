import { describe, it, expect } from 'vitest'
import { localCandidates, mergeCandidates } from './candidates'
import type { AutocompleteItem } from '../../../api/slackApi'

const ctx = {
  users: {
    U1: { ID: 'U1', Name: 'aroberts', RealName: 'Ada Roberts', DisplayName: 'ada', Avatar72: 'a.png' },
    U2: { ID: 'U2', Name: 'bmorse', RealName: 'Ben Morse', DisplayName: '', Avatar72: 'b.png' },
  },
  groups: {
    S1: { ID: 'S1', Name: 'Platform Team', Handle: 'platform' },
  },
}

describe('localCandidates', () => {
  it('matches thread participants on display name, real name and handle', () => {
    expect(localCandidates('@', 'ada', ctx).map((c) => c.id)).toEqual(['U1'])
    expect(localCandidates('@', 'morse', ctx).map((c) => c.id)).toEqual(['U2'])
    expect(localCandidates('@', 'arob', ctx).map((c) => c.id)).toEqual(['U1'])
  })

  it('builds tokens for local candidates', () => {
    expect(localCandidates('@', 'ada', ctx)[0].token).toBe('<@U1>')
    expect(localCandidates('@', 'platform', ctx)[0].token).toBe('<!subteam^S1>')
  })

  it('includes the specials, and shows all three for a bare trigger', () => {
    expect(localCandidates('@', 'her', ctx).map((c) => c.id)).toContain('here')
    const bare = localCandidates('@', '', ctx)
    expect(bare.filter((c) => c.kind === 'special')).toHaveLength(3)
  })

  it('has nothing local to offer for #', () => {
    // Channels are not part of the thread payload; only the server can answer.
    expect(localCandidates('#', 'odh', ctx)).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(localCandidates('@', 'ADA', ctx).map((c) => c.id)).toEqual(['U1'])
  })
})

describe('localCandidates for :', () => {
  // The Unicode half of the emoji menu is matched client-side from node-emoji
  // and merged with the server's CUSTOM-emoji results; the server has no
  // Unicode emoji to offer at all (see the design's "Emoji needs no Slack
  // call"). Without this, ":smi" finds nothing in a workspace with no custom
  // "smile".
  it('offers standard Unicode emoji matching the query', () => {
    const ids = localCandidates(':', 'smi', ctx).map((c) => c.id)
    expect(ids).toContain('smile')
    expect(ids).toContain('smiley')
  })

  it('builds a :name: token and marks the candidate as an emoji', () => {
    const smile = localCandidates(':', 'smile', ctx).find((c) => c.id === 'smile')
    expect(smile).toMatchObject({ kind: 'emoji', label: ':smile:', token: ':smile:' })
    // No imageUrl: a standard emoji renders as the character itself, resolved
    // by name through the shared lib/emoji machinery.
    expect(smile?.imageUrl).toBeUndefined()
  })

  it('offers nothing for a bare :', () => {
    expect(localCandidates(':', '', ctx)).toEqual([])
  })

  it('caps the list so a broad query cannot flood the menu', () => {
    expect(localCandidates(':', 'a', ctx).length).toBeLessThanOrEqual(25)
  })
})

describe('mergeCandidates', () => {
  const local: AutocompleteItem[] = [{ kind: 'user', id: 'U1', label: 'ada', token: '<@U1>' }]
  const remote: AutocompleteItem[] = [
    { kind: 'user', id: 'U1', label: 'ada (remote)', token: '<@U1>' },
    { kind: 'user', id: 'U9', label: 'zoe', token: '<@U9>' },
  ]

  it('keeps local entries first and drops the remote duplicate', () => {
    expect(mergeCandidates(local, remote)).toEqual([local[0], remote[1]])
  })

  it('dedupes on kind AND id, so a user and a channel sharing an id both survive', () => {
    const a: AutocompleteItem[] = [{ kind: 'user', id: 'X', label: 'u', token: '<@X>' }]
    const b: AutocompleteItem[] = [{ kind: 'channel', id: 'X', label: '#c', token: '<#X|c>' }]
    expect(mergeCandidates(a, b)).toHaveLength(2)
  })

  it('returns remote alone when there is nothing local', () => {
    expect(mergeCandidates([], remote)).toEqual(remote)
  })
})

describe('mergeCandidates with emoji', () => {
  it('shows a custom workspace emoji alongside the Unicode ones, one row per name', () => {
    const local = localCandidates(':', 'smile', ctx)
    const remote: AutocompleteItem[] = [
      { kind: 'emoji', id: 'smile-cry', label: ':smile-cry:', imageUrl: 'https://e/x.png', token: ':smile-cry:' },
      { kind: 'emoji', id: 'smile', label: ':smile:', imageUrl: 'https://e/y.png', token: ':smile:' },
    ]
    const merged = mergeCandidates(local, remote)
    expect(merged.filter((c) => c.id === 'smile')).toHaveLength(1)
    expect(merged.map((c) => c.id)).toContain('smile-cry')
  })
})
