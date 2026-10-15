import { Button, Tooltip } from "@mantine/core"
import { IconCode } from "@tabler/icons-react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
import { settingsKey } from "./SettingsModal"

/**
 * The worktree detail page header's "Open in editor (code)" button: runs
 * the configured editor command on the worktree, on the server's machine.
 * Disabled until an editor is set in Settings → General, since the server
 * has no terminal for $EDITOR.
 *
 * Shares the Settings modal's query, so saving an editor there enables the
 * button at once.
 */
export function OpenInEditorButton({ path }: { path: string }) {
  const settings = useQuery({ queryKey: settingsKey, queryFn: api.settings })
  const open = useMutation({ mutationFn: () => api.openInEditor(path) })
  const editor = settings.data?.worktree.editor.trim() ?? ""

  const button = (
    <Button
      size="compact-sm"
      variant="subtle"
      color={open.isError ? "red" : undefined}
      style={{ flex: "none" }}
      leftSection={<IconCode size={14} />}
      disabled={!editor}
      loading={open.isPending}
      onClick={() => open.mutate()}
      // A failed open shows its error until the pointer leaves.
      onMouseLeave={() => open.isError && open.reset()}
    >
      {editor ? `Open in editor (${editor})` : "Open in editor"}
    </Button>
  )

  if (!editor) {
    // A disabled button fires no pointer events, so the tooltip needs a
    // wrapper to hover. Nothing to say until settings have loaded.
    return (
      <Tooltip
        label="Configure an editor in Settings → General to open worktrees from here"
        disabled={!settings.data}
      >
        <span style={{ display: "inline-block", flex: "none" }}>{button}</span>
      </Tooltip>
    )
  }
  return (
    <Tooltip
      label={open.isError ? `Couldn't open: ${open.error.message}` : `Runs ${editor} with this worktree's path. You can change the editor in settings.`}
      color={open.isError ? "red" : undefined}
      opened={open.isError ? true : undefined}
      multiline
      maw={360}
    >
      {button}
    </Tooltip>
  )
}
