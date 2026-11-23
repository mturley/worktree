import { Toggle } from "./Toggle"

export function ArchivedToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Toggle
      checked={value}
      onChange={(e) => onChange(e.currentTarget.checked)}
      label="Include archived"
      tooltip="Include archived: activity, and in the search dropdown resources and tasks, from resources that are no longer being followed by a worktree"
    />
  )
}
