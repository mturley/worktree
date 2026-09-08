import { Avatar, Group, Paper, Stack, Text } from '@mantine/core'
import type { AutocompleteItem } from '../../../api/slackApi'

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
              {item.avatar ? <Avatar src={item.avatar} size={20} radius="xl" /> : null}
              {item.imageUrl ? <img src={item.imageUrl} alt="" width={20} height={20} /> : null}
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
