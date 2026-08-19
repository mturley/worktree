import { describe, it, expect } from "vitest"
import { formatMessageTimestamp, relativeFromNow, relativeTime } from "./relativeTime"

describe("relativeTime", () => {
  it("formats a recent timestamp as seconds ago", () => {
    const tenSecAgo = new Date(Date.now() - 10_000).toISOString()
    expect(relativeTime(tenSecAgo)).toMatch(/^\d+s ago$/)
  })
})

function tsAt(date: Date): string {
  return (date.getTime() / 1000).toString()
}

describe('formatMessageTimestamp', () => {
  const now = new Date(2026, 7, 7, 14, 30) // Fri Aug 7 2026, 2:30 PM (local)

  it('renders "Today at ..." for a timestamp earlier the same calendar day', () => {
    const ts = tsAt(new Date(2026, 7, 7, 9, 5))
    expect(formatMessageTimestamp(ts, now)).toBe('Today at 9:05 AM')
  })

  it('renders "Yesterday at ..." for the previous calendar day', () => {
    const ts = tsAt(new Date(2026, 7, 6, 21, 0))
    expect(formatMessageTimestamp(ts, now)).toBe('Yesterday at 9:00 PM')
  })

  it('renders the weekday name for 2-6 days ago', () => {
    const ts = tsAt(new Date(2026, 7, 4, 8, 15)) // Tuesday, 3 days before Friday
    expect(formatMessageTimestamp(ts, now)).toBe('Tuesday at 8:15 AM')
  })

  it('renders the weekday name at the 6-day boundary', () => {
    const ts = tsAt(new Date(2026, 7, 1, 0, 0)) // Saturday, 6 days before Friday
    expect(formatMessageTimestamp(ts, now)).toBe('Saturday at 12:00 AM')
  })

  it('renders an absolute date for 7+ days ago', () => {
    const ts = tsAt(new Date(2026, 6, 31, 13, 45)) // 7 days before Aug 7
    expect(formatMessageTimestamp(ts, now)).toBe('Jul 31, 2026 at 1:45 PM')
  })

  it('formats noon and midnight correctly (12-hour, no leading zero)', () => {
    expect(formatMessageTimestamp(tsAt(new Date(2026, 7, 7, 12, 0)), now)).toBe('Today at 12:00 PM')
    expect(formatMessageTimestamp(tsAt(new Date(2026, 7, 7, 0, 0)), now)).toBe('Today at 12:00 AM')
  })

  it('returns the raw string when it cannot be parsed as a number', () => {
    expect(formatMessageTimestamp('not-a-ts', now)).toBe('not-a-ts')
  })
})

describe('relativeFromNow', () => {
  const now = new Date(2026, 7, 7, 12, 0, 0)

  it('returns "just now" for very recent timestamps', () => {
    const ts = tsAt(new Date(now.getTime() - 5000))
    expect(relativeFromNow(ts, now)).toBe('just now')
  })

  it('returns minutes ago', () => {
    const ts = tsAt(new Date(now.getTime() - 32 * 60 * 1000))
    expect(relativeFromNow(ts, now)).toBe('32m ago')
  })

  it('returns hours ago', () => {
    const ts = tsAt(new Date(now.getTime() - 3 * 60 * 60 * 1000))
    expect(relativeFromNow(ts, now)).toBe('3h ago')
  })

  it('returns days ago', () => {
    const ts = tsAt(new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000))
    expect(relativeFromNow(ts, now)).toBe('3d ago')
  })

  it('returns the raw string when it cannot be parsed as a number', () => {
    expect(relativeFromNow('bogus', now)).toBe('bogus')
  })
})
