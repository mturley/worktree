export function relativeTime(ts: string): string {
  const d = new Date(ts).getTime()
  if (!d) return ts
  const s = Math.floor((Date.now() - d) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// --- Slack timestamp helpers (ported from slack-mini) ---
//
// Pure, dependency-free relative/absolute time helpers shared by the Slack
// thread UI (Message per-message timestamps; ThreadView/TabBar/ActionBar
// header "Started"/"Active"/"updated ... ago" freshness labels). Both accept
// an optional `now` so callers (and tests) can pin the reference time
// deterministically. Kept alongside the existing `relativeTime` (which takes
// an ISO string) — these take a Slack `ts` (epoch-seconds string).

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function formatTime(d: Date): string {
  let hours = d.getHours()
  const minutes = d.getMinutes()
  const ampm = hours >= 12 ? 'PM' : 'AM'
  hours = hours % 12
  if (hours === 0) {
    hours = 12
  }
  const mm = minutes.toString().padStart(2, '0')
  return `${hours}:${mm} ${ampm}`
}

/**
 * Formats a Slack `ts` (seconds.microseconds string) as a day-relative
 * timestamp with no seconds: "Today at 2:14 PM", "Yesterday at 2:14 PM",
 * a weekday name for the last 2-6 days ("Wednesday at 2:14 PM"), or an
 * absolute date beyond that ("Aug 5, 2026 at 2:14 PM").
 */
export function formatMessageTimestamp(ts: string, now: Date = new Date()): string {
  const seconds = parseFloat(ts)
  if (Number.isNaN(seconds)) {
    return ts
  }
  const date = new Date(seconds * 1000)
  const time = formatTime(date)
  const dayDiff = Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86400000)

  if (dayDiff === 0) {
    return `Today at ${time}`
  }
  if (dayDiff === 1) {
    return `Yesterday at ${time}`
  }
  if (dayDiff >= 2 && dayDiff <= 6) {
    return `${WEEKDAYS[date.getDay()]} at ${time}`
  }
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} at ${time}`
}

/**
 * Formats a Slack `ts` (or any epoch-seconds-like numeric string) as a
 * compact relative duration: "just now", "32m ago", "3h ago", "3d ago",
 * "2mo ago", "1y ago".
 */
export function relativeFromNow(ts: string, now: Date = new Date()): string {
  const seconds = parseFloat(ts)
  if (Number.isNaN(seconds)) {
    return ts
  }
  const date = new Date(seconds * 1000)
  const diffSec = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000))

  if (diffSec < 30) {
    return 'just now'
  }
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) {
    return `${diffMin}m ago`
  }
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) {
    return `${diffHour}h ago`
  }
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay < 30) {
    return `${diffDay}d ago`
  }
  const diffMonth = Math.floor(diffDay / 30)
  if (diffMonth < 12) {
    return `${diffMonth}mo ago`
  }
  const diffYear = Math.floor(diffDay / 365)
  return `${diffYear}y ago`
}
