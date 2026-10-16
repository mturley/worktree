import { Box, Paper, Text } from "@mantine/core"
import { SearchHighlight } from "./SearchHighlight"
import type { Suggestion } from "./SearchBar"

/**
 * The typeahead dropdown. An experiment: to remove it, delete this file,
 * suggestions.ts, and the `suggestions` prop wiring in SearchBar.
 */
export function SearchSuggestions({
  items, active, onHover, onPick,
}: { items: Suggestion[]; active: number; onHover: (i: number) => void; onPick: (s: Suggestion) => void }) {
  return (
    <Paper withBorder shadow="md" p={4} role="listbox" aria-label="Search suggestions"
      style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, zIndex: "var(--mantine-z-index-popover)" }}>
      {items.map((s, i) => (
        <Box key={s.key}>
          {(i === 0 || items[i - 1].group !== s.group) && (
            <Text size="10px" tt="uppercase" c="dimmed" fw={600} px={8} pt={i ? 6 : 2}>{s.group}</Text>
          )}
          <Box
            role="option"
            aria-selected={i === active}
            px={8} py={3}
            style={{ cursor: "pointer", borderRadius: 4, background: i === active ? "var(--mantine-color-blue-light)" : undefined }}
            onMouseEnter={() => onHover(i)}
            // mousedown, so the input's blur doesn't close the list first.
            onMouseDown={(e) => { e.preventDefault(); onPick(s) }}
          >
            <Text size="sm" lineClamp={1}><SearchHighlight text={s.label} /></Text>
            {s.detail && <Text size="xs" c="dimmed" lineClamp={1}><SearchHighlight text={s.detail} /></Text>}
          </Box>
        </Box>
      ))}
    </Paper>
  )
}
