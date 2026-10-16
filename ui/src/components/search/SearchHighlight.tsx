import { Fragment } from "react"
import { splitHighlight } from "../../lib/search"
import { useSearchContext } from "./SearchContext"

/** Text with the active search terms marked. Inline: put it inside a Text. */
export function SearchHighlight({ text }: { text: string }) {
  const { terms } = useSearchContext()
  return (
    <>
      {splitHighlight(text, terms).map((p, i) =>
        p.hit ? <mark key={i} className="search-hit">{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>,
      )}
    </>
  )
}
