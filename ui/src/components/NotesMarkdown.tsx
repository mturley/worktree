import { createContext, useContext, useMemo, useRef } from "react"
import Markdown, { type Components, type Options } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeSanitize from "rehype-sanitize"
import { Box } from "@mantine/core"

const NOTES_REMARK = [remarkGfm]

/**
 * Extra plugins, for GitHubCommentMarkdown: see `plugins` below. rehype-sanitize
 * always runs after the rehype ones, so no caller can render unsanitized HTML.
 */
export interface MarkdownPlugins {
  remark: NonNullable<Options["remarkPlugins"]>
  rehype: NonNullable<Options["rehypePlugins"]>
}

// The source offset of the task list item being rendered, so its checkbox —
// which react-markdown renders with no position of its own — knows which
// "[ ]" in the notes it stands for. Nested items provide their own.
const TaskOffset = createContext<number | undefined>(undefined)

// Whether the element being rendered is inside a link.
const InLink = createContext(false)

/**
 * Worktree notes rendered as GitHub-flavoured Markdown.
 *
 * react-markdown builds React elements and ignores raw HTML by default, so
 * nothing typed into the notes is ever injected as HTML. Do not add
 * rehype-raw here.
 *
 * `plugins` replaces the remark plugins and adds rehype ones, always followed
 * by rehype-sanitize (GitHub's allowlist). It exists for GitHubCommentMarkdown,
 * which adds rehype-raw from a lazily loaded chunk; anything else that wants
 * raw HTML goes through that.
 *
 * With `onToggleTask`, task list checkboxes are clickable, like GitHub issue
 * descriptions: a click reports the item's offset in `text`, and the caller
 * flips that one marker (see lib/taskList.ts). Without it they are inert.
 *
 * With `plainLinks`, links render as plain text: for a caller that is itself
 * a link (the home page's worktree card), where a nested <a> is invalid and
 * would steal the card's click.
 *
 * With `imagesAsLinks`, images render as links to them instead of loading:
 * for text written by others (PR review comments), where an image could be
 * a tracking pixel or an attachment only GitHub's session can fetch.
 *
 * Styled by styles/notes.css.
 */
export function NotesMarkdown({ text, onToggleTask, plainLinks = false, imagesAsLinks = false, plugins, size = "xs" }: {
  text: string
  onToggleTask?: (offset: number) => void
  plainLinks?: boolean
  imagesAsLinks?: boolean
  plugins?: MarkdownPlugins
  /** Font size; "xs" suits notes in a card, "sm" a body in a modal. */
  size?: "xs" | "sm"
}) {
  // Held in a ref so `components` keeps one identity: a new component
  // function per render would remount the whole rendered list.
  const toggleRef = useRef(onToggleTask)
  toggleRef.current = onToggleTask
  const clickable = !!onToggleTask

  const components = useMemo<Components>(() => ({
    // Links leave the app: the notes are the user's own text, but the UI
    // must not be navigated away from by a click on one.
    a: ({ node: _node, ...props }) => plainLinks
      ? <span>{props.children}</span>
      : <InLink.Provider value><a {...props} target="_blank" rel="noreferrer" /></InLink.Provider>,
    ...(imagesAsLinks && {
      img: function ImageLink({ src, alt }) {
        const inLink = useContext(InLink)
        const href = typeof src === "string" ? src : undefined
        const label = alt || href || "image"
        // A linked image (a CI badge) keeps the link around it: a link
        // inside a link is invalid, and the outer one is where it points.
        return href && !plainLinks && !inLink
          ? <a href={href} target="_blank" rel="noreferrer">{label}</a>
          : <span>{label}</span>
      },
    }),
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
  }), [clickable, plainLinks, imagesAsLinks])

  // Sanitize last: it must see the elements every other plugin produced.
  const rehype = useMemo(() => plugins && [...plugins.rehype, rehypeSanitize], [plugins])

  return (
    <Box className="worktree-notes" fz={size}>
      <Markdown
        remarkPlugins={plugins?.remark ?? NOTES_REMARK}
        rehypePlugins={rehype}
        components={components}
      >
        {text}
      </Markdown>
    </Box>
  )
}
