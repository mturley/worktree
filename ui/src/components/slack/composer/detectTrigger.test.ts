import { describe, it, expect } from 'vitest'
import { detectTrigger } from './detectTrigger'

describe('detectTrigger', () => {
  it('matches a trigger at the start of the text', () => {
    expect(detectTrigger('@ad')).toEqual({ trigger: '@', query: 'ad', start: 0 })
  })

  it('matches a trigger after whitespace', () => {
    expect(detectTrigger('hello @ad')).toEqual({ trigger: '@', query: 'ad', start: 6 })
  })

  it('matches a bare trigger with an empty query', () => {
    expect(detectTrigger('hello @')).toEqual({ trigger: '@', query: '', start: 6 })
  })

  it('does not match mid-word, so email addresses are left alone', () => {
    expect(detectTrigger('mail ada@example.com')).toBeNull()
  })

  it('closes once the query is broken by whitespace', () => {
    expect(detectTrigger('@ada says')).toBeNull()
  })

  it('handles the : and # triggers', () => {
    expect(detectTrigger('nice :tad')).toEqual({ trigger: ':', query: 'tad', start: 5 })
    expect(detectTrigger('see #odh')).toEqual({ trigger: '#', query: 'odh', start: 4 })
  })

  it('matches after a newline', () => {
    expect(detectTrigger('line one\n@ad')).toEqual({ trigger: '@', query: 'ad', start: 9 })
  })

  it('opens immediately after a mention pill, whose text ends in ">"', () => {
    // A MentionNode's text content IS its mrkdwn token, so the text before
    // the caret ends in ">" (users/groups/specials/channels). Requiring
    // whitespace there forced the user to type a space first; Slack's own
    // composer opens straight away.
    expect(detectTrigger('<@U1>@ad')).toEqual({ trigger: '@', query: 'ad', start: 5 })
    expect(detectTrigger('<#C1|odh>@')).toEqual({ trigger: '@', query: '', start: 9 })
  })

  it('opens immediately after an emoji pill, whose text ends in ":"', () => {
    expect(detectTrigger(':smile:@ad')).toEqual({ trigger: '@', query: 'ad', start: 7 })
  })

  it('still leaves email addresses alone, which is what the boundary is for', () => {
    expect(detectTrigger('mail ada@example.com')).toBeNull()
    expect(detectTrigger('ada@ex')).toBeNull()
  })

  it('returns null for text with no trigger', () => {
    expect(detectTrigger('just typing')).toBeNull()
  })
})
