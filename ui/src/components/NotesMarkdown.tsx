import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { Box } from "@mantine/core"

// Links leave the app: the notes are the user's own text, but the UI must
// not be navigated away from by a click on one.
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
}

/**
 * Worktree notes rendered as GitHub-flavoured Markdown.
 *
 * react-markdown builds React elements and ignores raw HTML by default, so
 * nothing typed into the notes is ever injected as HTML. Do not add
 * rehype-raw here.
 *
 * Styled by styles/notes.css.
 */
export function NotesMarkdown({ text }: { text: string }) {
  return (
    <Box className="worktree-notes" fz="xs">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </Box>
  )
}
