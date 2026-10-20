import { BASE_FAVICON, useFaviconHref } from "../hooks/useUnreadFavicon"
import { useWorktrees } from "../hooks/useWorktrees"
import { otherUnread } from "../lib/unreadBadge"

/**
 * worktree's "wt" monogram: the favicon itself, which is an SVG, so it stays
 * sharp at any size and the two can never drift apart. That includes the
 * unread dot: it shows whatever frame the tab's icon is on, so it flashes
 * while ANY worktree has unread activity.
 *
 * Pass `exceptPath` to leave one worktree out: the details page passes its
 * own, so the logo rests while the only unreads are the ones already on the
 * page, and flashes only when there are unreads elsewhere too. It still
 * flashes in step with the tab, which is always blinking whenever this is.
 *
 * Decorative by default (empty alt). Pass `alt` where the logo stands in for
 * text, as it does for the home page's heading.
 */
export function Logo({ size = 36, alt = "", exceptPath }: { size?: number; alt?: string; exceptPath?: string }) {
  const href = useFaviconHref()
  const worktrees = useWorktrees().data
  const src = exceptPath === undefined || otherUnread(worktrees, exceptPath) ? href : BASE_FAVICON
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt={alt}
      style={{ display: "block", flex: "none" }}
    />
  )
}
