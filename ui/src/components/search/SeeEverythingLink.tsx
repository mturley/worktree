import { Anchor, Kbd } from "@mantine/core"
import { useSeeEverything } from "../../hooks/useSeeEverything"
import { useUnreadOnly } from "../../hooks/useUnreadOnly"

/**
 * The way out of a search or Unreads only, beside the text that says the
 * list is narrowed. Does what Esc does (useSeeEverything), and says so.
 *
 * Named for what it undoes: "Clear search" while only the search narrows the
 * page, "See everything" while Unreads only does too.
 */
export function SeeEverythingLink() {
  const { seeEverything } = useSeeEverything()
  const [unreadOnly] = useUnreadOnly()
  return (
    <>
      <Anchor component="button" type="button" size="sm" onClick={seeEverything}>
        {unreadOnly ? "See everything" : "Clear search"}
      </Anchor>
      {" "}
      {/* Inline, centred on the line's text rather than sitting on its
          baseline, which leaves the key's padding hanging below the line. */}
      <Kbd size="xs" style={{ verticalAlign: "middle" }}>Esc</Kbd>
    </>
  )
}
