import { useState } from "react"
import { Button, Group, Stack, Text, Title } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { ResourceCard } from "./ResourceCard"
import { AddResourceModal } from "./AddResourceModal"

interface ResourceListProps {
  items: ResourceDTO[]
  path: string
  onChanged: () => void
}

export function ResourceList({ items, path, onChanged }: ResourceListProps) {
  const [addOpen, setAddOpen] = useState(false)

  const focus = items.filter((r) => r.primary)
  const related = items.filter((r) => !r.primary)

  return (
    <Stack gap="md">
      <Group>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          Add resource
        </Button>
      </Group>
      <AddResourceModal
        opened={addOpen}
        path={path}
        onClose={() => setAddOpen(false)}
        onAdded={onChanged}
      />
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
