import { ActionIcon, CopyButton, Group, Stack, Text, Tooltip } from "@mantine/core"
import { IconCheck, IconCopy } from "@tabler/icons-react"
import type { KubeconfigInfo } from "../api/types"
import { useChecks } from "../lib/checksStore"
import { CheckedAgo } from "./CheckedAgo"

/** One labelled value; a value the kubeconfig doesn't define says so. `copy` adds a copy button. */
function Row({ label, value, copy }: { label: string; value: string | null | undefined; copy?: boolean }) {
  return (
    <Group gap="xs" wrap="nowrap" align="baseline">
      <Text size="xs" c="dimmed" style={{ flex: "none", width: 72 }}>{label}</Text>
      {value ? (
        <>
          <Text size="xs" ff="monospace" style={{ overflowWrap: "anywhere" }}>{value}</Text>
          {copy && (
            <CopyButton value={value}>
              {({ copied, copy: doCopy }) => (
                <Tooltip label={copied ? "Copied" : `Copy ${label.toLowerCase()} URL`}>
                  <ActionIcon variant="subtle" color={copied ? "teal" : "gray"} size="xs" aria-label={`Copy ${label.toLowerCase()} URL`} onClick={doCopy} style={{ flex: "none" }}>
                    {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          )}
        </>
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
  const checks = useChecks()
  return (
    <Stack gap={2}>
      <Group gap="xs" wrap="wrap">
        <Text size="sm" fw={600}>Kubeconfig</Text>
        <Text size="xs" c="dimmed">Current cluster context<CheckedAgo at={checks.kubeconfig} /></Text>
      </Group>
      {!kubeconfig || kubeconfig.state === "missing" ? (
        <Text size="xs" c="dimmed" fs="italic">No kubeconfig</Text>
      ) : kubeconfig.state !== "ok" ? (
        <Text size="xs" c="dimmed" fs="italic">No current context</Text>
      ) : (
        <>
          <Row label="Cluster" value={kubeconfig.cluster} copy />
          <Row label="User" value={kubeconfig.user} />
          {kubeconfig.namespace && <Row label="Namespace" value={kubeconfig.namespace} />}
        </>
      )}
    </Stack>
  )
}
