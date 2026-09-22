/**
 * The blink clock for the unread favicon. See blinkTicker.ts for why the tick
 * lives out here instead of on the page.
 *
 * One message in (the interval), a bare message out on every tick. The worker
 * knows nothing about favicons — it is a timer the browser will not throttle.
 */
self.onmessage = (e: MessageEvent<number>) => {
  setInterval(() => self.postMessage(null), e.data)
}
