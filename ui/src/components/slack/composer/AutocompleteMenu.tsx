import { Avatar, Group, Paper, Stack, Text } from '@mantine/core'
import type { AutocompleteItem } from '../../../api/slackApi'

export interface AutocompleteMenuProps {
  items: AutocompleteItem[]
  /** "kind:id" of the highlighted row — tracked by identity, never by index,
   *  so a merge of late-arriving remote results cannot move the selection. */
  highlightedId: string | null
  onSelect: (item: AutocompleteItem) => void
  /** True when the workspace search failed and only local results are shown. */
  degraded: boolean
}

export function itemKey(item: AutocompleteItem): string {
  return `${item.kind}:${item.id}`
}

export function AutocompleteMenu({ items, highlightedId, onSelect, degraded }: AutocompleteMenuProps) {
  if (items.length === 0 && !degraded) {
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
        {degraded ? (
          <Text size="xs" c="dimmed" p={4}>
            Workspace search unavailable — showing people from this thread
          </Text>
        ) : null}
      </Stack>
    </Paper>
  )
}
