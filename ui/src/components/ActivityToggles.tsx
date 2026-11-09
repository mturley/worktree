import type { ReactNode } from "react"
import { Group } from "@mantine/core"

/**
 * The row of switches under an activity feed's filter buttons, directly
 * above the events: Unreads only, Humans only and Include archived, as each
 * feed has them. Every activity view puts its switches here, so they are
 * found in the same place whichever feed is showing.
 */
export function ActivityToggles({ children, justify }: { children: ReactNode; justify?: "flex-start" | "flex-end" }) {
  return (
    <Group gap="lg" align="center" justify={justify} data-testid="activity-toggles">
      {children}
    </Group>
  )
}
