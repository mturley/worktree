import { Switch } from "@mantine/core"

/**
 * Narrows a unified activity feed to unread events.
 *
 * Only for feeds that interleave resources. A single resource's feed has no
 * use for it: one cursor means its unread events are always together at the
 * top, already split off by the unread divider.
 */
export function UnreadOnlyToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch checked={value} onChange={(e) => onChange(e.currentTarget.checked)} label="Show unread only" size="sm" />
  )
}
