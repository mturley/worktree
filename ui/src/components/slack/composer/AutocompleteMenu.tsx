import { Avatar, Group, Paper, Stack, Text } from '@mantine/core'
import { avatarProxy, type AutocompleteItem } from '../../../api/slackApi'
import { renderEmojiNode } from '../../../lib/renderEmoji'

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
  if (items.length === 0) {
    return null
  }
  return (
    <Paper withBorder shadow="md" p={4} role="listbox" aria-label="Autocomplete candidates">
      <Stack gap={0}>
        {items.map((item) => {
          const key = itemKey(item)
          const selected = key === highlightedId
          return (
            <Group
              key={key}
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
