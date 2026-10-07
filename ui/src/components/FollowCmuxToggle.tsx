import { useCmux } from "../api/cmux"
import { api } from "../api/client"
import { emitCmuxFocus } from "../lib/cmuxFocusBus"
import { useFollowCmux } from "../hooks/useFollowCmux"
import { Toggle } from "./Toggle"

/**
 * Makes this tab follow cmux: switching workspaces there opens the matching
 * worktree here (CmuxFollower does the following). Turning it on also opens
 * the worktree of the workspace cmux has selected now. Hidden when the server is
 * not running inside cmux, since there would be nothing to follow.
 */
export function FollowCmuxToggle() {
  const cmux = useCmux()
  const [follow, setFollow] = useFollowCmux()
  if (!cmux.data?.available) return null
  return (
    <Toggle
      checked={follow}
      onChange={(e) => {
        const on = e.currentTarget.checked
        setFollow(on)
        // Go where cmux already is, rather than waiting for the next switch.
        // Handed to CmuxFollower as an ordinary focus change, so the same
        // rules apply: no-op when already there, ask over unsaved edits.
        if (on) void api.cmuxFocused().then(emitCmuxFocus, () => {})
      }}
      label="Follow cmux focus"
      style={{ flex: "none" }}
    />
  )
}
