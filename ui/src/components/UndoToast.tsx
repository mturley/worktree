import { useState } from "react"
import { Button, Group, Text } from "@mantine/core"
import { notifications } from "@mantine/notifications"
import { useButtonHotkey } from "../hooks/useButtonHotkey"
import { KeyHint } from "./search/KeyHint"

/**
 * How long an undo stays on offer. The server holds an "Unblocked"
 * notification for the same window (`unblockHoldDefault` in
 * internal/webui/notify_unblock.go): change both together.
 */
export const UNDO_WINDOW_MS = 10_000

let nextID = 0

/**
 * Several undos as one, for a toast that took back more than one mark. Every
 * undo runs to the end even when another is refused (a 409 on one cursor
 * must not leave the others marked), and it settles only once all have, so
 * the caller's refetch sees them all. Fails with every failure, joined, so
 * a toast reports each one — named by its `label` ("T12: …; #4521: …")
 * whenever the undo covered more than one item, so it is clear which stayed
 * read. A lone item's failure reads as just its message.
 */
export async function undoAll(undos: { label: string; undo: () => Promise<unknown> }[]): Promise<void> {
  const results = await Promise.allSettled(undos.map((u) => u.undo()))
  const messages = results.flatMap((r, i) => {
    if (r.status !== "rejected") return []
    const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
    return [undos.length > 1 ? `${undos[i].label}: ${msg}` : msg]
  })
  if (messages.length > 0) throw new Error(messages.join("; "))
}

/**
 * Offers to take back a mark-read for UNDO_WINDOW_MS: a toast reading
 * `message`, with an Undo button (and Z) that runs `undo`.
 *
 * `undo` puts the read cursors back where they were; the server refuses with
 * 409 when one has moved on since (read further in another tab, the CLI, or
 * Slack itself), and that is reported rather than retried — rewinding past a
 * later read would resurrect messages the user has since seen. `onSettled`
 * runs after the undo either way, for the caller to refetch what it shows.
 *
 * Each mark gets its own toast; an earlier one keeps its own undo, so marking
 * two things in quick succession can undo either.
 */
export function showUndoToast({ message, undo, onSettled }: {
  message: string
  undo: () => Promise<unknown>
  onSettled?: () => void
}) {
  const id = `undo-${++nextID}`
  notifications.show({
    id,
    message: <UndoToastBody id={id} message={message} undo={undo} onSettled={onSettled} />,
    autoClose: UNDO_WINDOW_MS,
    withCloseButton: true,
  })
}

function UndoToastBody({ id, message, undo, onSettled }: {
  id: string
  message: string
  undo: () => Promise<unknown>
  onSettled?: () => void
}) {
  const [pending, setPending] = useState(false)

  const run = async () => {
    setPending(true)
    try {
      await undo()
    } catch (err) {
      // A toast of its own, not an update of this one: the undo may finish
      // after this toast has auto-closed, and the failure must still show.
      notifications.show({
        color: "red",
        autoClose: UNDO_WINDOW_MS,
        message: `Couldn't undo: ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      notifications.hide(id)
      onSettled?.()
    }
  }

  const ref = useButtonHotkey("z", () => void run(), !pending)

  return (
    <Group justify="space-between" wrap="nowrap" gap="sm">
      <Text size="sm">{message}</Text>
      <Button
        size="compact-sm"
        variant="light"
        loading={pending}
        onClick={() => void run()}
        ref={ref}
        rightSection={<KeyHint decorative>Z</KeyHint>}
      >
        Undo
      </Button>
    </Group>
  )
}
