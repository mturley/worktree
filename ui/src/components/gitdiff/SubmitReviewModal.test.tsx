import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { Notifications, notifications } from "@mantine/notifications"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { HttpError } from "../../api/client"
import type { PRReviewDialog } from "../../api/types"
import { SubmitReviewModal } from "./SubmitReviewModal"

const api = vi.hoisted(() => ({
  prReviewDialog: vi.fn(),
  prSubmit: vi.fn(),
}))

vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return {
    ...actual,
    api: { ...actual.api, prReviewDialog: api.prReviewDialog, prSubmit: api.prSubmit },
  }
})

const HEAD = "1111111111111111111111111111111111111111"

const dialog = (over: Partial<PRReviewDialog> = {}): PRReviewDialog => ({
  pr: { id: "PR_1", number: 12, url: "https://github.com/o/r/pull/12", title: "Fix the widget" },
  viewer_is_author: false,
  head: HEAD,
  stale_pending_commit: null,
  pending: { comments: [{ id: 7, file: "src/p.ts", line: 4, body: "pending body" }] },
  local: [
    { id: 1, version: 1, file: "src/a.ts", side: "RIGHT", start_line: 3, end_line: 5, body: "local one", postable: true, reason: "" },
    { id: 2, version: 1, file: "src/b.ts", side: "RIGHT", start_line: 9, end_line: 9, body: "local two", postable: false, reason: "on uncommitted changes" },
  ],
  blocked_reason: null,
  ...over,
})

let onClose: ReturnType<typeof vi.fn>

beforeEach(() => {
  onClose = vi.fn()
  api.prReviewDialog.mockResolvedValue(dialog())
  api.prSubmit.mockResolvedValue({ submitted_review_id: "R1", posted_local_ids: [1], kept_local_ids: [2] })
})
afterEach(() => {
  cleanup()
  notifications.clean()
  vi.clearAllMocks()
})

const wrap = (qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider client={qc}>
        <SubmitReviewModal path="/w/a" opened onClose={onClose} />
      </QueryClientProvider>
    </MantineProvider>,
  )

const before = (a: Element, b: Element) => {
  expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
}

describe("SubmitReviewModal", () => {
  it("lays out the dialog top to bottom", async () => {
    wrap()
    const include = await screen.findByRole("checkbox", { name: "Include my 2 local comments" })
    const order = [
      screen.getByRole("textbox", { name: "Review message" }),
      screen.getByRole("radio", { name: /^Comment/ }),
      screen.getByRole("radio", { name: /^Approve/ }),
      screen.getByRole("radio", { name: /^Request changes/ }),
      include,
      screen.getByText("In this review (2)"),
      screen.getByText("Pending on GitHub"),
      screen.getByText("Local"),
      screen.getByText("Your pending review on PR #12 (1 comment) will be submitted."),
      screen.getByText("1 of 2 local comments can't be posted and will stay here"),
      screen.getByRole("button", { name: "Cancel" }),
      screen.getByRole("button", { name: "Submit review (2)" }),
    ]
    for (let i = 1; i < order.length; i++) before(order[i - 1], order[i])
    expect(screen.getByText("Submit general feedback without explicit approval.")).toBeInTheDocument()
    expect(screen.getByText("Give your approval to merge these changes.")).toBeInTheDocument()
    expect(screen.getByText("Submit feedback that must be addressed before merging.")).toBeInTheDocument()
    expect(screen.getByText("src/p.ts:4")).toBeInTheDocument()
    expect(screen.getByText("src/a.ts:3-5")).toBeInTheDocument()
    expect(screen.getByText("pending body")).toBeInTheDocument()
    expect(screen.getByText("local one")).toBeInTheDocument()
    // The unpostable one is listed in the warning, with its reason, not in the review.
    expect(screen.getByText("src/b.ts:9 — on uncommitted changes")).toBeInTheDocument()
  })

  it("shows the stale pending review notice", async () => {
    api.prReviewDialog.mockResolvedValue(dialog({ stale_pending_commit: "abc1234" }))
    wrap()
    expect(
      await screen.findByText(
        "Your pending review on PR #12 is on an older commit (abc1234). Comments on newer code can't be added to it; submit it to start a new one.",
      ),
    ).toBeInTheDocument()
  })

  it("unchecking the box drops local comments from the list and hides the warning", async () => {
    wrap()
    const include = await screen.findByRole("checkbox", { name: "Include my 2 local comments" })
    expect(include).toBeChecked()
    fireEvent.click(include)
    expect(include).not.toBeChecked()
    expect(screen.getByText("In this review (1)")).toBeInTheDocument()
    expect(screen.queryByText("local one")).toBeNull()
    expect(screen.queryByText(/can't be posted and will stay here/)).toBeNull()
    expect(screen.getByRole("button", { name: "Submit review (1)" })).toBeInTheDocument()
  })

  it("leaves the box unchecked when no local comment can be posted", async () => {
    api.prReviewDialog.mockResolvedValue(
      dialog({ local: [dialog().local[1]] }),
    )
    wrap()
    expect(await screen.findByRole("checkbox", { name: "Include my 1 local comment" })).not.toBeChecked()
  })

  it("hides the box with no local comments", async () => {
    api.prReviewDialog.mockResolvedValue(dialog({ local: [] }))
    wrap()
    await screen.findByText("In this review (1)")
    expect(screen.queryByRole("checkbox")).toBeNull()
  })

  it("disables Approve and Request changes on your own PR", async () => {
    api.prReviewDialog.mockResolvedValue(dialog({ viewer_is_author: true }))
    wrap()
    await screen.findByText("In this review (2)")
    expect(screen.getByRole("radio", { name: /^Approve/ })).toBeDisabled()
    expect(screen.getByRole("radio", { name: /^Request changes/ })).toBeDisabled()
    expect(screen.getByRole("radio", { name: /^Comment/ })).toBeEnabled()
  })

  it("disables Submit for an empty Comment", async () => {
    api.prReviewDialog.mockResolvedValue(dialog({ pending: null, local: [] }))
    wrap()
    const submit = await screen.findByRole("button", { name: "Submit review" })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByRole("textbox", { name: "Review message" }), { target: { value: "LGTM" } })
    expect(submit).toBeEnabled()
    fireEvent.change(screen.getByRole("textbox", { name: "Review message" }), { target: { value: "" } })
    fireEvent.click(screen.getByRole("radio", { name: /^Approve/ }))
    expect(submit).toBeEnabled()
  })

  it("disables Submit with the blocked reason while local comments are included", async () => {
    api.prReviewDialog.mockResolvedValue(dialog({ blocked_reason: "Fetch the PR's latest commits first" }))
    wrap()
    const submit = await screen.findByRole("button", { name: "Submit review (2)" })
    expect(submit).toBeDisabled()
    expect(screen.getByText("Fetch the PR's latest commits first")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox", { name: "Include my 2 local comments" }))
    expect(screen.getByRole("button", { name: "Submit review (1)" })).toBeEnabled()
  })

  it("submits, closes and toasts", async () => {
    wrap()
    await screen.findByText("In this review (2)")
    fireEvent.click(screen.getByRole("radio", { name: /^Approve/ }))
    fireEvent.click(screen.getByRole("button", { name: "Submit review (2)" }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.prSubmit).toHaveBeenCalledWith({
      path: "/w/a",
      head: HEAD,
      event: "APPROVE",
      body: "",
      include_local: true,
    })
    expect(await screen.findByText("Review submitted to PR #12")).toBeInTheDocument()
  })

  it("a 200 that carries an error is still a submitted review: toasts, closes, and warns", async () => {
    api.prSubmit.mockResolvedValue({
      submitted_review_id: "R1",
      posted_local_ids: [1],
      kept_local_ids: [],
      error: "listing local comments: database is locked",
    })
    wrap()
    await screen.findByText("In this review (2)")
    fireEvent.click(screen.getByRole("button", { name: "Submit review (2)" }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(await screen.findByText("Review submitted to PR #12")).toBeInTheDocument()
    expect(await screen.findByText(/listing local comments: database is locked/)).toBeInTheDocument()
    expect(api.prSubmit).toHaveBeenCalledTimes(1)
  })

  it("on reopen, Submit waits for the fresh dialog rather than acting on the last one", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // The last opening's data, still cached.
    qc.setQueryData(["pr-review-dialog", "/w/a"], dialog({ head: "0000000000000000000000000000000000000000" }))
    let resolve: (v: PRReviewDialog) => void = () => {}
    api.prReviewDialog.mockReturnValue(new Promise((r) => (resolve = r)))
    wrap(qc)
    const submit = await screen.findByRole("button", { name: "Submit review (2)" })
    expect(submit).toBeDisabled()
    resolve(dialog())
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit review (2)" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Submit review (2)" }))
    await waitFor(() => expect(api.prSubmit).toHaveBeenCalledWith(expect.objectContaining({ head: HEAD })))
  })

  it("on a 409, shows the reason and reloads the dialog", async () => {
    api.prSubmit.mockRejectedValue(
      new HttpError("conflict", 409, { reason: "PR #12 has new commits — review the list again" }),
    )
    wrap()
    await screen.findByText("In this review (2)")
    expect(api.prReviewDialog).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "Submit review (2)" }))
    expect(await screen.findByText("PR #12 has new commits — review the list again")).toBeInTheDocument()
    await waitFor(() => expect(api.prReviewDialog).toHaveBeenCalledTimes(2))
    expect(onClose).not.toHaveBeenCalled()
  })

  it("on a 502, shows the error, stays open and reloads the dialog", async () => {
    api.prSubmit.mockRejectedValue(new HttpError("GitHub said no", 502))
    wrap()
    await screen.findByText("In this review (2)")
    fireEvent.click(screen.getByRole("button", { name: "Submit review (2)" }))
    expect(await screen.findByText("GitHub said no")).toBeInTheDocument()
    await waitFor(() => expect(api.prReviewDialog).toHaveBeenCalledTimes(2))
    expect(onClose).not.toHaveBeenCalled()
  })

  it("shows the PR title beside the modal title", async () => {
    wrap()
    const t = await screen.findByText("Fix the widget")
    expect(screen.getByText("Submit review to PR #12")).toBeInTheDocument()
    expect(t.closest(".mantine-Modal-title")).not.toBeNull()
  })

  it("closes on Escape when nothing is in flight", async () => {
    wrap()
    await screen.findByText("In this review (2)")
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    expect(onClose).toHaveBeenCalled()
  })

  it("can't be closed while a submit is in flight", async () => {
    let resolve: (v: unknown) => void = () => {}
    api.prSubmit.mockReturnValue(new Promise((r) => (resolve = r)))
    wrap()
    await screen.findByText("In this review (2)")
    fireEvent.click(screen.getByRole("button", { name: "Submit review (2)" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled())
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    const overlay = document.querySelector(".mantine-Modal-overlay")
    if (overlay) {
      fireEvent.mouseDown(overlay)
      fireEvent.click(overlay)
    }
    expect(onClose).not.toHaveBeenCalled()
    resolve({ submitted_review_id: "R1", posted_local_ids: [1], kept_local_ids: [2] })
    // The submit's own success still closes and toasts.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(await screen.findByText("Review submitted to PR #12")).toBeInTheDocument()
  })

  it("clears a shown error once the review is edited", async () => {
    api.prSubmit.mockRejectedValue(new HttpError("GitHub said no", 502))
    wrap()
    await screen.findByText("In this review (2)")
    const fail = async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Submit review/ }))
      expect(await screen.findByText("GitHub said no")).toBeInTheDocument()
    }
    await fail()
    fireEvent.change(screen.getByRole("textbox", { name: "Review message" }), { target: { value: "x" } })
    expect(screen.queryByText("GitHub said no")).toBeNull()
    await fail()
    fireEvent.click(screen.getByRole("radio", { name: /^Approve/ }))
    expect(screen.queryByText("GitHub said no")).toBeNull()
    await fail()
    fireEvent.click(screen.getByRole("checkbox", { name: "Include my 2 local comments" }))
    expect(screen.queryByText("GitHub said no")).toBeNull()
  })

  it("has no inner scroll container", async () => {
    wrap()
    await screen.findByText("In this review (2)")
    const modal = screen.getByRole("dialog")
    expect(modal.querySelector(".mantine-ScrollArea-root")).toBeNull()
    for (const el of [modal, ...modal.querySelectorAll<HTMLElement>("*")]) {
      for (const v of [el.style.overflow, el.style.overflowY, getComputedStyle(el).overflowY]) {
        expect(v, el.outerHTML.slice(0, 120)).not.toMatch(/auto|scroll/)
      }
      expect(el.style.maxHeight, el.outerHTML.slice(0, 120)).toBe("")
    }
  })
})
