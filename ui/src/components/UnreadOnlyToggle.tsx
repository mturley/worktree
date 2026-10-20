import { Group } from "@mantine/core"
import { Toggle } from "./Toggle"
import { UnreadMarkerDot } from "./UnreadMarkerDot"
import { KeyHint } from "./search/KeyHint"

/**
 * Narrows the page to what has unread activity: worktrees on the home page,
 * resources on a worktree page, and the unified activity feed on both.
 *
 * The value is UI-wide (useUnreadOnly); this is only the switch. `hasUnread`
 * is the page's own context — any worktree on the home page, this worktree
 * on its page — and puts the unread dot beside the label, so the switch says
 * whether turning it on would leave anything to see. The U beside it is
 * useUnreadOnlyHotkey, which the page mounts.
 */
export function UnreadOnlyToggle({ value, onChange, hasUnread }: {
  value: boolean
  onChange: (v: boolean) => void
  hasUnread: boolean
}) {
  return (
    <Group gap={6} wrap="nowrap" style={{ flex: "none" }}>
      <Toggle
        checked={value}
        onChange={(e) => onChange(e.currentTarget.checked)}
        label={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            Unreads only
            {hasUnread && <UnreadMarkerDot label="has unreads" />}
          </span>
        }
        tooltip="Show only worktrees, resources and events with unread activity"
      />
      <KeyHint>U</KeyHint>
    </Group>
  )
}
