import { useMemo, useState } from "react"
import { ActionIcon, Alert, Button, Center, Divider, Group, Loader, NativeSelect, Stack, Text, Tooltip } from "@mantine/core"
import { IconSortAscending, IconSortDescending, IconUser, IconWorld } from "@tabler/icons-react"
import type { AllResourceDTO } from "../api/types"
import { useAllResources } from "../hooks/useAllResources"
import {
  EMPTY_FILTER, MINE_TYPE, PR_CONDITIONS, PR_STATES, distinctValues, hasResourceSortDirection, isResourceSortMode,
  matchesFilter, sortResources, type ResourceFilter, type ResourceSortMode, type SortDir,
} from "../lib/resourceListFilter"
import { AllResourceRow } from "./AllResourceRow"
import { GitHubMark } from "./icons/GitHubMark"
import { JiraMark } from "./icons/JiraMark"
import { SlackMark } from "./icons/SlackMark"

const SORT_LABELS: Record<ResourceSortMode, string> = {
  updated: "Last updated",
  created: "Created",
  status: "Status",
  unread: "Unread first",
  name: "Name",
}

const DIR_LABELS: Record<"updated" | "created" | "name", Record<SortDir, string>> = {
  updated: { asc: "Least recent first", desc: "Most recent first" },
  created: { asc: "Oldest first", desc: "Newest first" },
  name: { asc: "A → Z", desc: "Z → A" },
}

/** Each mode's natural first direction, used when switching to it. */
const DEFAULT_DIR: Record<ResourceSortMode, SortDir> = {
  updated: "desc", created: "desc", status: "asc", unread: "asc", name: "asc",
}

const TYPES: { type: string; label: string; icon: React.ReactNode }[] = [
  // Not a type: PRs and Jira issues that are the user's own, together.
  { type: MINE_TYPE, label: "My Stuff", icon: <IconUser size={14} /> },
  { type: "pr", label: "GitHub", icon: <GitHubMark size={14} /> },
  { type: "jira", label: "Jira", icon: <JiraMark size={14} /> },
  { type: "slack", label: "Slack", icon: <SlackMark size={14} /> },
  { type: "link", label: "Links", icon: <IconWorld size={14} /> },
]

/** A compact on/off button, styled as the Activity source toggles are. */
function Toggle({ active, onClick, children, icon }: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  icon?: React.ReactNode
}) {
  return (
    <Button
      size="compact-xs"
      variant={active ? "light" : "subtle"}
      color={active ? undefined : "gray"}
      aria-pressed={active}
      leftSection={icon}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

function toggled(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

/** The selected type's own filters, from its states and the data present. */
function SubFilters({ all, filter, onChange }: {
  all: AllResourceDTO[]
  filter: ResourceFilter
  onChange: (f: ResourceFilter) => void
}) {
  const sep = <Divider orientation="vertical" />
  if (filter.type === "pr") {
    return (
      <Group gap={4} wrap="wrap" data-testid="resource-subfilters">
        {PR_STATES.map((s) => (
          <Toggle key={s.value} active={filter.prStates.includes(s.value)}
            onClick={() => onChange({ ...filter, prStates: toggled(filter.prStates, s.value) })}>{s.label}</Toggle>
        ))}
        {sep}
        {PR_CONDITIONS.map((c) => (
          <Toggle key={c.value} active={filter.prConditions.includes(c.value)}
            onClick={() => onChange({ ...filter, prConditions: toggled(filter.prConditions, c.value) })}>{c.label}</Toggle>
        ))}
        {sep}
        <Toggle active={filter.mine} onClick={() => onChange({ ...filter, mine: !filter.mine })}>My PRs</Toggle>
      </Group>
    )
  }
  if (filter.type === "jira") {
    const statuses = distinctValues(all, "jira", (r) => r.status)
    return (
      <Group gap={4} wrap="wrap" data-testid="resource-subfilters">
        {statuses.map((s) => (
          <Toggle key={s} active={filter.jiraStatuses.includes(s)}
            onClick={() => onChange({ ...filter, jiraStatuses: toggled(filter.jiraStatuses, s) })}>{s}</Toggle>
        ))}
        {statuses.length > 0 && sep}
        {/* Assigned to or reported by the user. */}
        <Toggle active={filter.mine} onClick={() => onChange({ ...filter, mine: !filter.mine })}>My issues</Toggle>
      </Group>
    )
  }
  if (filter.type === "slack") {
    const channels = distinctValues(all, "slack", (r) => r.channel_name)
    if (channels.length === 0) return null
    return (
      <Group gap={4} wrap="wrap" data-testid="resource-subfilters">
        {channels.map((c) => (
          <Toggle key={c} active={filter.slackChannels.includes(c)}
            onClick={() => onChange({ ...filter, slackChannels: toggled(filter.slackChannels, c) })}>#{c}</Toggle>
        ))}
      </Group>
    )
  }
  return null
}

/**
 * The home page's Resources tab: every resource any worktree follows, once
 * each, sortable and filterable. The type toggles are all-or-one like the
 * Activity source toggles; picking one opens that type's own filters, and
 * switching type clears them. The global unread-only toggle narrows it too.
 *
 * `toolbarEnd` is rendered at the end of the sort row (the page puts the
 * unread-only toggle there when narrow).
 */
export function ResourcesPanel({ unreadOnly, headerStyle, toolbarEnd, top }: {
  unreadOnly: boolean
  /** Rendered first inside the (pinned) header: the page's tab bar, when wide. */
  top?: React.ReactNode
  /** Pins the controls at the top of a scrolling column; see pinnedStyle. */
  headerStyle?: React.CSSProperties
  toolbarEnd?: React.ReactNode
}) {
  const q = useAllResources()
  const [mode, setMode] = useState<ResourceSortMode>("updated")
  const [dir, setDir] = useState<SortDir>("desc")
  const [filter, setFilter] = useState<ResourceFilter>(EMPTY_FILTER)

  const all = useMemo(() => q.data ?? [], [q.data])
  const shown = useMemo(
    () => sortResources(all.filter((r) => matchesFilter(r, filter, unreadOnly)), mode, dir),
    [all, filter, unreadOnly, mode, dir],
  )
  const presentTypes = useMemo(() => new Set(all.map((r) => r.type)), [all])
  const filtered = filter.type !== null || unreadOnly

  const controls = (
    <Stack
      gap="xs"
      style={headerStyle && { ...headerStyle, paddingBottom: "var(--mantine-spacing-xs)" }}
      data-tooltip-layer={headerStyle ? "pinned" : undefined}
      data-testid="resources-header"
    >
      {top}
      <Group justify="space-between" gap="xs" wrap="wrap">
        <Group gap={6} wrap="nowrap">
          <NativeSelect
            size="xs"
            aria-label="Sort resources"
            value={mode}
            data={(Object.keys(SORT_LABELS) as ResourceSortMode[]).map((m) => ({ value: m, label: SORT_LABELS[m] }))}
            onChange={(e) => {
              const v = e.currentTarget.value
              if (!isResourceSortMode(v)) return
              setMode(v)
              setDir(DEFAULT_DIR[v])
            }}
          />
          {hasResourceSortDirection(mode) && (
            <Tooltip label={DIR_LABELS[mode as "updated" | "created" | "name"][dir]}>
              <ActionIcon variant="subtle" size="sm" aria-label="Toggle sort direction"
                onClick={() => setDir(dir === "asc" ? "desc" : "asc")}>
                {dir === "asc" ? <IconSortAscending size={16} /> : <IconSortDescending size={16} />}
              </ActionIcon>
            </Tooltip>
          )}
          {q.data && (
            <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {filtered ? `${shown.length} of ${all.length}` : `${all.length}`} {all.length === 1 ? "resource" : "resources"}
            </Text>
          )}
        </Group>
        {toolbarEnd}
      </Group>
      <Group gap={4} wrap="wrap">
        {TYPES.filter((t) => t.type !== "link" || presentTypes.has("link")).map((t) => (
          <Toggle
            key={t.type}
            icon={t.icon}
            active={filter.type === t.type}
            // All-or-one; switching type drops the old type's subfilters.
            onClick={() => setFilter(filter.type === t.type ? EMPTY_FILTER : { ...EMPTY_FILTER, type: t.type })}
          >
            {t.label}
          </Toggle>
        ))}
      </Group>
      <SubFilters all={all} filter={filter} onChange={setFilter} />
    </Stack>
  )

  let body: React.ReactNode
  if (q.error && !q.data) {
    body = (
      <Alert color="red" variant="light" title="Couldn't load resources">
        <Group gap="sm">
          <Text size="sm">{q.error.message}</Text>
          <Button size="compact-sm" variant="light" onClick={() => void q.refetch()}>Retry</Button>
        </Group>
      </Alert>
    )
  } else if (!q.data) {
    body = <Center py="md"><Loader size="sm" /></Center>
  } else if (shown.length === 0) {
    body = (
      <Text size="sm" c="dimmed" ta="center" py="md">
        {all.length === 0 ? "No worktree follows any resources yet." : unreadOnly ? "No unread resources match." : "No resources match these filters."}
      </Text>
    )
  } else {
    body = (
      <Stack gap={2}>
        {shown.map((r) => <AllResourceRow key={`${r.type}:${r.id}`} r={r} />)}
      </Stack>
    )
  }

  return (
    <Stack gap={headerStyle ? 0 : "sm"}>
      {controls}
      {body}
    </Stack>
  )
}
