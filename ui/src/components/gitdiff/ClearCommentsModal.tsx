import { Button, Group, Modal, Stack, Text } from "@mantine/core"
import { useReviewCommentMutations } from "../../hooks/useReviewComments"

/** Confirms deleting every review comment on the worktree. */
export function ClearCommentsModal({ opened, onClose, path, count }: {
  opened: boolean
  onClose: () => void
  path: string
  count: number
}) {
  const { clear } = useReviewCommentMutations(path)
  // A failed attempt's error doesn't greet the next opening.
  const close = () => {
    clear.reset()
    onClose()
  }
  return (
    <Modal opened={opened} onClose={close} title="Clear comments" centered>
      <Stack gap="sm">
        <Text size="sm">{`Delete all ${count} review comments? This can't be undone.`}</Text>
        {clear.isError && (
          <Text size="sm" c="red">{clear.error instanceof Error ? clear.error.message : String(clear.error)}</Text>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={close}>Cancel</Button>
          <Button
            color="red"
            loading={clear.isPending}
            onClick={() => clear.mutate(undefined, { onSuccess: close })}
            // Focus lands here on open, not on the close button.
            data-autofocus
          >
            Clear comments
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
