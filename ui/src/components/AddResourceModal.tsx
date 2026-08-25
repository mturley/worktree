import { useState } from "react"
import {
  Alert,
  Button,
  Group,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core"
import { api } from "../api/client"

interface AddResourceModalProps {
  opened: boolean
  path: string
  onClose: () => void
  onAdded: () => void
  /** When true, the type control starts on "Related" instead of "Focus". */
  defaultRelated?: boolean
  /**
   * Seeds the URL field. Used when the URL is already known — adding a
   * thread from a Slack unfurl — so the user lands on the choices that
   * still need making (Focus/Related, name, description) rather than on a
   * field they would only paste back into.
   *
   * Read at mount: give the modal a `key` if one instance must serve
   * several URLs.
   */
  initialUrl?: string
}

/** A pasted URL is a Slack thread when it points at a slack.com workspace. */
function isSlackUrl(url: string): boolean {
  return url.toLowerCase().includes("slack.com")
}

const FOCUS_HELP: Record<string, string> = {
  focus: "Central to this worktree.",
  related: "Linked or secondary resource.",
}

/**
 * Modal for adding a resource (PR, Jira, or Slack thread) to a worktree. Lets
 * the user choose Focus vs Related up front (mapping to the backend's
 * primary/related distinction) and, for Slack thread URLs, optionally set a
 * custom name and description at add time.
 */
export function AddResourceModal({
  opened,
  path,
  onClose,
  onAdded,
  defaultRelated,
  initialUrl,
}: AddResourceModalProps) {
  const [url, setUrl] = useState(initialUrl ?? "")
  const [focus, setFocus] = useState(defaultRelated ? "related" : "focus")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const slack = isSlackUrl(url)

  const reset = () => {
    setUrl(initialUrl ?? "")
    setFocus(defaultRelated ? "related" : "focus")
    setName("")
    setDescription("")
    setError(null)
  }

  const handleClose = () => {
    reset()
    onClose()
  }

  const handleSubmit = async () => {
    const trimmed = url.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const added = await api.addResource({ path, url: trimmed, related: focus === "related" })
      if (name.trim() || description.trim()) {
        await api.setResourceMeta({
          type: added.type,
          id: added.id,
          name: name.trim(),
          description: description.trim(),
        })
      }
      reset()
      onAdded()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal opened={opened} onClose={handleClose} title="Add resource">
      <Stack gap="sm">
        {error ? (
          <Alert color="red" variant="light" title="Couldn't add resource" withCloseButton onClose={() => setError(null)}>
            <Text size="sm">{error}</Text>
          </Alert>
        ) : null}
        <TextInput
          label="URL"
          placeholder="Paste a PR, Jira, or Slack URL"
          value={url}
          onChange={(e) => {
            setUrl(e.currentTarget.value)
            setError(null)
          }}
          data-autofocus
        />
        <Stack gap={2}>
          <SegmentedControl
            value={focus}
            onChange={setFocus}
            data={[
              { value: "focus", label: "Focus" },
              { value: "related", label: "Related" },
            ]}
          />
          <Text size="xs" c="dimmed">
            {FOCUS_HELP[focus]}
          </Text>
        </Stack>
        {/*
          Custom NAME is Slack-only: a PR or Jira issue already has a title
          from its source, whereas a Slack thread has none — that is why
          custom names exist at all. Custom DESCRIPTION is offered for every
          type, since "why is this on this worktree" is worth recording
          regardless.
        */}
        {slack && (
          <TextInput
            label="Custom Name (optional)"
            placeholder="Thread name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        )}
        <Textarea
          label="Custom Description (optional)"
          placeholder="Why does this belong to this worktree?"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} loading={submitting} disabled={!url.trim()}>
            Add
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
