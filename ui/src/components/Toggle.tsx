import { forwardRef, type ReactNode } from "react"
import { Switch, Tooltip, rem, type SwitchProps } from "@mantine/core"

/**
 * Every on/off switch in the UI ("Unreads only", "Show archived",
 * "Notify", "Follow cmux"), so their look is set in one place. Smaller
 * than Mantine's default: these sit in toolbars beside compact buttons, where
 * a full-size switch and label outweigh the controls around them.
 *
 * The label sits closer than Mantine's spacing-sm gap, which reads as loose
 * beside an xs switch. Set through the variable rather than the label's
 * padding so a description under the label stays aligned with it.
 *
 * Pass `tooltip` rather than wrapping a Toggle in a Tooltip: Switch hands its
 * ref and any unknown props to the visually hidden <input>, so a Tooltip
 * around it listens for hovers on an element nobody can hover, and never
 * opens. `tooltip` puts it on a wrapper around the visible switch and label.
 *
 * `thumbColor` paints the thumb in both states, as a signal of its own
 * beside on/off (Unreads only's goes blue while there are unreads), leaving
 * the track to say which state it is in.
 */
const tight = { root: { "--label-offset-start": rem(6) } }

type ToggleProps = Omit<SwitchProps, "size" | "styles"> & { tooltip?: ReactNode; thumbColor?: string }

export const Toggle = forwardRef<HTMLInputElement, ToggleProps>(function Toggle({ tooltip, thumbColor, ...props }, ref) {
  const styles = {
    ...tight,
    // Centred on the label, which a key hint makes taller than one line.
    // Not with a description: the track belongs beside the label's first
    // line then, not halfway down the description.
    ...(!props.description && { body: { alignItems: "center" } }),
    ...(thumbColor && { thumb: { backgroundColor: thumbColor, borderColor: thumbColor } }),
  }
  const sw = <Switch ref={ref} size="xs" styles={styles} {...props} />
  if (!tooltip) return sw
  return (
    <Tooltip label={tooltip} multiline w={260}>
      <div style={{ display: "inline-block", flex: "none" }}>{sw}</div>
    </Tooltip>
  )
})
