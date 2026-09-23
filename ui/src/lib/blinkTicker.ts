/** Milliseconds each favicon frame is shown. */
export const BLINK_MS = 600

/**
 * Calls `onTick` every BLINK_MS until the returned function is called.
 *
 * The tick comes from a Worker rather than a plain setInterval because the
 * blink matters most on a tab that is NOT in front, and that is exactly where
 * Chrome slows page timers down: a chained timer on a page hidden for more
 * than five minutes is throttled to roughly once a MINUTE, which turns the
 * flash into a favicon that changes twice an hour. Worker timers are exempt
 * from that intensive throttling, so the blink survives being left alone.
 *
 * The setInterval path is the fallback for anywhere a module Worker cannot be
 * constructed — including jsdom, which is why the tests exercise it.
 */
export function startBlink(onTick: () => void): () => void {
  try {
    const worker = new Worker(new URL("./blinkWorker.ts", import.meta.url), { type: "module" })
    worker.onmessage = () => onTick()
    worker.postMessage(BLINK_MS)
    return () => worker.terminate()
  } catch {
    const id = setInterval(onTick, BLINK_MS)
    return () => clearInterval(id)
  }
}
