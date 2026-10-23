import { Anchor, Box, Text } from "@mantine/core"
import type { FileChange } from "../../api/types"
import { OpenFileInEditorIcon } from "./OpenFileInEditorIcon"

// Rendering thousands of rows here buys nothing: past this the diff view's
// tree and filter are the better way through.
const MAX_ROWS = 200

const STATUS_COLOR: Record<string, string> = { A: "green", M: "yellow", D: "red", R: "violet" }

/**
 * The Code tab's file list: status glyph · path · open-in-editor · +x −y,
 * sorted by path. A path drills into the diff view at that file. (The diff
 * view's file headers put the editor icon before the name instead.)
 */
export function FilesChangedList({
  path,
  files,
  onOpenFile,
  onViewDiff,
}: {
  path: string
  files: FileChange[]
  onOpenFile: (file: string) => void
  onViewDiff: () => void
}) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const shown = sorted.slice(0, MAX_ROWS)
  const more = sorted.length - shown.length

  return (
    // Capped so on a wide page the counts stay within reach of the names.
    <Box style={{ maxWidth: 900 }}>
      {shown.map((f) => (
        <Box key={f.path} data-testid="file-row" style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 26 }}>
          <Text
            size="xs"
            ff="monospace"
            fw={700}
            c={STATUS_COLOR[f.status]}
            style={{ width: 12, flexShrink: 0, textAlign: "center" }}
          >
            {f.status}
          </Text>
          {/* Sized to the name (shrinking to an ellipsis when it must), so
              the editor icon sits right after it rather than at the far edge. */}
          <Box style={{ flex: "0 1 auto", minWidth: 0 }}>
            <Anchor
              component="button"
              type="button"
              size="xs"
              ff="monospace"
              onClick={() => onOpenFile(f.path)}
              style={{ display: "block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {f.old_path ? `${f.old_path} → ${f.path}` : f.path}
            </Anchor>
          </Box>
          <Box style={{ flexShrink: 0, display: "inline-flex" }}>
            <OpenFileInEditorIcon path={path} file={f.path} disabled={f.status === "D"} />
          </Box>
          <Text size="xs" ff="monospace" style={{ flexShrink: 0, whiteSpace: "nowrap", marginLeft: "auto" }}>
            {f.binary ? (
              <Text span inherit c="dimmed">binary</Text>
            ) : (
              <>
                <Text span inherit c="green">{`+${f.additions}`}</Text>{" "}
                <Text span inherit c="red">{`−${f.deletions}`}</Text>
              </>
            )}
          </Text>
        </Box>
      ))}
      {more > 0 && (
        <Text size="xs" c="dimmed" mt={4}>
          {`and ${more} more — `}
          <Anchor component="button" type="button" size="xs" onClick={onViewDiff}>
            View diff
          </Anchor>
        </Text>
      )}
    </Box>
  )
}
