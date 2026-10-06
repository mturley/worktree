import { Switch } from "@mantine/core"

/**
 * Narrows the page to what has unread activity: worktrees on the home page,
 * resources on a worktree page, and the unified activity feed on both.
 *
 * The value is UI-wide (useUnreadOnly); this is only the switch.
 */
export function UnreadOnlyToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch checked={value} onChange={(e) => onChange(e.currentTarget.checked)} label="Show unread only" size="sm" />
  )
}
