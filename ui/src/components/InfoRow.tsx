import type { ReactNode } from "react"
import { Group, Text } from "@mantine/core"

/** One labelled line of git state: "Branch   my-branch". */
export function InfoRow({ label, children, labelWidth = 70 }: {
  label: string
  children: ReactNode
  labelWidth?: number
}) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Text size="xs" c="dimmed" w={labelWidth} style={{ flex: "none" }}>{label}</Text>
      <Text size="xs" style={{ overflowWrap: "anywhere", minWidth: 0 }}>{children}</Text>
    </Group>
  )
}
