import { useRef, useState, type MouseEvent } from "react"
import { Box, Button, Checkbox, Divider, Popover, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core"
import { IconChevronDown, IconGitCommit, IconPencil } from "@tabler/icons-react"
import type { Commit, DiffRange } from "../../api/types"
import { rangeLabel } from "../../lib/diffLabels"
import { relativeTime } from "../../lib/relativeTime"
import { LabeledControl, type LabelPosition } from "./LabeledControl"

const UNCOMMITTED = "uncommitted"
const MIDDLE_TIP = "Commits between the ends stay selected — trim from either end."

// The picker's entries are list positions, newest first: 0 is Uncommitted,
// 1..n the commits. A selection is one contiguous run [lo, hi] of them, so lo
// is the newest selected entry and hi the oldest.
type Run = [lo: number, hi: number]

function toRun(entries: string[], range: DiffRange): Run {
  const all: Run = [0, entries.length - 1]
  if (range === "all") return all
  const lo = entries.indexOf(range.to)
  const hi = entries.indexOf(range.from)
  // A range naming something no longer listed reads as everything (the
  // selection hook resets it when the list changes).
  return lo < 0 || hi < 0 || lo > hi ? all : [lo, hi]
}

function toRange(entries: string[], [lo, hi]: Run): DiffRange {
  if (lo === 0 && hi === entries.length - 1) return "all"
  return { from: entries[hi], to: entries[lo] }
}

/**
 * The "Changes from:" commit range picker, after GitHub's PR "Changes from
 * all commits" menu: quick options, then Uncommitted and the commits newest
 * first. Click picks one entry, shift-click the run from the last clicked
 * entry, and checkboxes extend the run or trim it from either end.
 */
export function RangePicker({
  commits,
  uncommittedCount,
  range,
  onChange,
  labelPosition,
  fullWidth,
  disabled,
}: {
  commits: Commit[]
  uncommittedCount: number
  range: DiffRange
  onChange: (range: DiffRange) => void
  labelPosition: LabelPosition
  fullWidth?: boolean
  disabled?: boolean
}) {
  const [opened, setOpened] = useState(false)
  // Shift-click's anchor: the last plain-clicked entry, by SHA so it survives
  // the list growing.
  const anchor = useRef<string | null>(null)

  const entries = [UNCOMMITTED, ...commits.map((c) => c.sha)]
  const [lo, hi] = toRun(entries, range)
  const apply = (run: Run) => onChange(toRange(entries, run))

  const click = (i: number, e: MouseEvent) => {
    const a = anchor.current === null ? -1 : entries.indexOf(anchor.current)
    if (e.shiftKey && a >= 0) {
      apply([Math.min(a, i), Math.max(a, i)])
      return
    }
    anchor.current = entries[i]
    apply([i, i])
  }

  const toggle = (i: number) => {
    if (i < lo || i > hi) apply([Math.min(lo, i), Math.max(hi, i)])
    else if (i === lo) apply([lo + 1, hi])
    else if (i === hi) apply([lo, hi - 1])
  }

  const quick = (r: DiffRange) => {
    onChange(r)
    setOpened(false)
  }

  const rows = entries.map((sha, i) => {
    const selected = i >= lo && i <= hi
    const middle = selected && i > lo && i < hi
    // The run never empties: its only entry can't be unchecked.
    const sole = selected && lo === hi
    const commit = i === 0 ? undefined : commits[i - 1]
    const name = commit ? commit.subject : "Uncommitted changes"

    const checkbox = (
      <Checkbox
        size="xs"
        checked={selected}
        disabled={middle || sole}
        onChange={() => toggle(i)}
        aria-label={`Include ${name}`}
      />
    )
    return (
      <Box
        key={sha}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          paddingInline: 8,
          borderRadius: 4,
          background: selected ? "var(--mantine-color-default-hover)" : undefined,
        }}
      >
        {middle ? (
          <Tooltip label={MIDDLE_TIP} multiline maw={260} withinPortal>
            {/* A disabled input fires no pointer events; hover the wrapper. */}
            <span data-middle style={{ display: "inline-flex", flexShrink: 0 }}>{checkbox}</span>
          </Tooltip>
        ) : (
          <span style={{ display: "inline-flex", flexShrink: 0 }}>{checkbox}</span>
        )}
        <UnstyledButton
          onClick={(e) => click(i, e)}
          style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, paddingBlock: 6 }}
        >
          {commit ? (
            <IconGitCommit size={14} style={{ flexShrink: 0 }} />
          ) : (
            <IconPencil size={14} style={{ flexShrink: 0 }} />
          )}
          <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>
            {name}
          </Text>
          {commit ? (
            <>
              <Text size="xs" c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
                {commit.short}
              </Text>
              <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                {relativeTime(commit.date)}
              </Text>
            </>
          ) : (
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              {uncommittedCount === 1 ? "1 file" : `${uncommittedCount} files`}
            </Text>
          )}
        </UnstyledButton>
      </Box>
    )
  })

  const oldest = commits[commits.length - 1]
  const newest = commits[0]
  const quickOption = (label: string, r: DiffRange | null) => (
    <UnstyledButton
      disabled={r === null}
      onClick={() => r && quick(r)}
      style={{ paddingBlock: 4, paddingInline: 8, borderRadius: 4, opacity: r === null ? 0.5 : undefined }}
    >
      <Text size="sm">{label}</Text>
    </UnstyledButton>
  )

  return (
    <LabeledControl label="Changes from:" labelPosition={labelPosition} fullWidth={fullWidth}>
      <Popover opened={opened} onChange={setOpened} position="bottom-start" shadow="md" width={440} trapFocus={false}>
        <Popover.Target>
          <Button
            data-testid="range-picker-trigger"
            size="xs"
            variant="default"
            disabled={disabled}
            fullWidth={fullWidth || labelPosition === "top"}
            rightSection={<IconChevronDown size={14} />}
            onClick={() => setOpened((o) => !o)}
            styles={{ inner: { justifyContent: "space-between" } }}
          >
            {rangeLabel(commits, range)}
          </Button>
        </Popover.Target>
        <Popover.Dropdown p={4} maw="calc(100vw - 32px)">
          <Stack gap={0}>
            {quickOption("All changes", "all")}
            {quickOption("All commits", oldest && newest ? { from: oldest.sha, to: newest.sha } : null)}
            {quickOption("Uncommitted changes", { from: UNCOMMITTED, to: UNCOMMITTED })}
          </Stack>
          <Divider my={4} />
          <Text size="xs" c="dimmed" px={8} pb={4}>
            Click to pick one · Shift-click to pick a run · Check or uncheck to extend or trim it
          </Text>
          {/* A plain scroller: Mantine ScrollArea let rows grow wider than the popover. */}
          <Box style={{ maxHeight: 320, overflowY: "auto", overflowX: "hidden" }}>{rows}</Box>
        </Popover.Dropdown>
      </Popover>
    </LabeledControl>
  )
}
