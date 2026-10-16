import { Kbd } from "@mantine/core"

/**
 * A keyboard key shown inline in a line of text ("Clear search Esc").
 *
 * vertical-align: text-top, measured: a Kbd's own padding and border make it
 * taller than the text, and "middle" (the x-height midpoint) or the default
 * baseline sit it ~2-3px low. text-top lands its centre on the text's centre
 * without growing the line.
 */
export function KeyHint({ children }: { children: React.ReactNode }) {
  return <Kbd size="xs" style={{ verticalAlign: "text-top" }}>{children}</Kbd>
}
