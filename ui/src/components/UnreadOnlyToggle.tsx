import { Toggle } from "./Toggle"
import { KeyHint } from "./search/KeyHint"

/** The unread blue, as UnreadMarkerDot paints it. */
const UNREAD_BLUE = "var(--mantine-color-blue-5)"

/**
 * Narrows the page to what has unread activity: worktrees on the home page,
 * resources on a worktree page, and the unified activity feed on both.
 *
 * The value is UI-wide (useUnreadOnly); this is only the switch. `hasUnread`
 * is the page's own context — any worktree on the home page, this worktree
 * on its page — and turns the thumb unread blue, so the switch says whether
 * turning it on would leave anything to see. The U before the label is
 * useUnreadOnlyHotkey, which the page mounts.
 */
export function UnreadOnlyToggle({ value, onChange, hasUnread }: {
  value: boolean
  onChange: (v: boolean) => void
  hasUnread: boolean
}) {
  return (
    <Toggle
      checked={value}
      onChange={(e) => onChange(e.currentTarget.checked)}
      label={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {/* Hidden from the accessible name, which stays "Unreads only". */}
          <span aria-hidden="true" style={{ display: "inline-flex" }}><KeyHint>U</KeyHint></span>
          <span>Unreads only</span>
        </span>
      }
      tooltip="Show only worktrees, resources and events with unread activity"
      thumbColor={hasUnread ? UNREAD_BLUE : undefined}
    />
  )
}
