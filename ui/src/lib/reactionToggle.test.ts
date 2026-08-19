import { describe, it, expect } from 'vitest'
import { applyReactionToggle } from './reactionToggle'
import type { Message } from '../api/slackApi'

function msg(ts: string, reactions: Message['Reactions']): Message {
  return { TS: ts, UserID: 'U0', Text: '', Blocks: null, Reactions: reactions, Edited: false, Files: null, Attachments: null }
}

describe('applyReactionToggle', () => {
  it('add: bumps count and appends the user id', () => {
    const out = applyReactionToggle([msg('1', [{ Name: 'tada', Count: 1, UserIDs: ['U2'] }])], '1', 'tada', 'U1', true)
    expect(out[0].Reactions![0]).toEqual({ Name: 'tada', Count: 2, UserIDs: ['U2', 'U1'] })
  })

  it('remove: decrements count and drops the user id', () => {
    const out = applyReactionToggle([msg('1', [{ Name: 'tada', Count: 2, UserIDs: ['U2', 'U1'] }])], '1', 'tada', 'U1', false)
    expect(out[0].Reactions![0]).toEqual({ Name: 'tada', Count: 1, UserIDs: ['U2'] })
  })

  it('remove: removes the pill when count reaches 0', () => {
    const out = applyReactionToggle([msg('1', [{ Name: 'tada', Count: 1, UserIDs: ['U1'] }])], '1', 'tada', 'U1', false)
    expect(out[0].Reactions).toEqual([])
  })

  it('add: no-op when the user already reacted', () => {
    const before = [msg('1', [{ Name: 'tada', Count: 1, UserIDs: ['U1'] }])]
    const out = applyReactionToggle(before, '1', 'tada', 'U1', true)
    expect(out[0].Reactions![0]).toEqual({ Name: 'tada', Count: 1, UserIDs: ['U1'] })
  })

  it('remove: no-op when the user had not reacted', () => {
    const out = applyReactionToggle([msg('1', [{ Name: 'tada', Count: 1, UserIDs: ['U2'] }])], '1', 'tada', 'U1', false)
    expect(out[0].Reactions![0]).toEqual({ Name: 'tada', Count: 1, UserIDs: ['U2'] })
  })

  it('leaves other messages and other reactions untouched', () => {
    const before = [
      msg('1', [{ Name: 'tada', Count: 1, UserIDs: ['U2'] }, { Name: 'eyes', Count: 1, UserIDs: ['U3'] }]),
      msg('2', [{ Name: 'tada', Count: 1, UserIDs: ['U2'] }]),
    ]
    const out = applyReactionToggle(before, '1', 'tada', 'U1', true)
    expect(out[0].Reactions![0].Count).toBe(2)
    expect(out[0].Reactions![1]).toEqual({ Name: 'eyes', Count: 1, UserIDs: ['U3'] })
    expect(out[1].Reactions![0]).toEqual({ Name: 'tada', Count: 1, UserIDs: ['U2'] })
  })

  it('is a no-op for an unknown ts or reaction name', () => {
    const before = [msg('1', [{ Name: 'tada', Count: 1, UserIDs: ['U2'] }])]
    expect(applyReactionToggle(before, '9', 'tada', 'U1', true)).toEqual(before)
    expect(applyReactionToggle(before, '1', 'nope', 'U1', true)).toEqual(before)
  })

  it('does not mutate the input', () => {
    const before = [msg('1', [{ Name: 'tada', Count: 1, UserIDs: ['U2'] }])]
    const snapshotReaction = before[0].Reactions![0]
    applyReactionToggle(before, '1', 'tada', 'U1', true)
    expect(before[0].Reactions![0]).toBe(snapshotReaction)
    expect(before[0].Reactions![0]).toEqual({ Name: 'tada', Count: 1, UserIDs: ['U2'] })
  })
})
