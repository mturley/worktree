import { ThemeIcon, Tooltip } from "@mantine/core"

/**
 * Marks an event written by a bot. It goes INSIDE the title's text element,
 * as the first child of a `display: flex` title, so it never wraps away from
 * the title: the mark keeps the left column and the title's lines wrap beside
 * it. The wrapper is one line box tall (`1lh`), which centres the icon on the
 * title's first line at whatever size and line height the title uses.
 * The robot sits on a small tinted square so it reads as a marker, not as a
 * glyph lost among the title's letters. It is our own solid head rather than
 * Tabler's IconRobot, whose arms and legs blur together at title size.
 * Renders nothing for any other author type (including an absent one).
 */
export function BotMark({ authorType, author }: { authorType?: string; author?: string }) {
  if (authorType !== "bot") return null
  return (
    <Tooltip label={author ? `From a bot: ${author}` : "From a bot"}>
      <span
        aria-label="Bot"
        role="img"
        style={{ flex: "none", display: "inline-flex", alignItems: "center", height: "1lh" }}
      >
        <ThemeIcon
          variant="light"
          color="violet"
          radius="sm"
          style={{ "--ti-size": "1.35em" } as React.CSSProperties}
        >
          <RobotHead />
        </ThemeIcon>
      </span>
    </Tooltip>
  )
}

/**
 * A robot head drawn to stay legible at 12-16px: a solid head with cut-out
 * eyes (even-odd fill, so no mask ids to keep unique per instance), an
 * antenna and ears. Sized to the surrounding font, coloured by currentColor.
 */
function RobotHead() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden focusable="false">
      <path
        fillRule="evenodd"
        d="M7.5 7h9a3.5 3.5 0 0 1 3.5 3.5v6a3.5 3.5 0 0 1 -3.5 3.5h-9a3.5 3.5 0 0 1 -3.5 -3.5v-6a3.5 3.5 0 0 1 3.5 -3.5z M9 11.5a2 2 0 1 0 0 4a2 2 0 1 0 0 -4z M15 11.5a2 2 0 1 0 0 4a2 2 0 1 0 0 -4z"
      />
      <rect x="11" y="3.5" width="2" height="4" />
      <circle cx="12" cy="3" r="2" />
      <rect x="1.5" y="11" width="2" height="5" rx="1" />
      <rect x="20.5" y="11" width="2" height="5" rx="1" />
    </svg>
  )
}
