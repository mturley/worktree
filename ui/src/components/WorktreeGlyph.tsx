/**
 * The "⎇" that marks a worktree's name, as task links show it. Hidden from
 * assistive tech and kept out of the name's own element, so a heading or a
 * search for the name still reads just the name.
 */
export function WorktreeGlyph() {
  return <span aria-hidden style={{ marginRight: "0.3em" }}>⎇</span>
}
