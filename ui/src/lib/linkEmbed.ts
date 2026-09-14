/**
 * Whether a link may be rendered in an iframe.
 *
 * Two independent reasons to refuse, and the second is a security rule:
 *
 * 1. The page's own headers forbid framing (X-Frame-Options or CSP
 *    frame-ancestors), as recorded server-side at resolution time. A blocked
 *    iframe cannot be detected from JavaScript, so this is the only way to
 *    know. Unknown counts as refused — never frame on a guess.
 * 2. The page is on OUR OWN ORIGIN. The iframe carries
 *    `allow-scripts allow-same-origin`, and that pair lets a framed document
 *    reach `parent` and delete its own sandbox — but only when it is
 *    same-origin with its embedder. This check is what guarantees it never
 *    is, and it is deliberately independent of `embeddable` so that it
 *    cannot be undone by a change to how resolution failures are recorded.
 */
export function canEmbed(url: string, embeddable: boolean | undefined, currentOrigin: string): boolean {
  try {
    if (new URL(url).origin === new URL(currentOrigin).origin) return false
  } catch {
    return false
  }
  return !!embeddable
}
