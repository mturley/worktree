import type { ReactNode } from "react"
import { Group } from "@mantine/core"

/** An option with its icon on the left, as the row's menus show them. */
export function iconOption(icon: ReactNode, label: string) {
  return (
    <Group gap={8} wrap="nowrap">
      {icon}
      <span>{label}</span>
    </Group>
  )
}
