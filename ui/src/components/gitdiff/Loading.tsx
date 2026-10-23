import { Group, Loader, Text } from "@mantine/core"

/** The Code tab's and diff view's loading state: a spinner beside "Loading…". */
export function Loading({ size = "xs" }: { size?: "xs" | "sm" }) {
  return (
    <Group gap={6} wrap="nowrap" role="status">
      <Loader size={size === "sm" ? 14 : 12} color="gray" />
      <Text size={size} c="dimmed">Loading…</Text>
    </Group>
  )
}
