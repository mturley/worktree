import { useMemo } from "react"
import { parseDiffFromFile } from "@pierre/diffs"
import { FileDiff } from "@pierre/diffs/react"

/*
 * Unified: the modal is too narrow for split. Word-level highlights, since a
 * description edit is usually a few words in a paragraph, and paragraphs are
 * often single lines far longer than pierre's 1000-character default, so the
 * limit is raised, though capped so one pathological line can't hang the
 * modal. Wrapped, because prose scrolled sideways is unreadable. No file
 * header: there is no file, and the modal's title says what changed.
 */
const OPTIONS = {
  diffStyle: "unified",
  themeType: "dark",
  lineDiffType: "word",
  maxLineDiffLength: 20000,
  disableFileHeader: true,
  overflow: "wrap",
} as const

/**
 * The diff between a description's old and new text, as plain text.
 *
 * Line endings are normalized first: Jira and GitHub hand back `\r\n` and `\n`
 * interchangeably, and a change of line endings alone is not an edit anyone
 * made. A name with no extension is what keeps pierre on plain text, with no
 * language to highlight; the whole text is given, so the folded unchanged
 * lines expand from it, with nothing to fetch.
 *
 * Its own module, loaded lazily, so @pierre/diffs stays out of the main chunk.
 */
export default function DescriptionDiff({ oldText, newText, cacheKey }: {
  oldText: string
  newText: string
  /** Identifies this pair of texts (the event id) for pierre's caches. */
  cacheKey: string
}) {
  const meta = useMemo(
    () =>
      parseDiffFromFile(
        { name: "description", contents: normalize(oldText), cacheKey: `${cacheKey}:old` },
        { name: "description", contents: normalize(newText), cacheKey: `${cacheKey}:new` },
      ),
    [oldText, newText, cacheKey],
  )
  return <FileDiff fileDiff={meta} options={OPTIONS} />
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n")
}
