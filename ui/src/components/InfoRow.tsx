import type { ReactNode } from "react"
import { Group, Text } from "@mantine/core"

/** One labelled line of git state: "Branch   my-branch". */
export function InfoRow({ label, children, labelWidth = 80 }: {
  label: string
  children: ReactNode
  labelWidth?: number
}) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      {/* Never wraps ("Working tree" on two lines): the width is a minimum,
          so a label longer than it pushes its value along instead. */}
      <Text size="xs" c="dimmed" miw={labelWidth} style={{ flex: "none", whiteSpace: "nowrap" }}>{label}</Text>
      <Text size="xs" style={{ overflowWrap: "anywhere", minWidth: 0 }}>{children}</Text>
    </Group>
  )
}
