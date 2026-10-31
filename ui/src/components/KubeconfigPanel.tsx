import { Group, Stack, Text } from "@mantine/core"
import type { KubeconfigInfo } from "../api/types"

/** One labelled value; a value the kubeconfig doesn't define says so. */
function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <Group gap="xs" wrap="nowrap" align="baseline">
      <Text size="xs" c="dimmed" style={{ flex: "none", width: 72 }}>{label}</Text>
      {value ? (
        <Text size="xs" ff="monospace" style={{ overflowWrap: "anywhere" }}>{value}</Text>
      ) : (
        <Text size="xs" c="dimmed" fs="italic">not found</Text>
      )}
    </Group>
  )
}

/**
 * The Environment tab's Kubeconfig section: the current context of the file
 * the worktree's KUBECONFIG names. Read from the file only; the server never
 * contacts the cluster, so this is what you're configured for, not proof the
 * login is still valid.
 */
export function KubeconfigPanel({ kubeconfig }: { kubeconfig: KubeconfigInfo | undefined }) {
  return (
    <Stack gap={2}>
      <Group gap="xs" wrap="wrap">
        <Text size="sm" fw={600}>Kubeconfig</Text>
        <Text size="xs" c="dimmed">Current cluster context</Text>
      </Group>
      {!kubeconfig || kubeconfig.state === "missing" ? (
        <Text size="xs" c="dimmed" fs="italic">No kubeconfig</Text>
      ) : kubeconfig.state !== "ok" ? (
        <Text size="xs" c="dimmed" fs="italic">No current context</Text>
      ) : (
        <>
          <Row label="Cluster" value={kubeconfig.cluster} />
          <Row label="User" value={kubeconfig.user} />
          {kubeconfig.namespace && <Row label="Namespace" value={kubeconfig.namespace} />}
        </>
      )}
    </Stack>
  )
}
