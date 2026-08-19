import { parseThreadUrl } from '../lib/parseThreadUrl'

export type Tab = {
  id: string
  channel: string
  threadTs: string
  name: string
  description: string
}

const STORAGE_KEY = 'slack-mini:tabs'

function isTab(value: unknown): value is Tab {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const t = value as Record<string, unknown>
  return (
    typeof t.id === 'string' &&
    typeof t.channel === 'string' &&
    typeof t.threadTs === 'string' &&
    typeof t.name === 'string' &&
    typeof t.description === 'string'
  )
}

export function loadTabs(): Tab[] {
  const raw = sessionStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every(isTab)) {
      return []
    }
    return parsed
  } catch {
    return []
  }
}

export function saveTabs(tabs: Tab[]): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tabs))
}

function tabId(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`
}

/**
 * The placeholder name assigned to a tab when the user doesn't provide a
 * custom title. Exported so UI that distinguishes "user-set title" from
 * "no title yet" (e.g. TabBar's line-1 title) can compare against it
 * instead of treating any non-empty `tab.name` as a custom title — which
 * would otherwise leak the raw channel/thread-ts into the UI.
 */
export function defaultTabName(channel: string, threadTs: string): string {
  return `${channel} @ ${threadTs}`
}

export function parseTabFromUrl(url: string): Tab | null {
  const parsed = parseThreadUrl(url)
  if (!parsed) {
    return null
  }
  const { channel, threadTs } = parsed
  return {
    id: tabId(channel, threadTs),
    channel,
    threadTs,
    name: defaultTabName(channel, threadTs),
    description: '',
  }
}

export function findTab(tabs: Tab[], channel: string, threadTs: string): Tab | undefined {
  return tabs.find((tab) => tab.channel === channel && tab.threadTs === threadTs)
}

/**
 * Returns a new tabs array with the tab matching `id` patched by `updates`
 * (e.g. a new name/description from the edit-details modal). Leaves tabs
 * unchanged (returns the same array reference) if no tab matches id.
 */
export function updateTab(tabs: Tab[], id: string, updates: Partial<Pick<Tab, 'name' | 'description'>>): Tab[] {
  if (!tabs.some((tab) => tab.id === id)) {
    return tabs
  }
  return tabs.map((tab) => (tab.id === id ? { ...tab, ...updates } : tab))
}

export function addTabFromUrl(tabs: Tab[], url: string): Tab[] {
  const tab = parseTabFromUrl(url)
  if (!tab) {
    return tabs
  }
  if (findTab(tabs, tab.channel, tab.threadTs)) {
    return tabs
  }
  return [...tabs, tab]
}

/**
 * Returns a new tabs array with the tab at `fromIndex` moved to `toIndex`,
 * leaving all other tabs (and their fields/ids) untouched. Used to persist
 * drag-to-reorder in the tab bar — the resulting array order is what gets
 * saved via `saveTabs`. Out-of-range or no-op indices return `tabs`
 * unchanged (same array reference).
 */
export function reorderTabs(tabs: Tab[], fromIndex: number, toIndex: number): Tab[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= tabs.length ||
    toIndex >= tabs.length
  ) {
    return tabs
  }
  const next = [...tabs]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

export function readOpenParams(search: string): string[] {
  const params = new URLSearchParams(search)
  return params.getAll('open')
}
