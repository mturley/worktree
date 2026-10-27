import { fileAnchorId } from "./parsedPatch"

/** The class DiffBody puts on pierre's Virtualizer, the diff body's own scroll container. */
export const DIFF_SCROLLER_CLASS = "diff-body-scroller"

// How long to keep trying, in time rather than frames: on entry the patch,
// pierre's worker and its measuring all have to finish first, which takes as
// long as it takes, not a fixed number of frames. A file counts as landed
// once it has stayed at the top, with the content no longer growing, this
// many frames in a row.
const MAX_MS = 4000
const SETTLE_FRAMES = 5

/**
 * Scrolls the diff body so `file`'s wrapper sits at the top of the
 * Virtualizer, and ONLY the Virtualizer: `scrollIntoView` would also scroll
 * the document (every scrollable ancestor), sliding the page header and
 * banner out of view.
 *
 * Retried each frame until the target exists and stays put, because on entry
 * (`&file=`) the wrapper may not be rendered yet, and pierre measures the
 * files above it as they render, which moves it after a first jump.
 *
 * "The scroller can go no further" is never taken as done: right after entry
 * the files have not been measured, so the scroller is not even scrollable
 * yet and is trivially "at the end" with the target a few pixels down. That
 * used to end the scroll at the first file. Instead it keeps holding until
 * the time bound, which costs nothing when the target really is near the
 * end. Stops early when the reader takes over (wheel, touch, pointer, keys).
 * Returns a cancel function.
 */
export function scrollToFile(file: string): () => void {
  const deadline = performance.now() + MAX_MS
  let stable = 0
  let lastHeight = -1
  let id = 0
  let done = false
  let scroller: HTMLElement | null = null

  const stop = () => {
    if (done) return
    done = true
    cancelAnimationFrame(id)
    if (scroller) for (const ev of USER_INPUT) scroller.removeEventListener(ev, stop)
  }

  const step = () => {
    if (done) return
    const el = document.getElementById(fileAnchorId(file))
    const s = el?.closest<HTMLElement>(`.${DIFF_SCROLLER_CLASS}`) ?? null
    if (el && s) {
      if (!scroller) {
        scroller = s
        for (const ev of USER_INPUT) s.addEventListener(ev, stop, { passive: true })
      }
      const delta = el.getBoundingClientRect().top - s.getBoundingClientRect().top
      const grown = s.scrollHeight !== lastHeight
      lastHeight = s.scrollHeight
      if (Math.abs(delta) < 1 && !grown) stable++
      else {
        stable = 0
        if (Math.abs(delta) >= 1) s.scrollTop += delta
      }
      if (stable >= SETTLE_FRAMES) return stop()
    }
    if (performance.now() >= deadline) return stop()
    id = requestAnimationFrame(step)
  }

  step()
  return stop
}

const USER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const

/**
 * Brings a review comment into view: scrolls to its file (scrollToFile),
 * then, retried each frame within the same time bound, centres the comment
 * once pierre has rendered it, ending the file scroll so the two don't
 * fight. The diff view fills the page, so `scrollIntoView` has nothing above
 * the diff body to move. Returns a cancel function.
 */
export function scrollToComment(file: string, id: number): () => void {
  return scrollToInline(file, `[data-review-comment-id="${id}"]`)
}

/** scrollToComment for a PR review thread's inline card. */
export function scrollToPRThread(file: string, threadId: string): () => void {
  return scrollToInline(file, `[data-pr-thread-id="${quoteAttr(threadId)}"]`)
}

/**
 * Brings a PR thread's card in the review sidebar into view, for a thread
 * the diff doesn't show. Retried each frame, as the sidebar (or the phone's
 * drawer) may only just be opening. Returns a cancel function.
 */
export function scrollToSidebarThread(threadId: string): () => void {
  const sel = `[data-pr-thread-id="${quoteAttr(threadId)}"]`
  return retry(() => {
    const el = [...document.querySelectorAll(sel)].find((e) => !e.closest(`.${DIFF_SCROLLER_CLASS}`))
    if (!el) return false
    el.scrollIntoView({ block: "center" })
    return true
  })
}

// Thread ids are GitHub node ids; quoted, only `"` and `\` need escaping.
const quoteAttr = (v: string) => v.replace(/["\\]/g, "\\$&")

/** Scrolls to `file`, then centres the element `selector` matches inside the diff body once it renders. */
function scrollToInline(file: string, selector: string): () => void {
  const cancelFile = scrollToFile(file)
  const cancel = retry(() => {
    const el = document.querySelector(`.${DIFF_SCROLLER_CLASS} ${selector}`)
    if (!el) return false
    cancelFile()
    el.scrollIntoView({ block: "center" })
    return true
  }, cancelFile)
  return () => {
    cancel()
    cancelFile()
  }
}

/** Calls `attempt` each frame until it returns true or the time bound passes, then `onGiveUp`. */
function retry(attempt: () => boolean, onGiveUp?: () => void): () => void {
  const deadline = performance.now() + MAX_MS
  let frame = 0
  let done = false
  const stop = () => {
    done = true
    cancelAnimationFrame(frame)
  }
  const step = () => {
    if (done) return
    if (attempt()) return stop()
    if (performance.now() >= deadline) {
      stop()
      onGiveUp?.()
      return
    }
    frame = requestAnimationFrame(step)
  }
  step()
  return stop
}
