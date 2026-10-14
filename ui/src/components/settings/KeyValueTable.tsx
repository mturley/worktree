import { ActionIcon, Button, Group, Stack, TextInput } from "@mantine/core"
import { IconX } from "@tabler/icons-react"

/**
 * Edits a string map as rows. Rows are kept as an ordered array while
 * editing so a half-typed key doesn't reorder or merge with another; the
 * map passed to onChange drops rows whose key is blank.
 */
export function KeyValueTable({ rows, onChange, keyPlaceholder, valuePlaceholder, rowErrors }: {
  rows: [string, string][]
  onChange: (rows: [string, string][]) => void
  keyPlaceholder: string
  valuePlaceholder: string
  /** Per-row inline error on the name field, by row index. */
  rowErrors?: (string | undefined)[]
}) {
  const set = (i: number, at: 0 | 1, v: string) =>
    onChange(rows.map((r, j): [string, string] => (j === i ? (at === 0 ? [v, r[1]] : [r[0], v]) : r)))
  return (
    <Stack gap={6}>
      {rows.map(([k, v], i) => (
        <Group key={i} gap={6} wrap="nowrap">
          <TextInput aria-label={`Field ${i + 1} name`} placeholder={keyPlaceholder} value={k} error={rowErrors?.[i]} onChange={(e) => set(i, 0, e.currentTarget.value)} ff="monospace" size="xs" w="40%" />
          <TextInput aria-label={`Field ${i + 1} ID`} placeholder={valuePlaceholder} value={v} onChange={(e) => set(i, 1, e.currentTarget.value)} ff="monospace" size="xs" style={{ flex: 1 }} />
          <ActionIcon variant="subtle" color="gray" aria-label={`Remove field ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <IconX size={14} />
          </ActionIcon>
        </Group>
      ))}
      <Button size="xs" variant="subtle" w="fit-content" onClick={() => onChange([...rows, ["", ""]])}>+ Add field</Button>
    </Stack>
  )
}
