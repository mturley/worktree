import { ActionIcon, Group, NativeSelect, Text, Tooltip } from "@mantine/core"
import { IconSortAscending, IconSortDescending } from "@tabler/icons-react"
import { SORT_MODES, hasDirection, isSortMode, type SortDir, type SortMode } from "../lib/worktreeSort"

/** How each direction reads for the modes that have one. */
const DIR_LABELS: Record<"created" | "name", Record<SortDir, string>> = {
  created: { asc: "Oldest first", desc: "Newest first" },
  name: { asc: "A → Z", desc: "Z → A" },
}

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
  /** The current mode's direction; ignored for modes without one. */
  direction: SortDir
  cmuxAvailable: boolean
  onModeChange: (mode: SortMode) => void
  onDirectionChange: (dir: SortDir) => void
}

/**
 * The home page's worktree sort picker. A native select on purpose: it gets
 * the platform picker on a phone, where this UI is also used.
 */
export function WorktreeSortControl({
  mode, direction, cmuxAvailable, onModeChange, onDirectionChange,
}: WorktreeSortControlProps) {
  // Undecided lasts one cmux round-trip. Rendering nothing beats a select
  // whose value is a lie, and keeps it a controlled input from first render.
  if (mode === null) return null
  const modes = SORT_MODES.filter((m) => m !== "cmux" || cmuxAvailable)
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="xs" c="dimmed">Sort by:</Text>
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
      {hasDirection(mode) && (
        <Tooltip label={DIR_LABELS[mode][direction]}>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label="Toggle sort direction"
            onClick={() => onDirectionChange(direction === "asc" ? "desc" : "asc")}
          >
            {direction === "asc" ? <IconSortAscending size={16} /> : <IconSortDescending size={16} />}
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  )
}
