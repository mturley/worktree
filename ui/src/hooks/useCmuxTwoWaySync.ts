import { sessionFlag } from "../lib/sessionFlag"

/**
 * "Two-way sync" with cmux, per browser tab: while following, the tab's own
 * navigation to a worktree also switches cmux to that worktree's workspace
 * (see CmuxFollower).
 *
 * Per tab for the same reason as following (useFollowCmux), and kept apart
 * from it: turning following off and on again keeps this choice.
 */
export const CMUX_TWO_WAY_SYNC_KEY = "worktree.cmuxTwoWaySync"

const flag = sessionFlag(CMUX_TWO_WAY_SYNC_KEY)

export const setCmuxTwoWaySync = flag.set
export const isCmuxTwoWaySync = flag.read

export function useCmuxTwoWaySync(): [boolean, (value: boolean) => void] {
  return flag.use()
}
