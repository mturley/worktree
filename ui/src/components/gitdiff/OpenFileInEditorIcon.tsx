import { ActionIcon, Tooltip } from "@mantine/core"
import { IconCode } from "@tabler/icons-react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { api } from "../../api/client"
import { settingsKey } from "../SettingsModal"

/**
 * Opens one changed file in the configured editor, in the worktree's window
 * (the server runs `<editor> <worktree> <worktree>/<file>`). Reads the editor
 * from the Settings modal's query like OpenInEditorButton, so saving one
 * there enables every icon at once. `disabled` is for a deleted file, which
 * has nothing on disk to open.
 */
export function OpenFileInEditorIcon({
  path,
  file,
  disabled: deleted,
}: {
  path: string
  file: string
  disabled?: boolean
}) {
  const settings = useQuery({ queryKey: settingsKey, queryFn: api.settings })
  const open = useMutation({ mutationFn: () => api.openInEditor(path, file) })
  const editor = settings.data?.worktree.editor.trim() ?? ""
  const disabled = !editor || !!deleted

  const icon = (
    <ActionIcon
      size="sm"
      variant="subtle"
      color={open.isError ? "red" : "gray"}
      aria-label={`Open ${file} in editor`}
      disabled={disabled}
      loading={open.isPending}
      onClick={() => open.mutate()}
      // A failed open shows its error until the pointer leaves.
      onMouseLeave={() => open.isError && open.reset()}
    >
      <IconCode size={14} />
    </ActionIcon>
  )

  if (disabled) {
    // A disabled button fires no pointer events, so the tooltip needs a
    // wrapper to hover. Nothing to say until settings have loaded.
    return (
      <Tooltip
        label={editor ? "Nothing on disk to open" : "Configure an editor in settings"}
        disabled={!settings.data}
      >
        <span style={{ display: "inline-flex" }}>{icon}</span>
      </Tooltip>
    )
  }
  return (
    <Tooltip
      label={open.isError ? `Couldn't open: ${open.error.message}` : `Open in ${editor} (configure editor in settings)`}
      color={open.isError ? "red" : undefined}
      opened={open.isError ? true : undefined}
      multiline
      maw={360}
    >
      {icon}
    </Tooltip>
  )
}
