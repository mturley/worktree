import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import rehypeRaw from "rehype-raw"
import { type MarkdownPlugins, NotesMarkdown } from "./NotesMarkdown"

const PLUGINS: MarkdownPlugins = {
  // GitHub turns a single newline in a comment into a line break.
  remark: [remarkGfm, remarkBreaks],
  // rehype-raw turns the HTML into elements; NotesMarkdown then always runs
  // rehype-sanitize, with GitHub's own allowlist, over the result.
  rehype: [rehypeRaw],
}

/**
 * A GitHub comment rendered the way GitHub renders it: Markdown, plus the HTML
 * GitHub permits (`<details>`, `<sub>`, tables, …) as elements, filtered by
 * GitHub's allowlist so scripts, event handlers, styles and frames never
 * survive. HTML comments vanish.
 *
 * Loaded lazily (a default export for `lazy()`): rehype-raw brings an HTML
 * parser, about 50 KB gzipped, that nothing on a plain page load needs.
 */
export default function GitHubCommentMarkdown({ text, imagesAsLinks = false }: { text: string; imagesAsLinks?: boolean }) {
  return <NotesMarkdown text={text} imagesAsLinks={imagesAsLinks} plugins={PLUGINS} size="sm" />
}
