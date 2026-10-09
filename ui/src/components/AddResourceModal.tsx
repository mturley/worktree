import { useEffect, useState, type ReactNode } from "react"
import { useUnsavedChanges } from "../lib/unsavedChanges"
import {
  Alert,
  Button,
  Group,
  List,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core"
import { IconWorld } from "@tabler/icons-react"
import { api } from "../api/client"
import { SlackMark } from "./icons/SlackMark"
import { GitHubMark } from "./icons/GitHubMark"
import { JiraMark } from "./icons/JiraMark"
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

const POSITION_HELP: Record<string, string> = {
  top: "Goes first in its section.",
  bottom: "Goes last in its section.",
}

/**
 * The URLs that become first-class resources, bulleted with the same brand
 * marks, in the same order, as the activity list's source toggles. Anything
 * else is still followed, as a link — bulleted last, with the globe the
 * resource cards use for a link, and saying it gets no activity.
 */
const SUPPORTED_URLS: { label: string; icon: ReactNode }[] = [
  { label: "GitHub PRs", icon: <GitHubMark size={14} /> },
  { label: "Jira issues", icon: <JiraMark size={14} /> },
  { label: "Slack threads", icon: <SlackMark size={14} /> },
  {
    label: "Any other link (bookmarks it with no activity tracking)",
    icon: <IconWorld size={14} aria-hidden style={{ flexShrink: 0 }} />,
  },
]

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
 * (mapping to the backend's primary/related distinction), whether it lands
 * at the top or bottom of that section (top by default), and, for types with
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
  const [position, setPosition] = useState("top")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  useUnsavedChanges(opened && (url.trim() !== "" || name.trim() !== "" || description.trim() !== ""))
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
    setPosition("top")
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
      const added = await api.addResource({
        path,
        url: trimmed,
        related: focus === "related",
        position: position === "bottom" ? "bottom" : "top",
      })
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
        <Stack gap={4}>
          <Text size="sm">Supported resource URLs:</Text>
          <List size="sm" spacing={4} center withPadding>
            {SUPPORTED_URLS.map(({ label, icon }) => (
              <List.Item key={label} icon={icon}>
                {label}
              </List.Item>
            ))}
          </List>
        </Stack>
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
        <Stack gap={2}>
          <SegmentedControl
            value={position}
            onChange={setPosition}
            data={[
              { value: "top", label: "Add to top" },
              { value: "bottom", label: "Add to bottom" },
            ]}
          />
          <Text size="xs" c="dimmed">
            {POSITION_HELP[position]}
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
