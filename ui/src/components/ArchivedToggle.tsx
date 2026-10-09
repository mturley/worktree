import { Toggle } from "./Toggle"

export function ArchivedToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Toggle
      checked={value}
      onChange={(e) => onChange(e.currentTarget.checked)}
      label="Show archived"
      tooltip="Include activity from resources that are no longer being followed by a worktree"
    />
  )
}
