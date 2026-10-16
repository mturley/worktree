import { useFaviconHref } from "../hooks/useUnreadFavicon"

/**
 * worktree's "wt" monogram: the favicon itself, which is an SVG, so it stays
 * sharp at any size and the two can never drift apart. That includes the
 * unread dot: it shows whatever frame the tab's icon is on, so it flashes
 * while ANY worktree has unread activity.
 *
 * Decorative by default (empty alt). Pass `alt` where the logo stands in for
 * text, as it does for the home page's heading.
 */
export function Logo({ size = 36, alt = "" }: { size?: number; alt?: string }) {
  const src = useFaviconHref()
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
