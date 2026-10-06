import { Box, Tooltip } from "@mantine/core"
import { IconBell, IconBellFilled, IconStack2 } from "@tabler/icons-react"

const EXPLICIT = "Notifications are on for this resource"
const IMPLICIT =
  "Notifications are on for all resources in this worktree. Turn off 'Notify on all' at the top of this page to change it"

/**
 * Marks something that will notify. Explicit: set on this resource (filled).
 * Implicit: inherited from the worktree-wide toggle (outlined, dimmed, with a
 * stack badge), so the reader knows the switch to change is the worktree's,
 * not this one's.
 */
export function NotifyBell({ kind, tooltip }: { kind: "explicit" | "implicit"; tooltip?: string }) {
  const explicit = kind === "explicit"
  return (
    <Tooltip label={tooltip ?? (explicit ? EXPLICIT : IMPLICIT)} withArrow multiline maw={280}>
      <Box
        component="span"
        role="img"
        aria-label={explicit ? "Notifications on" : "Notifications on for the whole worktree"}
        data-kind={kind}
        style={{ position: "relative", display: "inline-flex", flex: "none", lineHeight: 0 }}
      >
        {explicit ? (
          <IconBellFilled size={14} style={{ color: "var(--mantine-color-yellow-6)" }} aria-hidden />
        ) : (
          <>
            <IconBell size={14} style={{ color: "var(--mantine-color-dimmed)" }} aria-hidden />
            <IconStack2
              size={8}
              aria-hidden
              style={{ position: "absolute", right: -4, bottom: -3, color: "var(--mantine-color-dimmed)" }}
            />
          </>
        )}
      </Box>
    </Tooltip>
  )
}
