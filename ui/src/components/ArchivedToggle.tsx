import { Switch, Tooltip } from "@mantine/core"

export function ArchivedToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Tooltip label="Show past events for resources no longer being watched by a worktree" multiline w={260}>
      <Switch checked={value} onChange={(e) => onChange(e.currentTarget.checked)} label="Show archived" size="sm" />
    </Tooltip>
  )
}
