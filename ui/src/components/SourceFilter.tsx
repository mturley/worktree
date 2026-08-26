import { Button, Group } from "@mantine/core"
import { SlackMark } from "./icons/SlackMark"
import { JiraMark } from "./icons/JiraMark"
import { GitHubMark } from "./icons/GitHubMark"

/** Resource types, in the order the toggles appear. */
const SOURCES: { type: string; label: string }[] = [
  { type: "pr", label: "GitHub" },
  { type: "jira", label: "Jira" },
  { type: "slack", label: "Slack" },
]

/**
 * Each source's own mark, in its own colour, so the three toggles are
 * recognisable at a glance rather than three identical grey glyphs.
 *
 * All three are the official marks, inlined from their own artwork. GitHub's
 * Invertocat is monochrome by design; the white variant is the one GitHub
 * ships for dark backgrounds, so it is the artwork rather than a tint.
 */
function SourceIcon({ type }: { type: string }) {
  if (type === "slack") return <SlackMark size={14} />
  if (type === "jira") return <JiraMark size={14} />
  return <GitHubMark size={14} />
}

/**
 * Toggles that narrow a timeline to one source.
 *
 * Single-select: picking Jira drops GitHub. Clicking the active one turns it
 * off again, which is how you get back to everything — so the states are
 * "all" or "exactly one", never a subset.
 *
 * The value stays a string[] even though at most one is ever set. The wire
 * format (resource_types) and both timeline handlers already accept a list,
 * and keeping the shape means widening back to multi-select later is a change
 * to this component alone.
 *
 * Filtering happens server-side, not by hiding rows here. These feeds are
 * paginated, so client-side filtering would return a page of 50 events and
 * then show two of them, with "Load more" as the only way to find the rest.
 */
export function SourceFilter({ value, onChange }: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  // Replace rather than add: selecting a source deselects any other, and
  // selecting the active one clears back to "show everything".
  const toggle = (type: string) => onChange(value.includes(type) ? [] : [type])

  return (
    <Group gap={4} wrap="nowrap">
      {SOURCES.map(({ type, label }) => {
        const active = value.includes(type)
        return (
          <Button
            key={type}
            size="compact-xs"
            variant={active ? "light" : "subtle"}
            color={active ? undefined : "gray"}
            aria-pressed={active}
            leftSection={<SourceIcon type={type} />}
            onClick={() => toggle(type)}
          >
            {label}
          </Button>
        )
      })}
    </Group>
  )
}
