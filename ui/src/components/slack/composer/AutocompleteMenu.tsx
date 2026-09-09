import { useEffect, useRef } from 'react'
import { Avatar, Group, Paper, Stack, Text } from '@mantine/core'
import { avatarProxy, type AutocompleteItem } from '../../../api/slackApi'
import { renderEmojiNode } from '../../../lib/renderEmoji'

// Each row is p={4} (4px top+bottom) around a 20px-tall line (the 20px
// avatar and `size="sm"` text both come out to ~20px), and Stack uses
// gap={0}, so one row is ~28px. 280px therefore shows ~10 rows before it
// scrolls, matching the "roughly 8-10 rows" target from the server's cap of
// 25 candidates.
const LIST_MAX_HEIGHT = 280

export interface AutocompleteMenuProps {
  items: AutocompleteItem[]
  /** "kind:id" of the highlighted row — tracked by identity, never by index,
   *  so a merge of late-arriving remote results cannot move the selection. */
  highlightedId: string | null
  onSelect: (item: AutocompleteItem) => void
}

export function itemKey(item: AutocompleteItem): string {
  return `${item.kind}:${item.id}`
}

// Composer.tsx is this component's only caller, and it never renders
// AutocompleteMenu unless items.length > 0 (fix-round-2 ruling: a popup with
// nothing to select isn't rendered at all; the degraded hint moved to an
// inline note owned entirely by Composer, shown whenever the lookup is
// degraded, regardless of whether local candidates also exist). This
// component therefore no longer needs a `degraded` prop or a hint of its
// own — both would be dead code, since Composer's ruling always shows its
// own hint through the same code path.
export function AutocompleteMenu({ items, highlightedId, onSelect }: AutocompleteMenuProps) {
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // Keep the highlighted row in view as arrow-key/Tab cycling moves it past
  // the edge of the now-scrollable list. 'nearest' is deliberate: it only
  // scrolls when the row is actually out of view, so a highlight that stays
  // on-screen produces no scroll jitter.
  useEffect(() => {
    if (!highlightedId) {
      return
    }
    const row = rowRefs.current.get(highlightedId)
    // jsdom (and some older browsers) don't implement scrollIntoView at all.
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [highlightedId])

  if (items.length === 0) {
    return null
  }
  return (
    <Paper withBorder shadow="md" p={4} role="listbox" aria-label="Autocomplete candidates">
      <Stack gap={0} style={{ maxHeight: LIST_MAX_HEIGHT, overflowY: 'auto' }}>
        {items.map((item) => {
          const key = itemKey(item)
          const selected = key === highlightedId
          return (
            <Group
              key={key}
              ref={(el) => {
                if (el) {
                  rowRefs.current.set(key, el)
                } else {
                  rowRefs.current.delete(key)
                }
              }}
              role="option"
              aria-selected={selected}
              gap="xs"
              wrap="nowrap"
              p={4}
              style={{ cursor: 'pointer', background: selected ? 'var(--mantine-color-dark-5)' : undefined }}
              // onMouseDown, not onClick: the editor must not lose the caret
              // to a focus change before the insertion runs.
              onMouseDown={(e) => {
                e.preventDefault()
                onSelect(item)
              }}
            >
              {/* Both images go through the app's proxies, as every other
                  Slack image call site does (Message.tsx, renderEmoji.tsx,
                  ReactionPill.tsx): a direct slack-edge.com hotlink is
                  blocked/403 from the browser. renderEmojiNode applies
                  emojiProxy itself, and additionally renders a STANDARD
                  emoji — one with no custom image — as its character, which
                  is how the client-side Unicode half of the ":" menu shows
                  up at all. */}
              {item.avatar ? <Avatar src={avatarProxy(item.avatar)} size={20} radius="xl" /> : null}
              {item.kind === 'emoji'
                ? renderEmojiNode(item.id, undefined, item.imageUrl ? { [item.id]: item.imageUrl } : {}, 'emoji')
                : null}
              <Text size="sm">{item.label}</Text>
              {item.detail ? (
                <Text size="xs" c="dimmed">
                  {item.detail}
                </Text>
              ) : null}
            </Group>
          )
        })}
      </Stack>
    </Paper>
  )
}
