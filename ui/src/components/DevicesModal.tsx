import { Alert, Badge, Button, Group, Loader, Modal, Stack, Text } from "@mantine/core"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import type { SessionInfo } from "../api/types"
import { relativeTime } from "../lib/relativeTime"

/** Every browser logged in to this worktree UI, each revocable on its own. */
export function DevicesModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions, enabled: opened })
  const revoke = useMutation({
    mutationFn: (s: SessionInfo) => api.revokeSession(s.handle),
    onSuccess: (_data, s) => {
      // Revoking this browser's own session is logging out: the session
      // query refetches, gets a 401, and the app shows the login screen.
      if (s.current) void qc.invalidateQueries({ queryKey: ["session"] })
      else void qc.invalidateQueries({ queryKey: ["sessions"] })
    },
  })

  return (
    <Modal opened={opened} onClose={onClose} title="Devices" size="lg">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Every browser logged in to this worktree UI. Logging one out revokes its access immediately.
        </Text>
        {sessions.isLoading && <Loader size="sm" />}
        {sessions.error && (
          <Alert color="red" title="Couldn't load devices">{sessions.error.message}</Alert>
        )}
        {revoke.error && (
          <Alert color="red" title="Couldn't log out that device">{revoke.error.message}</Alert>
        )}
        {sessions.data?.map((s) => (
          <Group key={s.handle} justify="space-between" wrap="nowrap" data-testid="device-row">
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Group gap={6} wrap="nowrap">
                <Text fw={500} truncate>{s.label}</Text>
                {s.current && <Badge size="xs" variant="light">This device</Badge>}
              </Group>
              <Text size="xs" c="dimmed">
                Logged in {relativeTime(s.created_at)} · last seen {relativeTime(s.last_seen_at)}
              </Text>
            </Stack>
            <Button
              size="xs"
              variant="light"
              color="red"
              aria-label={`Log out ${s.label}`}
              loading={revoke.isPending && revoke.variables?.handle === s.handle}
              onClick={() => revoke.mutate(s)}
            >
              Log out
            </Button>
          </Group>
        ))}
      </Stack>
    </Modal>
  )
}
