import { fileAnchorId } from "./parsedPatch"

/** The class DiffBody puts on pierre's Virtualizer, the diff body's own scroll container. */
export const DIFF_SCROLLER_CLASS = "diff-body-scroller"

// Up to ~2s of frames for the file to appear and the files above it to be
// measured; a file counts as landed once it has stayed at the top this many
// frames in a row.
const MAX_FRAMES = 120
const SETTLE_FRAMES = 5

/**
 * Scrolls the diff body so `file`'s wrapper sits at the top of the
 * Virtualizer, and ONLY the Virtualizer: `scrollIntoView` would also scroll
 * the document (every scrollable ancestor), sliding the page header and
 * banner out of view.
 *
 * Retried each frame until the target exists and stays put, because on entry
 * (`&file=`) the wrapper may not be rendered yet, and pierre measures the
 * files above it as they render, which moves it after a first jump. Stops
 * early when the reader takes over (wheel, touch, pointer) and when the
 * scroller can go no further. Returns a cancel function.
 */
export function scrollToFile(file: string): () => void {
  let frames = 0
  let stable = 0
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
      const atEnd = delta > 0 && s.scrollTop >= s.scrollHeight - s.clientHeight - 1
      if (Math.abs(delta) < 1 || atEnd) stable++
      else {
        stable = 0
        s.scrollTop += delta
      }
      if (stable >= SETTLE_FRAMES) return stop()
    }
    if (++frames >= MAX_FRAMES) return stop()
    id = requestAnimationFrame(step)
  }

  step()
  return stop
}

const USER_INPUT = ["wheel", "touchstart", "pointerdown"] as const
