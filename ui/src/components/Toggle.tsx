import { forwardRef } from "react"
import { Switch, rem, type SwitchProps } from "@mantine/core"

/**
 * Every on/off switch in the UI ("Show unreads only", "Show archived",
 * "Notify", "Follow cmux focus"), so their look is set in one place. Smaller
 * than Mantine's default: these sit in toolbars beside compact buttons, where
 * a full-size switch and label outweigh the controls around them.
 *
 * The label sits closer than Mantine's spacing-sm gap, which reads as loose
 * beside an xs switch. Set through the variable rather than the label's
 * padding so a description under the label stays aligned with it.
 *
 * forwardRef so a Tooltip can wrap it directly.
 */
const tight = { root: { "--label-offset-start": rem(6) } }

export const Toggle = forwardRef<HTMLInputElement, Omit<SwitchProps, "size" | "styles">>(function Toggle(props, ref) {
  return <Switch ref={ref} size="xs" styles={tight} {...props} />
})
