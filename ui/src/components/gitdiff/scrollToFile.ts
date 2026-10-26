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
  const cancelFile = scrollToFile(file)
  const deadline = performance.now() + MAX_MS
  let frame = 0
  let done = false

  const stop = () => {
    if (done) return
    done = true
    cancelAnimationFrame(frame)
    cancelFile()
  }

  const step = () => {
    if (done) return
    const el = document.querySelector(`.${DIFF_SCROLLER_CLASS} [data-review-comment-id="${id}"]`)
    if (el) {
      stop()
      el.scrollIntoView({ block: "center" })
      return
    }
    if (performance.now() >= deadline) return stop()
    frame = requestAnimationFrame(step)
  }

  step()
  return stop
}
