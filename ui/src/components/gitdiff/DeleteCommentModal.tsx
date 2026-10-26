import { Button, Group, Modal, Stack, Text } from "@mantine/core"
import { useReviewCommentMutations } from "../../hooks/useReviewComments"

/** Confirms deleting one review comment. */
export function DeleteCommentModal({ opened, onClose, path, id, where }: {
  opened: boolean
  onClose: () => void
  path: string
  id: number
  /** The comment's place, e.g. `src/a.ts:3-5`. */
  where: string
}) {
  const { remove } = useReviewCommentMutations(path)
  // A failed attempt's error doesn't greet the next opening.
  const close = () => {
    remove.reset()
    onClose()
  }
  return (
    <Modal opened={opened} onClose={close} title="Delete comment" centered>
      <Stack gap="sm">
        <Text size="sm">{`Delete the comment on ${where}? This can't be undone.`}</Text>
        {remove.isError && (
          <Text size="sm" c="red">{remove.error instanceof Error ? remove.error.message : String(remove.error)}</Text>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={close}>Cancel</Button>
          <Button
            color="red"
            loading={remove.isPending}
            onClick={() => remove.mutate(id, { onSuccess: close })}
            // Focus lands here on open, not on the close button.
            data-autofocus
          >
            Delete
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
