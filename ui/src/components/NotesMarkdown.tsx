import { createContext, useContext, useMemo, useRef } from "react"
import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { Box } from "@mantine/core"

// The source offset of the task list item being rendered, so its checkbox —
// which react-markdown renders with no position of its own — knows which
// "[ ]" in the notes it stands for. Nested items provide their own.
const TaskOffset = createContext<number | undefined>(undefined)

/**
 * Worktree notes rendered as GitHub-flavoured Markdown.
 *
 * react-markdown builds React elements and ignores raw HTML by default, so
 * nothing typed into the notes is ever injected as HTML. Do not add
 * rehype-raw here.
 *
 * With `onToggleTask`, task list checkboxes are clickable, like GitHub issue
 * descriptions: a click reports the item's offset in `text`, and the caller
 * flips that one marker (see lib/taskList.ts). Without it they are inert.
 *
 * Styled by styles/notes.css.
 */
export function NotesMarkdown({ text, onToggleTask }: {
  text: string
  onToggleTask?: (offset: number) => void
}) {
  // Held in a ref so `components` keeps one identity: a new component
  // function per render would remount the whole rendered list.
  const toggleRef = useRef(onToggleTask)
  toggleRef.current = onToggleTask
  const clickable = !!onToggleTask

  const components = useMemo<Components>(() => ({
    // Links leave the app: the notes are the user's own text, but the UI
    // must not be navigated away from by a click on one.
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
    li: ({ node, children, ...props }) => {
      const cls = node?.properties?.className
      const isTask = Array.isArray(cls) && cls.includes("task-list-item")
      return (
        <li {...props}>
          {isTask ? (
            <TaskOffset.Provider value={node?.position?.start.offset}>{children}</TaskOffset.Provider>
          ) : children}
        </li>
      )
    },
    input: function TaskCheckbox({ node: _node, ...props }) {
      const offset = useContext(TaskOffset)
      if (props.type !== "checkbox" || !clickable || offset === undefined) {
        return <input {...props} />
      }
      return (
        <input
          type="checkbox"
          checked={!!props.checked}
          onChange={() => toggleRef.current?.(offset)}
          style={{ cursor: "pointer" }}
        />
      )
    },
  }), [clickable])

  return (
    <Box className="worktree-notes" fz="xs">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </Box>
  )
}
