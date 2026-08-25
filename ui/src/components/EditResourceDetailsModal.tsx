import { useEffect, useState } from "react"
import { Alert, Button, Group, Modal, Stack, Text, Textarea, TextInput } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { api } from "../api/client"

interface EditResourceDetailsModalProps {
  opened: boolean
  r: ResourceDTO
  onClose: () => void
  /** Refetch resources so the saved values show up. */
  onSaved: () => void
}

/**
 * Edits a resource's custom name/description, for any resource type.
 *
 * Custom NAME is offered only for Slack threads: a PR or a Jira issue already
 * has a real title from its source, whereas a Slack thread has none — that is
 * the whole reason custom names exist. Custom DESCRIPTION is offered for
 * everything, since "why is this resource on this worktree" is worth recording
 * regardless of type.
 */
export function EditResourceDetailsModal({ opened, r, onClose, onSaved }: EditResourceDetailsModalProps) {
  const supportsCustomName = r.type === "slack"
  const [name, setName] = useState(r.custom_name ?? "")
  const [description, setDescription] = useState(r.custom_description ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-seed when the modal opens, so it reflects the current values rather
  // than whatever was typed and abandoned last time.
  useEffect(() => {
    if (opened) {
      setName(r.custom_name ?? "")
      setDescription(r.custom_description ?? "")
      setError(null)
    }
  }, [opened, r.custom_name, r.custom_description])

  // Clears BOTH fields in one action. Emptying two inputs by hand and saving
  // works too, but "make this resource plain again" is a single intent and
  // deserves a single control.
  const handleClear = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await api.setResourceMeta({ type: r.type, id: r.id, name: "", description: "" })
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const hasAnyCustomMeta = Boolean(r.custom_name || r.custom_description)

  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await api.setResourceMeta({
        type: r.type,
        id: r.id,
        // Preserve any existing name for types that cannot edit it, rather
        // than blanking it as a side effect of saving a description.
        name: supportsCustomName ? name.trim() : (r.custom_name ?? ""),
        description: description.trim(),
      })
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Edit resource details">
      <Stack gap="sm">
        {error ? (
          <Alert color="red" variant="light" title="Couldn't save" withCloseButton onClose={() => setError(null)}>
            <Text size="sm">{error}</Text>
          </Alert>
        ) : null}
        {supportsCustomName && (
          <TextInput
            label="Custom Name (optional)"
            placeholder="Thread name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            data-autofocus
          />
        )}
        <Textarea
          label="Custom Description (optional)"
          placeholder="Why does this belong to this worktree?"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          data-autofocus={supportsCustomName ? undefined : true}
        />
        <Group justify="space-between">
          {hasAnyCustomMeta ? (
            <Button variant="subtle" color="red" onClick={() => void handleClear()} disabled={saving}>
              Clear custom metadata
            </Button>
          ) : (
            <span />
          )}
          <Group gap="xs">
            <Button variant="default" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void handleSave()} loading={saving}>
              Save
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  )
}
