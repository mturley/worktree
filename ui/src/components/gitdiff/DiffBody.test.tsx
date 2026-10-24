import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs"
import { HttpError } from "../../api/client"
import type { ReviewCommentItem } from "../../api/types"
import { useDeletedDrafts } from "../../hooks/useReviewComments"
import type { CommentTarget } from "./commentRange"
import type { DiffFile } from "./parsedPatch"
import { DiffBody } from "./DiffBody"

vi.mock("@pierre/diffs/worker/worker-portable.js?worker", () => ({ default: class {} }))

// pierre stood in by the same shape it renders: a host element whose open
// shadow root holds the file header (`data-diffs-header`, with a slot for the
// React prefix) and the body; the prefix itself is a light-DOM child of the
// host, slotted into the header. `collapsed` is mirrored onto the host.
// Annotations render as pierre renders them, into light-DOM children slotted
// by side and line; every distinct options object a file is given is kept.
type MockOptions = {
  collapsed?: boolean
  unsafeCSS?: string
  expandUnchanged?: boolean
  enableGutterUtility?: boolean
  onGutterUtilityClick?: (range: SelectedLineRange) => void
}
const pierre = vi.hoisted(() => ({ options: {} as Record<string, MockOptions[]> }))
vi.mock("@pierre/diffs/react", () => ({
  WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Virtualizer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FileDiff: ({
    fileDiff,
    options,
    renderHeaderPrefix,
    renderHeaderFilenameSuffix,
    lineAnnotations,
    renderAnnotation,
  }: {
    fileDiff: FileDiffMetadata
    options: MockOptions
    renderHeaderPrefix?: (fd: FileDiffMetadata) => ReactNode
    renderHeaderFilenameSuffix?: (fd: FileDiffMetadata) => ReactNode
    lineAnnotations?: DiffLineAnnotation<unknown>[]
    renderAnnotation?: (a: DiffLineAnnotation<unknown>, fd: FileDiffMetadata) => ReactNode
  }) => {
    const seen = (pierre.options[fileDiff.name] ??= [])
    if (seen[seen.length - 1] !== options) seen.push(options)
    const host = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
      const el = host.current!
      const root = el.shadowRoot ?? el.attachShadow({ mode: "open" })
      root.innerHTML =
        `<div data-diffs-header="default"><slot name="header-prefix"></slot>` +
        `<div data-title>${fileDiff.name}<slot name="header-filename-suffix"></slot></div>` +
        `<div data-metadata><span>+1</span></div></div>` +
        `<pre data-code>line</pre>`
    }, [fileDiff.name])
    return (
      <div ref={host} data-testid={`host-${fileDiff.name}`} data-collapsed={String(!!options.collapsed)} data-css={options.unsafeCSS}>
        <div slot="header-prefix">{renderHeaderPrefix?.(fileDiff)}</div>
        <div slot="header-filename-suffix">{renderHeaderFilenameSuffix?.(fileDiff)}</div>
        {lineAnnotations?.map((a) => (
          <div key={`${a.side}-${a.lineNumber}`} slot={`annotation-${a.side}-${a.lineNumber}`}>
            {renderAnnotation?.(a, fileDiff)}
          </div>
        ))}
      </div>
    )
  },
}))

const apiMock = vi.hoisted(() => ({ updateReviewComment: vi.fn() }))
vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      settings: async () => ({ worktree: { editor: "code" } }),
      openInEditor: vi.fn(async () => ({ ok: true })),
      updateReviewComment: apiMock.updateReviewComment,
    },
  }
})

// One hunk covering lines 10-14 on both sides, all context.
const HUNKS = [
  { deletionStart: 10, deletionCount: 5, additionStart: 10, additionCount: 5, hunkContent: [{ type: "context", lines: 5 }] },
]

const diffFile = (path: string, over: Partial<DiffFile> = {}): DiffFile =>
  ({
    path,
    type: "change",
    binary: false,
    autoCollapse: false,
    meta: { name: path, type: "change", hunks: HUNKS } as unknown as FileDiffMetadata,
    ...over,
  }) as unknown as DiffFile

const item = (id: number, over: Partial<ReviewCommentItem> = {}): ReviewCommentItem => ({
  id,
  source: "draft",
  editable: true,
  file: "a.go",
  side: "new",
  start_line: 11,
  end_line: 12,
  rev: "abc",
  base: "merge-base",
  base_ref: "main",
  snippet: [],
  body: `comment ${id}`,
  version: 1,
  created_at: "",
  updated_at: "",
  prompt: { status: "current", start_line: 11, end_line: 12 },
  view: { status: "shown", start_line: 11, end_line: 12 },
  ...over,
})

type BodyProps = Parameters<typeof DiffBody>[0]
const VIEW: BodyProps["view"] = { base: "merge-base", range: "all", oldRev: "o", newRev: "n" }
const FILES = [diffFile("a.go"), diffFile("b.go")]
const noop = () => {}

const renderBody = (over: Partial<BodyProps> = {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (o: Partial<BodyProps>) => (
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <DiffBody
          files={FILES}
          loadKey="k"
          oldRev="o"
          newRev="n"
          mode="unified"
          path="/w/a"
          highlighted={null}
          height="400px"
          comments={[]}
          pending={null}
          onStartComment={noop}
          onPendingDone={noop}
          view={VIEW}
          openFile={null}
          {...o}
        />
      </QueryClientProvider>
    </MantineProvider>
  )
  const r = render(ui(over))
  return { ...r, rerender: (o: Partial<BodyProps>) => r.rerender(ui(o)) }
}

/** Renders, then waits for settings to load (the editor icons enable), so no update lands after a test. */
const wrap = async (over: Partial<BodyProps> = {}) => {
  const r = renderBody(over)
  await waitFor(() => expect(screen.getAllByRole("button", { name: /^Open .* in editor$/ }).at(-1)).toBeEnabled())
  return r
}

afterEach(() => {
  cleanup()
  pierre.options = {}
})

const collapsed = (name: string) => screen.getByTestId(`host-${name}`).dataset.collapsed
/** Clicks an element inside the host's shadow root, as a real click would. */
const clickInShadow = (name: string, selector: string) =>
  act(() => {
    const el = screen.getByTestId(`host-${name}`).shadowRoot!.querySelector(selector)!
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }))
  })

describe("DiffBody file header", () => {
  it("collapses and expands a file from anywhere on its header", async () => {
    await wrap()
    expect(collapsed("a.go")).toBe("false")
    clickInShadow("a.go", "[data-title]")
    expect(collapsed("a.go")).toBe("true")
    clickInShadow("a.go", "[data-metadata] span")
    expect(collapsed("a.go")).toBe("false")
    clickInShadow("a.go", "[data-diffs-header]")
    expect(collapsed("a.go")).toBe("true")
    // Only that file.
    expect(collapsed("b.go")).toBe("false")
  })

  it("leaves the file alone when its code is clicked", async () => {
    await wrap()
    clickInShadow("a.go", "[data-code]")
    expect(collapsed("a.go")).toBe("false")
  })

  it("toggles once, not twice, from the chevron", async () => {
    const user = userEvent.setup()
    await wrap()
    await user.click(screen.getByRole("button", { name: "Collapse a.go" }))
    expect(collapsed("a.go")).toBe("true")
    await user.click(screen.getByRole("button", { name: "Expand a.go" }))
    expect(collapsed("a.go")).toBe("false")
  })

  it("does not toggle from the editor icon", async () => {
    const user = userEvent.setup()
    await wrap()
    // The icon swaps out of its disabled wrapper once settings load, so look it up again.
    const icon = () => screen.getByRole("button", { name: "Open a.go in editor" })
    await vi.waitFor(() => expect(icon()).toBeEnabled())
    await user.click(icon())
    expect(collapsed("a.go")).toBe("false")
  })

  it("puts the editor icon after the file name, the chevron before it", async () => {
    await wrap()
    const icon = screen.getByRole("button", { name: "Open a.go in editor" })
    expect(icon.closest('[slot="header-filename-suffix"]')).not.toBeNull()
    const chevron = screen.getByRole("button", { name: "Collapse a.go" })
    expect(chevron.closest('[slot="header-prefix"]')).not.toBeNull()
  })

  it("gives the header a pointer cursor", async () => {
    await wrap()
    expect(screen.getByTestId("host-a.go").dataset.css).toMatch(/\[data-diffs-header\][^{]*\{[^}]*cursor:\s*pointer/)
  })
})

const slot = (file: string, side: "additions" | "deletions", line: number) =>
  screen.getByTestId(`host-${file}`).querySelector<HTMLElement>(`[slot="annotation-${side}-${line}"]`)
const lastOptions = (file: string) => pierre.options[file][pierre.options[file].length - 1]

describe("DiffBody review comments", () => {
  it("renders a shown comment as an annotation at its end line", async () => {
    await wrap({ comments: [item(1)] })
    expect(slot("a.go", "additions", 12)).toHaveTextContent("comment 1")
    expect(slot("b.go", "additions", 12)).toBeNull()
  })

  it("places an old-side comment by the file's previous name", async () => {
    const renamed = diffFile("new.go", {
      meta: { name: "new.go", prevName: "old.go", type: "rename-changed", hunks: HUNKS } as unknown as FileDiffMetadata,
    })
    await wrap({
      files: [renamed],
      comments: [item(1, { file: "old.go", side: "old", view: { status: "shown", start_line: 10, end_line: 11 } })],
    })
    expect(slot("new.go", "deletions", 11)).toHaveTextContent("comment 1")
  })

  it("groups comments ending on the same line", async () => {
    await wrap({ comments: [item(1), item(2, { view: { status: "shown", start_line: 12, end_line: 12 } })] })
    const s = slot("a.go", "additions", 12)!
    expect(s.querySelectorAll("[data-review-comment-id]")).toHaveLength(2)
    expect(s).toHaveTextContent("comment 1")
    expect(s).toHaveTextContent("comment 2")
  })

  it("does not render outdated or not-in-view comments inline", async () => {
    await wrap({
      comments: [
        item(1, { view: { status: "outdated" } }),
        item(2, { view: { status: "not_in_view" } }),
        item(3, { view: { status: "outside_changes" } }),
        item(4, { view: undefined }),
      ],
    })
    expect(screen.queryByText(/comment \d/)).toBeNull()
  })

  it("gutter click starts a comment with the mapped target", async () => {
    const onStartComment = vi.fn()
    await wrap({ onStartComment })
    const o = lastOptions("a.go")
    expect(o.enableGutterUtility).toBe(true)
    act(() => o.onGutterUtilityClick!({ start: 13, end: 11, side: "additions" }))
    expect(onStartComment).toHaveBeenCalledWith({ file: "a.go", side: "new", start: 11, end: 13 })
  })

  it("pending target renders the new-comment editor", async () => {
    const pending: CommentTarget = { file: "a.go", side: "new", start: 11, end: 13 }
    await wrap({ pending })
    expect(slot("a.go", "additions", 13)!.querySelector("textarea[aria-label='Comment']")).not.toBeNull()
    expect(slot("b.go", "additions", 13)).toBeNull()
  })

  it("pending target shares a line with existing comments", async () => {
    const pending: CommentTarget = { file: "a.go", side: "new", start: 12, end: 12 }
    await wrap({ pending, comments: [item(1)] })
    const s = slot("a.go", "additions", 12)!
    expect(s).toHaveTextContent("comment 1")
    expect(s.querySelector("textarea")).not.toBeNull()
  })

  it("expands unchanged lines when a comment is outside the hunks", async () => {
    await wrap({ comments: [item(1, { view: { status: "shown", start_line: 40, end_line: 41 } })] })
    expect(lastOptions("a.go").expandUnchanged).toBe(true)
    expect(lastOptions("b.go").expandUnchanged).toBeFalsy()
    expect(slot("a.go", "additions", 41)).toHaveTextContent("comment 1")
  })

  it("does not expand when every comment is inside the hunks", async () => {
    await wrap({ comments: [item(1)] })
    expect(lastOptions("a.go").expandUnchanged).toBeFalsy()
  })

  it("keeps pierre's options stable across a poll", async () => {
    const r = await wrap({ comments: [item(1)] })
    const before = lastOptions("a.go")
    r.rerender({ comments: [item(1)], onStartComment: () => {} })
    expect(pierre.options["a.go"]).toHaveLength(1)
    expect(lastOptions("a.go")).toBe(before)
  })

  it("openFile unfolds a collapsed file", async () => {
    const files = [diffFile("a.go", { autoCollapse: true }), diffFile("b.go")]
    const r = await wrap({ files })
    expect(collapsed("a.go")).toBe("true")
    r.rerender({ files, openFile: { file: "a.go", n: 1 } })
    expect(collapsed("a.go")).toBe("false")
    // Folded again, the next request opens it again.
    await userEvent.click(screen.getByRole("button", { name: "Collapse a.go" }))
    expect(collapsed("a.go")).toBe("true")
    r.rerender({ files, openFile: { file: "a.go", n: 2 } })
    expect(collapsed("a.go")).toBe("false")
  })

  it("renders a deleted-elsewhere draft inline after the comment leaves the list", async () => {
    const c = item(5)
    let dismiss: (id: number) => void = noop
    function Seed() {
      const { add, dismiss: d } = useDeletedDrafts("/w/a")
      dismiss = d
      useEffect(() => add({ comment: c, text: "my unsaved text", view: "o..n" }), [add])
      return null
    }
    const r = await wrap({ comments: [c] })
    render(<Seed />)
    r.rerender({ comments: [] })
    const s = slot("a.go", "additions", 12)!
    expect(s).toHaveTextContent("Deleted elsewhere")
    expect(s).toHaveTextContent("my unsaved text")
    act(() => dismiss(5))
    expect(slot("a.go", "additions", 12)).toBeNull()
  })

  it("leaves a tombstone from another view (or none) out of the diff", async () => {
    let dismiss: (id: number) => void = noop
    function Seed() {
      const { add, dismiss: d } = useDeletedDrafts("/w/a")
      dismiss = d
      useEffect(() => {
        add({ comment: item(5), text: "older view", view: "o0..n0" })
        add({ comment: item(6, { end_line: 13 }), text: "unknown view" })
      }, [add])
      return null
    }
    await wrap()
    render(<Seed />)
    expect(slot("a.go", "additions", 12)).toBeNull()
    expect(slot("a.go", "additions", 13)).toBeNull()
    act(() => {
      dismiss(5)
      dismiss(6)
    })
  })

  it("inline cards record the view with a tombstone", async () => {
    apiMock.updateReviewComment.mockRejectedValueOnce(new HttpError("gone", 404))
    const drafts = renderHook(() => useDeletedDrafts("/w/a")).result
    await wrap({ comments: [item(8)] })
    await userEvent.click(screen.getByRole("button", { name: "Edit comment" }))
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(drafts.current.drafts).toHaveLength(1))
    expect(drafts.current.drafts[0].view).toBe("o..n")
    act(() => drafts.current.dismiss(8))
  })
})
