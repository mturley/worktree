import { Stack, Text, Title } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { ResourceCard } from "./ResourceCard"

export function ResourceList({ items }: { items: ResourceDTO[] }) {
  if (items.length === 0) return <Text c="dimmed" size="sm">No resources tracked.</Text>

  const focus = items.filter((r) => r.primary)
  const related = items.filter((r) => !r.primary)

  return (
    <Stack gap="md">
      {focus.length > 0 && (
        <Stack gap={4}>
          <Title order={5}>Focus</Title>
          <Stack gap={4}>
            {focus.map((r) => <ResourceCard key={`${r.type}:${r.id}`} r={r} />)}
          </Stack>
        </Stack>
      )}
      {related.length > 0 && (
        <Stack gap={4}>
          <Title order={5}>Related</Title>
          <Stack gap={4}>
            {related.map((r) => <ResourceCard key={`${r.type}:${r.id}`} r={r} />)}
          </Stack>
        </Stack>
      )}
    </Stack>
  )
}
