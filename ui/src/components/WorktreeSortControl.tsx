import { ActionIcon, Group, NativeSelect, Tooltip } from "@mantine/core"
import { IconSortAscending, IconSortDescending } from "@tabler/icons-react"
import { SORT_MODES, isSortMode, type SortDir, type SortMode } from "../lib/worktreeSort"

const LABELS: Record<SortMode, string> = {
  cmux: "cmux order",
  activity: "Latest activity",
  created: "Created",
  name: "Name",
  unread: "Unread first",
}

export interface WorktreeSortControlProps {
  /** null while the default is undecided; nothing renders until then. */
  mode: SortMode | null
  createdDir: SortDir
  cmuxAvailable: boolean
  onModeChange: (mode: SortMode) => void
  onCreatedDirChange: (dir: SortDir) => void
}

/**
 * The home page's worktree sort picker. A native select on purpose: it gets
 * the platform picker on a phone, where this UI is also used.
 */
export function WorktreeSortControl({
  mode, createdDir, cmuxAvailable, onModeChange, onCreatedDirChange,
}: WorktreeSortControlProps) {
  // Undecided lasts one cmux round-trip. Rendering nothing beats a select
  // whose value is a lie, and keeps it a controlled input from first render.
  if (mode === null) return null
  const modes = SORT_MODES.filter((m) => m !== "cmux" || cmuxAvailable)
  const dirLabel = createdDir === "asc" ? "Oldest first" : "Newest first"
  return (
    <Group gap={4} wrap="nowrap">
      <NativeSelect
        size="xs"
        aria-label="Sort worktrees"
        value={mode}
        data={modes.map((m) => ({ value: m, label: LABELS[m] }))}
        onChange={(e) => {
          const v = e.currentTarget.value
          if (isSortMode(v)) onModeChange(v)
        }}
      />
      {mode === "created" && (
        <Tooltip label={dirLabel}>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label="Toggle sort direction"
            onClick={() => onCreatedDirChange(createdDir === "asc" ? "desc" : "asc")}
          >
            {createdDir === "asc" ? <IconSortAscending size={16} /> : <IconSortDescending size={16} />}
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  )
}
