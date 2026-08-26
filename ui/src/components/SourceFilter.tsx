import { Button, Group } from "@mantine/core"
import { IconBrandGithubFilled, IconBrandJira } from "@tabler/icons-react"
import { SlackMark } from "./icons/SlackMark"

/** Resource types, in the order the toggles appear. */
const SOURCES: { type: string; label: string }[] = [
  { type: "pr", label: "GitHub" },
  { type: "jira", label: "Jira" },
  { type: "slack", label: "Slack" },
]

/** Atlassian's blue, so Jira reads as Jira rather than as a generic ticket. */
const JIRA_BLUE = "#2684FF"

/**
 * Each source's own mark, in its own colour, so the three toggles are
 * recognisable at a glance rather than three identical grey glyphs.
 *
 * GitHub's mark is monochrome by design — white is the correct rendering on a
 * dark background, not an absence of colour. The filled Octocat is used
 * rather than the outline, to sit alongside Slack's solid mark.
 */
function SourceIcon({ type }: { type: string }) {
  if (type === "slack") return <SlackMark size={14} />
  if (type === "jira") return <IconBrandJira size={14} color={JIRA_BLUE} />
  return <IconBrandGithubFilled size={14} color="#ffffff" />
}

/**
 * Toggles that narrow a timeline to events from particular resource types.
 *
 * Nothing selected means "show everything" rather than "show nothing": an
 * all-off state would leave an empty feed with no obvious way back, and it is
 * not a view anyone wants. That also makes the default free — no selection is
 * the same request as before the filter existed.
 *
 * Filtering happens server-side (resource_types), not by hiding rows here.
 * These feeds are paginated, so client-side filtering would return a page of
 * 50 events and then show two of them, with "Load more" as the only way to
 * find the rest.
 */
export function SourceFilter({ value, onChange }: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const toggle = (type: string) =>
    onChange(value.includes(type) ? value.filter((t) => t !== type) : [...value, type])

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
