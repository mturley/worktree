import { describe, it, expect } from 'vitest'
import { computeUnreadPatch } from './unreadPatch'
import type { Message } from '../api/slackApi'

function msg(ts: string): Message {
  return { TS: ts, UserID: 'U1', Text: `msg ${ts}`, Blocks: null, Reactions: null, Edited: false, Files: null, Attachments: null }
}

describe('computeUnreadPatch', () => {
  const messages = [msg('1700000000.000001'), msg('1700000000.000002'), msg('1700000000.000003')]

  it('sets unreadIndex to the clicked message and lastRead to the message before it', () => {
    const patch = computeUnreadPatch(messages, '1700000000.000002')
    expect(patch.unreadIndex).toBe(1)
    expect(patch.lastRead).toBe('1700000000.000001')
  })

  it('sets lastRead to "" when the clicked message is the first one', () => {
    const patch = computeUnreadPatch(messages, '1700000000.000001')
    expect(patch.unreadIndex).toBe(0)
    expect(patch.lastRead).toBe('')
  })

  it('is a safe no-op when ts is not found among the messages', () => {
    const patch = computeUnreadPatch(messages, '1800000000.000000')
    expect(patch.unreadIndex).toBe(-1)
    expect(patch.lastRead).toBe('')
  })
})
