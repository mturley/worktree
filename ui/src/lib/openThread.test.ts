import { describe, it, expect } from 'vitest'
import { computeOpenThread } from './openThread'

describe('computeOpenThread', () => {
  it('foreground: adds a new thread tab and makes it active', () => {
    const r = computeOpenThread([], 'https://x.slack.com/archives/C1/p1700000000000001', false)
    expect(r.tabs.length).toBe(1)
    expect(r.activeId).toBe(r.tabs[0].id)
  })

  it('background: adds a new tab but does not change active', () => {
    const r = computeOpenThread([], 'https://x.slack.com/archives/C1/p1700000000000001', true)
    expect(r.tabs.length).toBe(1)
    expect(r.activeId).toBeUndefined()
  })

  it('existing thread: foreground switches to it, no duplicate', () => {
    const first = computeOpenThread([], 'https://x.slack.com/archives/C1/p1700000000000001', false)
    const again = computeOpenThread(first.tabs, 'https://x.slack.com/archives/C1/p1700000000000001', false)
    expect(again.tabs.length).toBe(1)
    expect(again.activeId).toBe(first.tabs[0].id)
  })

  it('unparseable url: no change', () => {
    const r = computeOpenThread([], 'https://example.com/not-slack', false)
    expect(r.tabs.length).toBe(0)
    expect(r.tabs).toEqual([])
  })
})
