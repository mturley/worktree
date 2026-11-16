import { useEffect, useState } from "react"
import { useUnsavedChanges } from "../lib/unsavedChanges"
import { Alert, Button, Checkbox, Group, Modal, Stack, Text, TextInput } from "@mantine/core"
import { api } from "../api/client"
import type { Job } from "../api/types"
import { attachJob, isFinished, useJob } from "../lib/jobsStore"
import { JobStepper } from "./jobs/JobStepper"

/**
 * Deleting a worktree, with the same care the CLI takes.
 *
 * The delete runs as a background job on the server; this modal renders the
 * job from the jobs store, so closing it stops nothing. Git may refuse to
 * remove the directory (leftover build output, read-only files) or to delete
 * an unmerged branch: the job then parks with a question, and the prompt
 * appears BENEATH the steps so the completed stages stay visible while the
 * user decides.
 *
 * On success the modal stays open. The steps are the only report of what
 * happened — which ports were freed, what was skipped — so closing
 * automatically would throw them away. The server drops a cleanly succeeded
 * job from the store shortly after it finishes, so the modal keeps the last
 * job it saw.
 */
export function DeleteWorktreeModal({ opened, path, name, branch, jobId: initialJobId, onClose, onDeleted }: {
  opened: boolean
  path?: string
  name?: string
  branch?: string
  /** Open on this existing job, skipping the confirmation form. */
  jobId?: string
  onClose: () => void
  /** Called when the user acknowledges a completed delete. */
  onDeleted: () => void
}) {
  const [typed, setTyped] = useState("")
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [starting, setStarting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [jobId, setJobId] = useState<string | undefined>(initialJobId)
  const [lastSeen, setLastSeen] = useState<Job | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const live = useJob(jobId)
  const job = live ?? (lastSeen?.id === jobId ? lastSeen : undefined)
  // A running delete no longer blocks leaving: it carries on server-side.
  useUnsavedChanges(opened && typed !== "" && !jobId)

  // Reset to a fresh confirmation form whenever the modal is (re)opened, or
  // when it is retargeted at a different worktree — a destructive dialog
  // must never show a previous run's results for the current open.
  useEffect(() => {
    if (opened) {
      setTyped("")
      setDeleteBranch(false)
      setStarting(false)
      setBusy(false)
      setJobId(initialJobId)
      setLastSeen(undefined)
      setError(null)
    }
  }, [opened, path, initialJobId])

  useEffect(() => {
    if (live) setLastSeen(live)
  }, [live])

  // The job's toast stays hidden while this modal shows it.
  useEffect(() => {
    if (!opened || jobId === undefined) return
    return attachJob(jobId)
  }, [opened, jobId])

  const start = async () => {
    if (path === undefined) return
    setStarting(true)
    setError(null)
    try {
      const res = await api.deleteWorktree({ path, delete_branch: deleteBranch })
      setJobId(res.job.id)
      setLastSeen(res.job)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  // Run an action on the job; a failed request shows in the alert.
  const act = async (fn: (id: string) => Promise<unknown>): Promise<boolean> => {
    if (jobId === undefined) return false
    setBusy(true)
    setError(null)
    try {
      await fn(jobId)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  // A finished job is acknowledged by closing it. It may already be gone
  // (another tab, or the server's own expiry), which is fine.
  const dismissFinished = async () => {
    if (jobId === undefined) return
    try {
      await api.jobDismiss(jobId)
    } catch {
      // already dismissed or expired
    }
  }

  const close = () => {
    if (job && isFinished(job)) void dismissFinished()
    onClose()
  }

  const ok = async () => {
    await dismissFinished()
    if (job?.state === "succeeded") onDeleted()
    else onClose()
  }

  // Declining the directory force ends and dismisses the job on the server:
  // nothing has been deleted yet. Declining the branch force makes it finish
  // the cleanup with the branch kept, so the modal stays to show that.
  const decline = async () => {
    if (!(await act((id) => api.jobAnswer(id, "no")))) return
    if (job?.question?.key === "remove_directory") onClose()
  }

  const title = job ? job.title : name ? `Delete worktree ${name}` : "Delete worktree"
  const question = job?.state === "needs_answer" ? job.question : null
  const failed = job?.state === "failed" || job?.state === "interrupted"
  const showError = failed && job.error !== undefined
    && !job.steps.some((s) => s.detail === job.error)

  return (
    <Modal opened={opened} onClose={close} title={title} size="lg">
      <Stack gap="sm">
        {!job && (
          <>
            <Text size="sm">
              This removes the worktree directory and everything worktree tracks for it —
              its port range, tracked resources and kubeconfig.
            </Text>
            <TextInput
              label={`Type the worktree name (${name ?? ""}) to confirm`}
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

        {job && <JobStepper steps={job.steps} />}

        {error && <Alert color="red" variant="light">{error}</Alert>}
        {showError && <Alert color="red" variant="light">{job.error}</Alert>}

        {question?.key === "remove_directory" && (
          <Alert color="yellow" variant="light">
            <Text size="sm">
              This is usually leftover build output or read-only files in the worktree.
            </Text>
          </Alert>
        )}

        {job?.state === "running" && (
          <Text size="xs" c="dimmed">This keeps running if you close this window.</Text>
        )}

        <Group justify="flex-end">
          {!job && (
            <>
              <Button variant="default" onClick={onClose}>Cancel</Button>
              <Button
                color="red"
                disabled={name === undefined || typed !== name || path === undefined || starting}
                loading={starting}
                onClick={() => void start()}
              >
                Delete
              </Button>
            </>
          )}
          {question && (
            <>
              <Button variant="default" onClick={() => void decline()} disabled={busy}>Cancel</Button>
              <Button
                color="red"
                loading={busy}
                onClick={() => void act((id) => api.jobAnswer(id, "yes"))}
              >
                {question.key === "remove_directory"
                  ? "Force-remove the directory"
                  : "Force-delete the branch"}
              </Button>
            </>
          )}
          {failed && (
            <>
              <Button variant="default" loading={busy} onClick={() => void act((id) => api.jobRetry(id))}>
                Run again
              </Button>
              <Button onClick={() => void ok()}>OK</Button>
            </>
          )}
          {job?.state === "succeeded" && <Button onClick={() => void ok()}>OK</Button>}
          {job?.state === "running" && <Button variant="default" onClick={close}>Close</Button>}
        </Group>
      </Stack>
    </Modal>
  )
}
