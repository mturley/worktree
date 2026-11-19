import { Alert, Button, Group, Text } from "@mantine/core"
import { IconArrowsExchange } from "@tabler/icons-react"
import { useFollowCmux } from "../hooks/useFollowCmux"
import { useCmuxTwoWaySync } from "../hooks/useCmuxTwoWaySync"
import { Toggle } from "./Toggle"

/**
 * Tells the page (a worktree's, or the home page, where two-way sync keeps
 * following on) that this tab is following cmux, with the way out, and the
 * "Two-way sync" toggle (see CmuxFollower): with it on, opening a worktree
 * here switches cmux too, and the text says so.
 *
 * Shown whenever following is on, even if cmux has since gone away, so it
 * can always be turned off.
 */
export function FollowingCmuxBanner() {
  const [follow, setFollow] = useFollowCmux()
  const [twoWay, setTwoWay] = useCmuxTwoWaySync()
  if (!follow) return null
  return (
    <Alert
      color="blue"
      variant="light"
      p="xs"
      icon={<IconArrowsExchange size={16} />}
      styles={{ wrapper: { alignItems: "center" }, icon: { marginTop: 0 } }}
      data-following-cmux-banner
    >
      {/* Wraps on a narrow screen: the controls drop under the text. */}
      <Group justify="space-between" gap="xs" wrap="wrap">
        <Text size="sm" style={{ flex: "1 1 240px" }}>
          {twoWay
            ? "Synced with cmux: switching workspaces there opens their worktrees here, and opening a worktree here switches cmux to it."
            : "Following cmux: switching workspaces there opens their worktrees here."}
        </Text>
        <Group gap="sm" wrap="nowrap" style={{ flex: "none", marginLeft: "auto" }}>
          <Toggle
            checked={twoWay}
            onChange={(e) => setTwoWay(e.currentTarget.checked)}
            label="Two-way sync"
            tooltip="Opening a worktree here also switches cmux to its workspace"
            style={{ flex: "none" }}
          />
          <Button size="compact-xs" variant="default" style={{ flex: "none" }} onClick={() => setFollow(false)}>
            Stop following
          </Button>
        </Group>
      </Group>
    </Alert>
  )
}
