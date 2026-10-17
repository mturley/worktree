import { Kbd } from "@mantine/core"

/**
 * A keyboard key shown inline in a line of text ("Clear search Esc").
 *
 * Deliberately unaligned for now: vertical-align: middle sat it a little
 * low and text-top a little high beside the link, so it is left at the
 * default until the line's alignment is revisited as a whole.
 */
export function KeyHint({ children }: { children: React.ReactNode }) {
  return <Kbd size="xs">{children}</Kbd>
}
