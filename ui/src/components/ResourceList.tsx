import { Anchor, Badge, Group, Paper, Stack, Text } from "@mantine/core"
import type { ResourceDTO } from "../api/types"

export function ResourceList({ items }: { items: ResourceDTO[] }) {
  if (items.length === 0) return <Text c="dimmed" size="sm">No resources tracked.</Text>
  return (
    <Stack gap={4}>
      {items.map((r) => (
        <Paper key={`${r.type}:${r.id}`} p="xs" withBorder>
          <Group gap="xs">
            <Badge size="xs" variant={r.primary ? "filled" : "outline"} color={r.primary ? "blue" : "gray"}>
              {r.primary ? "primary" : "related"}
            </Badge>
            <Badge size="xs" variant="light">{r.type}</Badge>
            {r.url ? <Anchor href={r.url} target="_blank" size="sm">{r.id}</Anchor> : <Text size="sm">{r.id}</Text>}
          </Group>
        </Paper>
      ))}
    </Stack>
  )
}
