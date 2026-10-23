import { Anchor } from "@mantine/core"
import { KeyHint } from "./KeyHint"
import { clearLabel, useNarrowing } from "./NarrowingContext"

/**
 * The way back from whatever narrows the page, beside the line that says
 * it's narrowed. Does what Esc does (the page's clearAll), and is named for
 * what that undoes: "Clear search", "Clear filters" or "See everything".
 * The Esc hint shows only while Esc would do that next (Narrowing.escHint).
 */
export function SeeEverythingLink() {
  const narrowing = useNarrowing()
  return (
    <>
      <Anchor component="button" type="button" size="sm" onClick={narrowing.clearAll}>
        {clearLabel(narrowing)}
      </Anchor>
      {narrowing.escHint !== false && (
        <>
          {" "}
          <KeyHint>Esc</KeyHint>
        </>
      )}
    </>
  )
}
