import { forwardRef } from "react"
import { Switch, type SwitchProps } from "@mantine/core"

/**
 * Every on/off switch in the UI ("Show unreads only", "Show archived",
 * "Notify", "Follow cmux focus"), so their look is set in one place. Smaller
 * than Mantine's default: these sit in toolbars beside compact buttons, where
 * a full-size switch and label outweigh the controls around them.
 *
 * forwardRef so a Tooltip can wrap it directly.
 */
export const Toggle = forwardRef<HTMLInputElement, Omit<SwitchProps, "size">>(function Toggle(props, ref) {
  return <Switch ref={ref} size="xs" {...props} />
})
