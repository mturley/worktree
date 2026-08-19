import { useState } from "react"
import { Alert, Button, Group, Stack, Text, TextInput, Title } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { api } from "../api/client"
import { ResourceCard } from "./ResourceCard"

interface ResourceListProps {
  items: ResourceDTO[]
  path: string
  onChanged: () => void
}

export function ResourceList({ items, path, onChanged }: ResourceListProps) {
  const [url, setUrl] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const focus = items.filter((r) => r.primary)
  const related = items.filter((r) => !r.primary)

  const handleAdd = async () => {
    if (!url.trim() || submitting) return
    setSubmitting(true)
    try {
      await api.addResource({ path, url: url.trim() })
      setUrl("")
      setAddError(null)
      onChanged()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Stack gap="md">
      <Stack gap={4}>
        <Group gap="xs" wrap="nowrap">
          <TextInput
            placeholder="Paste a PR, Jira, or Slack URL"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void handleAdd()
              }
            }}
            style={{ flex: 1 }}
            size="sm"
          />
          <Button size="sm" disabled={!url.trim() || submitting} loading={submitting} onClick={() => void handleAdd()}>
            Add
          </Button>
        </Group>
        {addError ? (
          <Alert
            color="red"
            variant="light"
            title="Couldn't add resource"
            withCloseButton
            onClose={() => setAddError(null)}
          >
            <Text size="sm">{addError}</Text>
          </Alert>
        ) : null}
      </Stack>
      {items.length === 0 ? (
        <Text c="dimmed" size="sm">No resources tracked.</Text>
      ) : (
        <>
          {focus.length > 0 && (
            <Stack gap={4}>
              <Title order={5}>Focus</Title>
              <Stack gap={4}>
                {focus.map((r) => (
                  <ResourceCard key={`${r.type}:${r.id}`} r={r} path={path} onRemoved={onChanged} />
                ))}
              </Stack>
            </Stack>
          )}
          {related.length > 0 && (
            <Stack gap={4}>
              <Title order={5}>Related</Title>
              <Stack gap={4}>
                {related.map((r) => (
                  <ResourceCard key={`${r.type}:${r.id}`} r={r} path={path} onRemoved={onChanged} />
                ))}
              </Stack>
            </Stack>
          )}
        </>
      )}
    </Stack>
  )
}
