import { Button, Group } from "@mantine/core"
import { categoriesFor } from "../lib/eventTypeFilter"
import { eventMeta } from "../lib/eventMeta"

/**
 * The subfilter bar under the source toggles: narrows the selected source's
 * feed to particular kinds of event. Renders nothing unless exactly one source
 * with more than one category is selected.
 *
 * Multi-select, unlike the sources: "Comments + Reviews" is a natural thing to
 * want, whereas a feed of two sources was judged not worth the extra state.
 * Nothing selected means every kind.
 */
export function EventTypeFilter({ sources, value, onChange }: {
  sources: string[]
  value: string[]
  onChange: (next: string[]) => void
}) {
  const cats = categoriesFor(sources)
  if (cats.length === 0) return null
  const toggle = (key: string) =>
    onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key])

  return (
    <Group gap={4} wrap="wrap" data-testid="event-type-filter">
      {cats.map((c) => {
        const active = value.includes(c.key)
        // The category's icon and colour come from its first event type, so a
        // toggle matches the dots it will leave in the feed.
        const { Icon, cssColor } = eventMeta(c.types[0].replace(/\*$/, ""))
        return (
          <Button
            key={c.key}
            size="compact-xs"
            variant={active ? "light" : "subtle"}
            color={active ? undefined : "gray"}
            aria-pressed={active}
            leftSection={<Icon size={14} color={cssColor} />}
            onClick={() => toggle(c.key)}
          >
            {c.label}
          </Button>
        )
      })}
    </Group>
  )
}
