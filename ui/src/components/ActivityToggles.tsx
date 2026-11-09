import type { ReactNode } from "react"
import { Group } from "@mantine/core"

/**
 * The row of switches above an activity feed's filter buttons: Unreads
 * only, Humans only and Include archived, as each feed has them. Every activity view puts its switches here, so they are
 * found in the same place whichever feed is showing.
 */
export function ActivityToggles({ children }: { children: ReactNode }) {
  return (
    <Group gap="lg" align="center" data-testid="activity-toggles">
      {children}
    </Group>
  )
}
