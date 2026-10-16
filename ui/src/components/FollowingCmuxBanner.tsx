import { Alert, Button, Group, Text } from "@mantine/core"
import { IconArrowsExchange } from "@tabler/icons-react"
import { useFollowCmux } from "../hooks/useFollowCmux"

/**
 * Tells a worktree page that it is following cmux, with the way out.
 * Following is only turned on from the home page's "Follow cmux" toggle;
 * here there is just this banner while it is on, and nothing while it is off.
 *
 * Shown whenever following is on, even if cmux has since gone away, so it
 * can always be turned off.
 */
export function FollowingCmuxBanner() {
  const [follow, setFollow] = useFollowCmux()
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
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text size="sm">Following cmux: switching workspaces there opens their worktrees here.</Text>
        <Button size="compact-xs" variant="default" style={{ flex: "none" }} onClick={() => setFollow(false)}>
          Stop following
        </Button>
      </Group>
    </Alert>
  )
}
