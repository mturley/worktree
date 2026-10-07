import { useCmux } from "../api/cmux"
import { useFollowCmux } from "../hooks/useFollowCmux"
import { Toggle } from "./Toggle"

/**
 * Makes this tab follow cmux: switching workspaces there opens the matching
 * worktree here (CmuxFollower does the following). Hidden when the server is
 * not running inside cmux, since there would be nothing to follow.
 */
export function FollowCmuxToggle() {
  const cmux = useCmux()
  const [follow, setFollow] = useFollowCmux()
  if (!cmux.data?.available) return null
  return (
    <Toggle
      checked={follow}
      onChange={(e) => setFollow(e.currentTarget.checked)}
      label="Follow cmux focus"
      style={{ flex: "none" }}
    />
  )
}
