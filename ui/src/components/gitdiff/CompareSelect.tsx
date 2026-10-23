import { Box, Select, Tooltip } from "@mantine/core"
import type { DiffBase } from "../../api/types"
import { LabeledControl, type LabelPosition } from "./LabeledControl"

const NO_TRACKING_TIP = "This branch has no tracking branch (not pushed)"

/**
 * The "Compare with:" select: the merge base with the main upstream, or the
 * tracking branch, each naming its actual ref. Never "upstream" for the
 * tracking branch, since `upstream` is also a common remote name.
 */
export function CompareSelect({
  value,
  onChange,
  mainUpstream,
  tracking,
  labelPosition,
}: {
  value: DiffBase
  onChange: (base: DiffBase) => void
  mainUpstream?: string
  tracking?: string
  labelPosition: LabelPosition
}) {
  const data = [
    { value: "merge-base", label: `merge base (${mainUpstream ?? "unavailable"})` },
    { value: "tracking", label: `tracking branch (${tracking ?? "none"})`, disabled: !tracking },
  ]
  return (
    <LabeledControl label="Compare with:" labelPosition={labelPosition}>
      <Select
        size="xs"
        aria-label="Compare with"
        data={data}
        value={value}
        allowDeselect={false}
        checkIconPosition="right"
        // Not searchable, but Mantine's Select is still a (read-only) input
        // underneath, which shows a text caret once clicked into; it reads as
        // a menu button instead.
        styles={{ input: { cursor: "pointer", caretColor: "transparent" } }}
        comboboxProps={{ width: "max-content", position: "bottom-start" }}
        onChange={(v) => (v === "merge-base" || v === "tracking") && onChange(v)}
        renderOption={({ option }) =>
          option.disabled && option.value === "tracking" ? (
            <Tooltip label={NO_TRACKING_TIP} withinPortal>
              <Box style={{ width: "100%" }}>{option.label}</Box>
            </Tooltip>
          ) : (
            option.label
          )
        }
        w={labelPosition === "top" ? "100%" : 240}
      />
    </LabeledControl>
  )
}
