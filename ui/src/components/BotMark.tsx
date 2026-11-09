import { Tooltip } from "@mantine/core"
import { IconRobot } from "@tabler/icons-react"

/**
 * Marks an event written by a bot, placed right before the title. Renders
 * nothing for any other author type (including an absent one).
 */
export function BotMark({ authorType, author }: { authorType?: string; author?: string }) {
  if (authorType !== "bot") return null
  return (
    <Tooltip label={author ? `From a bot: ${author}` : "From a bot"}>
      <IconRobot
        size="1.1em"
        aria-label="Bot"
        role="img"
        style={{ flex: "none", verticalAlign: "text-bottom", marginRight: 4 }}
      />
    </Tooltip>
  )
}
