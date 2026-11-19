import { sessionFlag } from "../lib/sessionFlag"

/**
 * "Follow cmux", per browser tab.
 *
 * sessionStorage, not localStorage: following is a role one tab plays (the
 * one beside the terminal), and every tab following at once would have them
 * all jump together. The value still survives a reload of that tab.
 */
export const FOLLOW_CMUX_KEY = "worktree.followCmuxFocus"

const flag = sessionFlag(FOLLOW_CMUX_KEY)

export const setFollowCmux = flag.set

/** Whether this tab follows cmux focus. Shared by the toggle on every page. */
export function useFollowCmux(): [boolean, (value: boolean) => void] {
  return flag.use()
}
