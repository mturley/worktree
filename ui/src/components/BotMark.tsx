import { ThemeIcon, Tooltip } from "@mantine/core"
import { IconRobot } from "@tabler/icons-react"

/**
 * Marks an event written by a bot. It goes INSIDE the title's text element,
 * as the first child of a `display: flex` title, so it never wraps away from
 * the title: the mark keeps the left column and the title's lines wrap beside
 * it. The wrapper is one line box tall (`1lh`), which centres the icon on the
 * title's first line at whatever size and line height the title uses.
 * The robot sits on a small tinted square so it reads as a marker, not as a
 * glyph lost among the title's letters.
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
          <IconRobot size="1em" aria-hidden />
        </ThemeIcon>
      </span>
    </Tooltip>
  )
}
