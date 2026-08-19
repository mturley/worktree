export interface ParsedThreadUrl {
  channel: string
  threadTs: string
}

// Matches Slack "permalink"-style URLs, e.g.:
//   https://x.slack.com/archives/C0EXAMPLE2/p1700000000000007
//   https://x.slack.com/archives/C0EXAMPLE2/p1700000000000009?thread_ts=1700000000.000005&cid=...
// The p-timestamp is the message ts with the dot removed; when the link
// points at a reply, Slack also includes an explicit ?thread_ts= query
// param identifying the thread's root message.
const THREAD_URL_RE = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?.*thread_ts=([\d.]+))?/

export function parseThreadUrl(url: string): ParsedThreadUrl | null {
  const match = THREAD_URL_RE.exec(url)
  if (!match) {
    return null
  }

  const [, channel, tsSeconds, tsMicros, explicitThreadTs] = match
  const threadTs = explicitThreadTs ?? `${tsSeconds}.${tsMicros}`

  return { channel, threadTs }
}
