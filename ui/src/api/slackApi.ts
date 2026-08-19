// Typed client for the Go backend's JSON API.
//
// IMPORTANT: field casing below matches the *actual* Go wire format, not a
// generic guess. `ThreadResponse` (internal/server/server.go) has explicit
// `json:"..."` tags and serializes as camelCase. But `MessageView` embeds
// `slackapi.Message` anonymously with no json tags, so Go's default
// MarshalJSON uses the Go field names verbatim (capitalized) for messages,
// elements, reactions, and users. The result is a response with camelCase
// top-level keys but PascalCase nested object keys — verified by reading
// internal/server/server.go and internal/slackapi/types.go.

export interface Style {
  Bold: boolean
  Italic: boolean
  Code: boolean
  Strike: boolean
}

export type ElementType = 'text' | 'user' | 'link' | 'emoji' | 'usergroup' | 'broadcast'

export interface Element {
  Type: ElementType
  Text: string
  URL: string
  UserID: string
  Name: string
  Unicode: string
  Style: Style
}

export type BlockType = 'section' | 'list' | 'quote' | 'preformatted'

// A Block is one group within a message's rich text: a paragraph
// ("section"), a blockquote ("quote"), a code block ("preformatted"), or a
// list ("list"). For section/quote/preformatted, Elements holds the leaf
// elements to render in order. For list, Style ("bullet"|"ordered") and
// Indent (0-based nesting level) describe the list, and Items holds one
// leaf-element array per list item (Elements is unused/null).
export interface Block {
  Type: BlockType
  Elements: Element[] | null
  Style: string
  Indent: number
  Items: Element[][] | null
}

export interface Reaction {
  Name: string
  Count: number
  // The Go struct has no `omitempty`, so an empty user list marshals to null
  // on the wire, not []. Type it as nullable and guard at the use site.
  UserIDs: string[] | null
}

export interface File {
  ID: string
  Name: string
  Title: string
  Mimetype: string
  Filetype: string
  PrettyType: string
  Size: number
  Permalink: string
  URLPrivate: string
  Thumb360: string
  Thumb360W: number
  Thumb360H: number
  Thumb720: string
  OriginalW: number
  OriginalH: number
  IsImage: boolean
}

export interface TextObject {
  Type: string // "mrkdwn" | "plain_text"
  Text: string
}

export interface BlockElement {
  Type: string // "image" | "mrkdwn" | "plain_text"
  ImageURL: string
  AltText: string
  Text: string
}

// A Block Kit block carried inside an attachment (Confluence/Jira app unfurl).
// Type: "section" | "context" | "image" | "divider" | "header" | "rich_text"
// | "unsupported". Go nil slices/pointers serialize as null, so nested arrays
// and pointer fields are nullable.
export interface BlockKit {
  Type: string
  Text: TextObject | null
  Elements: BlockElement[] | null
  Accessory: BlockElement | null
  ImageURL: string
  AltText: string
  RichText: Block[] | null
}

export interface Attachment {
  Title: string
  TitleLink: string
  Text: string
  ServiceName: string
  ServiceIcon: string
  Footer: string
  FooterIcon: string
  Color: string
  ImageURL: string
  ThumbURL: string
  ImageWidth: number
  ImageHeight: number
  AuthorName: string
  IsMsgUnfurl: boolean
  IsReplyUnfurl: boolean
  FromURL: string
  ChannelID: string
  IsThreadUnfurl: boolean
  Blocks: BlockKit[] | null
}

export interface Message {
  TS: string
  UserID: string
  Text: string
  Blocks: Block[] | null
  Reactions: Reaction[] | null
  Edited: boolean
  Files: File[] | null
  Attachments: Attachment[] | null
}

// Unescapes the small set of HTML entities Slack encodes in plain `text`
// fields (&, <, >). Deliberately does NOT parse mrkdwn tokens (*bold*,
// <@U123>, etc.) — that's handled separately via Blocks/RichText. This is
// only for rendering plain-text fallbacks (e.g. attachment fields) that
// don't have a Blocks representation.
export function unescapeSlackText(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

// Returns the URL only if it uses a safe scheme (http/https/mailto), else
// undefined. Slack message text is attacker-influenced (bots, other users),
// so a raw <javascript:...|label> token must never become a live href.
const SAFE_URL_SCHEMES = ['http:', 'https:', 'mailto:']

export function safeHref(url: string): string | undefined {
  const trimmed = url.trim()
  const colonIdx = trimmed.indexOf(':')
  if (colonIdx < 0) {
    return undefined
  }
  const scheme = trimmed.slice(0, colonIdx + 1).toLowerCase()
  if (!SAFE_URL_SCHEMES.includes(scheme)) {
    return undefined
  }
  return trimmed
}

export interface User {
  ID: string
  RealName: string
  DisplayName: string
  Avatar72: string
}

export interface ThreadResponse {
  channel: string
  channelName: string
  threadTs: string
  lastRead: string
  latestReply: string
  rootTs: string
  unreadIndex: number
  currentUserId: string
  messages: Message[]
  users: Record<string, User>
  emoji: Record<string, string>
}

export interface ConfigResponse {
  workspaceDomain: string
}

export class ApiAuthError extends Error {
  constructor() {
    super('Authentication expired. Re-run slack-mini setup.')
    this.name = 'ApiAuthError'
  }
}

async function handleJSON<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    throw new ApiAuthError()
  }
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

export async function getThread(channel: string, threadTs: string): Promise<ThreadResponse> {
  const params = new URLSearchParams({ channel, thread_ts: threadTs })
  const res = await fetch(`/api/thread?${params.toString()}`)
  return handleJSON<ThreadResponse>(res)
}

export async function markRead(channel: string, threadTs: string, ts: string): Promise<void> {
  const res = await fetch('/api/thread/mark-read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, thread_ts: threadTs, ts }),
  })
  if (res.status === 401) {
    throw new ApiAuthError()
  }
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`)
  }
}

export async function markUnread(channel: string, threadTs: string, ts: string): Promise<void> {
  const res = await fetch('/api/thread/mark-unread', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, thread_ts: threadTs, ts }),
  })
  if (res.status === 401) {
    throw new ApiAuthError()
  }
  if (!res.ok) {
    throw new Error(`mark-unread failed: ${res.status}`)
  }
}

export async function postReply(channel: string, threadTs: string, text: string): Promise<Message> {
  const res = await fetch('/api/thread/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  })
  if (res.status === 401) {
    throw new ApiAuthError()
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(body || `reply failed: ${res.status}`)
  }
  return (await res.json()) as Message
}

export async function toggleReaction(
  channel: string,
  threadTs: string,
  ts: string,
  name: string,
  add: boolean,
): Promise<void> {
  const res = await fetch('/api/thread/react', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, thread_ts: threadTs, ts, name, add }),
  })
  if (res.status === 401) {
    throw new ApiAuthError()
  }
  if (!res.ok) {
    throw new Error(`react failed: ${res.status}`)
  }
}

export function eventsUrl(channel: string, threadTs: string): string {
  const params = new URLSearchParams({ channel, thread_ts: threadTs })
  return `/api/thread-events?${params.toString()}`
}

export async function getConfig(): Promise<ConfigResponse> {
  const res = await fetch('/api/slack-config')
  return handleJSON<ConfigResponse>(res)
}

export function avatarProxy(url: string): string {
  return `/api/slack-avatar?url=${encodeURIComponent(url)}`
}

export function emojiProxy(url: string): string {
  return `/api/slack-emoji?url=${encodeURIComponent(url)}`
}

export function fileProxy(url: string): string {
  return `/api/slack-file?url=${encodeURIComponent(url)}`
}
