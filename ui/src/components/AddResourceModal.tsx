import { useEffect, useState } from "react"
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
import { supportsCustomName } from "../lib/customName"
import { shortResourceRef } from "../lib/resourceRef"

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

const FOCUS_HELP: Record<string, string> = {
  focus: "Central to this worktree.",
  related: "Linked or secondary resource.",
}

const DETECTED_LABEL: Record<string, string> = {
  pr: "GitHub PR", jira: "Jira issue", slack: "Slack thread", link: "Link",
}

function detectedSummary(d: { type: string; id: string } | null): string {
  if (!d || !d.type) return ""
  const name = DETECTED_LABEL[d.type] ?? d.type
  const ref = shortResourceRef(d.type, d.id)
  return ref ? `${name} — ${ref}` : name
}

/**
 * Modal for adding a resource (PR, Jira issue, Slack thread, or any other
 * link) to a worktree. Lets the user choose Focus vs Related up front
 * (mapping to the backend's primary/related distinction) and, for types with
 * no title of their own, optionally set a custom name and description at add
 * time.
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

  /*
   * What kind of resource the pasted URL is, answered by the server.
   *
   * Deliberately not a frontend regex: recognising a link means recognising
   * what is NOT a PR or Jira URL, and copying those patterns here is the exact
   * duplication internal/resourceurl exists to prevent (webui once hand-copied
   * cmd/root.go's PR regex under a comment promising to keep them in sync).
   * One detector, asked over HTTP.
   */
  const [detected, setDetected] = useState<{ type: string; id: string } | null>(null)
  useEffect(() => {
    const trimmed = url.trim()
    if (!trimmed) {
      setDetected(null)
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      api.resourceType(trimmed)
        .then((d) => { if (!cancelled) setDetected(d) })
        .catch(() => { if (!cancelled) setDetected(null) })
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
  }, [url])

  const customName = supportsCustomName(detected?.type ?? "")

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
    <Modal opened={opened} onClose={handleClose} title="Follow resource">
      <Stack gap="sm">
        {error ? (
          <Alert color="red" variant="light" title="Couldn't add resource" withCloseButton onClose={() => setError(null)}>
            <Text size="sm">{error}</Text>
          </Alert>
        ) : null}
        <TextInput
          label="URL"
          placeholder="Paste any URL"
          value={url}
          onChange={(e) => {
            setUrl(e.currentTarget.value)
            setError(null)
          }}
          data-autofocus
        />
        {detected?.type && (
          <Text size="xs" c="dimmed">
            {detectedSummary(detected)}
          </Text>
        )}
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
          Custom NAME is only offered for types with no title of their own
          (Slack thread, link) — a PR or Jira issue already has one from its
          source. Custom DESCRIPTION is offered for every type, since "why is
          this on this worktree" is worth recording regardless.
        */}
        {customName && (
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
            Follow
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
