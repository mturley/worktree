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
export function AddResourceModal({ opened, path, onClose, onAdded, defaultRelated }: AddResourceModalProps) {
  const [url, setUrl] = useState("")
  const [focus, setFocus] = useState(defaultRelated ? "related" : "focus")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const slack = isSlackUrl(url)

  const reset = () => {
    setUrl("")
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
      if (slack && (name.trim() || description.trim())) {
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
        {slack ? (
          <>
            <TextInput
              label="Name (optional)"
              placeholder="Thread name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <Textarea
              label="Description (optional)"
              placeholder="What is this thread about?"
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
            />
          </>
        ) : null}
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
