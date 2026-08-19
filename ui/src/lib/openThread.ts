import { addTabFromUrl, findTab, type Tab } from '../state/tabs'
import { parseThreadUrl } from './parseThreadUrl'

/**
 * Pure helper for "open thread as tab" actions (e.g. clicking an unfurled
 * thread link in an attachment). Given the current tabs and a Slack
 * permalink URL, returns the tabs array to use (unchanged, or with a new
 * tab appended) and the tab id that should become active — or `undefined`
 * if the active tab should be left unchanged (background opens, or an
 * unparseable URL).
 */
export function computeOpenThread(
  tabs: Tab[],
  url: string,
  background: boolean,
): { tabs: Tab[]; activeId: string | undefined } {
  const parsed = parseThreadUrl(url)
  if (!parsed) {
    return { tabs, activeId: undefined }
  }
  const existing = findTab(tabs, parsed.channel, parsed.threadTs)
  if (existing) {
    return { tabs, activeId: background ? undefined : existing.id }
  }
  const next = addTabFromUrl(tabs, url)
  const added = next[next.length - 1]
  return { tabs: next, activeId: background ? undefined : added.id }
}
