import { useEffect, useState } from "react"
import { Alert, Button, Checkbox, Group, Loader, Modal, Stack, Text, TextInput } from "@mantine/core"
import { IconCheck, IconX } from "@tabler/icons-react"
import { api } from "../api/client"
import type { DeleteStep, DeleteWorktreeResponse } from "../api/types"

/** One stage of the pipeline: icon, label, and git's words when there are any. */
function StepRow({ step, running }: { step: DeleteStep; running: boolean }) {
  const icon = running ? <Loader size={14} />
    : step.status === "failed" || step.status === "needs_force"
      ? <IconX size={14} color="var(--mantine-color-red-5)" />
      : step.status === "pending"
        ? <Text size="xs" c="dimmed">○</Text>
        : <IconCheck size={14} color="var(--mantine-color-green-5)" />
  return (
    <Stack gap={2}>
      <Group gap={8} wrap="nowrap">
        {icon}
        <Text size="sm" c={step.status === "pending" ? "dimmed" : undefined}>{step.label}</Text>
        {step.status === "skipped" && step.detail && (
          <Text size="xs" c="dimmed">({step.detail})</Text>
        )}
      </Group>
      {(step.status === "failed" || step.status === "needs_force") && step.detail && (
        <Text size="xs" c="red" pl={22} style={{ whiteSpace: "pre-wrap" }}>{step.detail}</Text>
      )}
    </Stack>
  )
}

/**
 * Deleting a worktree, with the same care the CLI takes.
 *
 * The flow is deliberately multi-phase: git may refuse to remove the directory
 * (leftover build output, read-only files) and may refuse to delete an unmerged
 * branch. Each refusal comes back as needs_force naming the step, and the
 * prompt appears BENEATH that stage so the completed stages stay visible while
 * the user decides.
 *
 * On success the modal stays open. The summary is the only report of what
 * happened — which ports were freed, what was skipped — so closing
 * automatically would throw it away.
 */
export function DeleteWorktreeModal({ opened, path, name, branch, onClose, onDeleted }: {
  opened: boolean
  path: string
  name: string
  branch?: string
  onClose: () => void
  /** Called when the user acknowledges a completed delete. */
  onDeleted: () => void
}) {
  const [typed, setTyped] = useState("")
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<DeleteWorktreeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Reset to a fresh confirmation form whenever the modal is (re)opened, or
  // when it is retargeted at a different worktree — a destructive dialog
  // must never show a previous run's results for the current open.
  useEffect(() => {
    if (opened) {
      setTyped("")
      setDeleteBranch(false)
      setRunning(false)
      setResult(null)
      setError(null)
    }
  }, [opened, path])

  const run = async (
    force: { force_directory?: boolean; force_branch?: boolean } = {},
    deleteBranchOverride?: boolean,
  ) => {
    setRunning(true)
    setError(null)
    try {
      setResult(await api.deleteWorktree({
        path,
        delete_branch: deleteBranchOverride ?? deleteBranch,
        ...force,
      }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const needsForce = result?.needs_force ?? ""
  const finished = Boolean(result && !needsForce && result.ok)

  // Declining the directory force is safe to just close: nothing has been
  // deleted yet. Declining the branch force is NOT — remove_directory has
  // already run, so closing here would strand the port range, registry row,
  // resources and kubeconfig. Re-run with delete_branch:false instead; the
  // run is idempotent, so remove_directory reports skipped and the rest of
  // cleanup completes.
  const cancelEscalation = () => {
    if (needsForce === "delete_branch") {
      void run({}, false)
      return
    }
    onClose()
  }

  return (
    <Modal opened={opened} onClose={onClose} title={`Delete worktree ${name}`} size="lg">
      <Stack gap="sm">
        {!result && (
          <>
            <Text size="sm">
              This removes the worktree directory and everything worktree tracks for it —
              its port range, tracked resources and kubeconfig.
            </Text>
            <TextInput
              label={`Type the worktree name (${name}) to confirm`}
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
            />
            <Checkbox
              label={branch ? `Also delete the branch ${branch}` : "Also delete the branch"}
              checked={deleteBranch}
              onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
            />
          </>
        )}

        {result && (
          <Stack gap={6}>
            {result.steps.map((s) => (
              <StepRow key={s.key} step={s} running={running && s.status === "pending"} />
            ))}
          </Stack>
        )}

        {error && <Alert color="red" variant="light">{error}</Alert>}
        {result?.error && !needsForce && !result.steps.some((s) => s.detail === result.error) && (
          <Alert color="red" variant="light">{result.error}</Alert>
        )}

        {needsForce === "remove_directory" && (
          <Alert color="yellow" variant="light">
            <Text size="sm">
              This is usually leftover build output or read-only files in the worktree.
            </Text>
          </Alert>
        )}

        <Group justify="flex-end">
          {!result && (
            <>
              <Button variant="default" onClick={onClose}>Cancel</Button>
              <Button
                color="red"
                disabled={typed !== name || running}
                loading={running}
                onClick={() => void run()}
              >
                Delete
              </Button>
            </>
          )}
          {needsForce && (
            <>
              <Button variant="default" onClick={cancelEscalation} disabled={running}>Cancel</Button>
              <Button
                color="red"
                loading={running}
                onClick={() =>
                  void run(needsForce === "remove_directory"
                    ? { force_directory: true }
                    : { force_branch: true })}
              >
                {needsForce === "remove_directory"
                  ? "Force-remove the directory"
                  : "Force-delete the branch"}
              </Button>
            </>
          )}
          {result && !needsForce && (
            <Button onClick={finished ? onDeleted : onClose}>OK</Button>
          )}
        </Group>
      </Stack>
    </Modal>
  )
}
