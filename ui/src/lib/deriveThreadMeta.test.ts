import { describe, it, expect } from 'vitest'
import { deriveThreadMeta } from './deriveThreadMeta'
import type { Message, ThreadResponse, User } from '../api/slackApi'

function baseMessage(overrides: Partial<Message>): Message {
  return {
    TS: '1700000000.000001',
    UserID: 'U1',
    Text: 'hi',
    Blocks: null,
    Reactions: null,
    Edited: false,
    Files: null,
    Attachments: null,
    ...overrides,
  }
}

function baseResponse(overrides: Partial<ThreadResponse>): ThreadResponse {
  return {
    channel: 'C1',
    channelName: 'general',
    threadTs: '1700000000.000001',
    lastRead: '',
    latestReply: '',
    rootTs: '1700000000.000001',
    unreadIndex: -1,
    currentUserId: 'U1',
    messages: [baseMessage({})],
    users: {},
    emoji: {},
    ...overrides,
  }
}

describe('deriveThreadMeta', () => {
  it('resolves author DisplayName from the users map for the root message', () => {
    const users: Record<string, User> = {
      U1: { ID: 'U1', RealName: 'Jane Doe', DisplayName: 'jane', Avatar72: '' },
    }
    const meta = deriveThreadMeta(baseResponse({ users }))
    expect(meta.author).toBe('jane')
  })

  it('falls back to RealName when DisplayName is empty', () => {
    const users: Record<string, User> = {
      U1: { ID: 'U1', RealName: 'Jane Doe', DisplayName: '', Avatar72: '' },
    }
    const meta = deriveThreadMeta(baseResponse({ users }))
    expect(meta.author).toBe('Jane Doe')
  })

  it('falls back to the raw UserID when the user is not in the users map', () => {
    const meta = deriveThreadMeta(baseResponse({ users: {} }))
    expect(meta.author).toBe('U1')
  })

  it('is undefined when there are no messages', () => {
    const meta = deriveThreadMeta(baseResponse({ messages: [] }))
    expect(meta.author).toBeUndefined()
  })

  it('passes channelName through, and undefined when empty', () => {
    expect(deriveThreadMeta(baseResponse({ channelName: 'random' })).channelName).toBe('random')
    expect(deriveThreadMeta(baseResponse({ channelName: '' })).channelName).toBeUndefined()
  })

  it('uses rootTs for startedTs', () => {
    const meta = deriveThreadMeta(baseResponse({ rootTs: '1700000001.000000' }))
    expect(meta.startedTs).toBe('1700000001.000000')
  })

  it('falls back to messages[0].TS for startedTs when rootTs is empty', () => {
    const meta = deriveThreadMeta(
      baseResponse({ rootTs: '', messages: [baseMessage({ TS: '1700000002.000000' })] }),
    )
    expect(meta.startedTs).toBe('1700000002.000000')
  })

  it('uses latestReply for activeTs when present', () => {
    const meta = deriveThreadMeta(baseResponse({ latestReply: '1700000005.000000' }))
    expect(meta.activeTs).toBe('1700000005.000000')
  })

  it('falls back to the last message TS for activeTs when latestReply is empty', () => {
    const meta = deriveThreadMeta(
      baseResponse({
        latestReply: '',
        messages: [baseMessage({ TS: '1700000001.000000' }), baseMessage({ TS: '1700000009.000000' })],
      }),
    )
    expect(meta.activeTs).toBe('1700000009.000000')
  })

  it('reports hasUnread true when unreadIndex >= 0', () => {
    expect(deriveThreadMeta(baseResponse({ unreadIndex: 2 })).hasUnread).toBe(true)
    expect(deriveThreadMeta(baseResponse({ unreadIndex: 0 })).hasUnread).toBe(true)
  })

  it('reports hasUnread false when unreadIndex is -1', () => {
    expect(deriveThreadMeta(baseResponse({ unreadIndex: -1 })).hasUnread).toBe(false)
  })

  it('includes firstMessageText from messages[0].Text', () => {
    const meta = deriveThreadMeta(
      baseResponse({ messages: [baseMessage({ Text: 'Hello, this is the root message' })] }),
    )
    expect(meta.firstMessageText).toBe('Hello, this is the root message')
  })

  it('leaves firstMessageText undefined when there are no messages or the root has no text', () => {
    expect(deriveThreadMeta(baseResponse({ messages: [] })).firstMessageText).toBeUndefined()
    expect(deriveThreadMeta(baseResponse({ messages: [baseMessage({ Text: '' })] })).firstMessageText).toBeUndefined()
  })
})
