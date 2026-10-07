/**
 * worktree's "wt" monogram: the favicon itself, which is an SVG, so it stays
 * sharp at any size and the two can never drift apart.
 *
 * Decorative by default (empty alt). Pass `alt` where the logo stands in for
 * text, as it does for the home page's heading.
 */
export function Logo({ size = 28, alt = "" }: { size?: number; alt?: string }) {
  return (
    <img
      src="/favicon.svg?v=2"
      width={size}
      height={size}
      alt={alt}
      style={{ display: "block", flex: "none" }}
    />
  )
}
