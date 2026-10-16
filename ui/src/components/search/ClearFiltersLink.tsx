import { Anchor } from "@mantine/core"

/**
 * "Clear filters", beneath a pane's filter toggles. Rendered only while a
 * filter is actually on, so it never offers to clear nothing.
 */
export function ClearFiltersLink({ active, onClear }: { active: boolean; onClear: () => void }) {
  if (!active) return null
  return (
    <Anchor component="button" type="button" size="xs" onClick={onClear} style={{ alignSelf: "flex-start" }}>
      Clear filters
    </Anchor>
  )
}
