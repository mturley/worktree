import type { ReactNode } from "react"
import { Box, Text } from "@mantine/core"

export type LabelPosition = "left" | "top"

/**
 * A selector's label outside the control: beside it in the Code tab's header
 * row ("left"), above it in the diff view's sidebar ("top").
 */
export function LabeledControl({
  label,
  labelPosition,
  fullWidth,
  children,
}: {
  label: string
  labelPosition: LabelPosition
  fullWidth?: boolean
  children: ReactNode
}) {
  const top = labelPosition === "top"
  return (
    <Box
      style={{
        display: "flex",
        flexDirection: top ? "column" : "row",
        alignItems: top ? "stretch" : "center",
        gap: top ? 4 : 6,
        minWidth: 0,
        width: fullWidth ? "100%" : undefined,
      }}
    >
      <Text size="xs" c="dimmed" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
        {label}
      </Text>
      <Box style={{ minWidth: 0, flex: fullWidth || top ? 1 : undefined }}>{children}</Box>
    </Box>
  )
}
