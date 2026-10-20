import { Kbd } from "@mantine/core"

/**
 * A keyboard key shown inline in a line of text ("Clear search Esc").
 *
 * Deliberately unaligned for now: vertical-align: middle sat it a little
 * low and text-top a little high beside the link, so it is left at the
 * default until the line's alignment is revisited as a whole.
 */
export function KeyHint({ children, decorative }: { children: React.ReactNode; decorative?: boolean }) {
  // `decorative` inside a control: the key is shown, not read into the
  // control's accessible name ("Mark all read", not "Mark all read R").
  return <Kbd size="xs" aria-hidden={decorative || undefined}>{children}</Kbd>
}
