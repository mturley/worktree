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

  it('has nothing local to offer for : and #', () => {
    expect(localCandidates(':', 'tad', ctx)).toEqual([])
    expect(localCandidates('#', 'odh', ctx)).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(localCandidates('@', 'ADA', ctx).map((c) => c.id)).toEqual(['U1'])
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
