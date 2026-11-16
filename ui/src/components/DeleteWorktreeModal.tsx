import { useEffect, useState } from "react"
import { useUnsavedChanges } from "../lib/unsavedChanges"
import { Alert, Button, Checkbox, Group, Modal, Stack, Text, TextInput } from "@mantine/core"
import { api } from "../api/client"
import type { Job } from "../api/types"
import { isFinished } from "../lib/jobsStore"
import { jobErrorToShow } from "./jobs/jobError"
import { JOB_GONE_TEXT, JOB_UNKNOWN_TEXT } from "./jobs/jobMessages"
import { JobStepper } from "./jobs/JobStepper"
import { useModalJob } from "./jobs/useModalJob"

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
 *
 * With `onStarted` the modal is only the confirmation form: it hands the
 * started job over and expects to be closed, so that whoever is better placed
 * to outlive the delete can show the rest.
 */
export function DeleteWorktreeModal({ opened, path, name, branch, jobId: initialJobId, initialJob, onClose, onDeleted, onStarted }: {
  opened: boolean
  path?: string
  name?: string
  branch?: string
  /** Open on this existing job, skipping the confirmation form. */
  jobId?: string
  /** That job as the caller last saw it, until the stream says otherwise. */
  initialJob?: Job
  onClose: () => void
  /** Called when the user acknowledges a completed delete. */
  onDeleted: () => void
  /** Called with the job the Delete button started, instead of showing it. */
  onStarted?: (job: Job) => void
}) {
  const [typed, setTyped] = useState("")
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [starting, setStarting] = useState(false)
  const { jobId, job, gone, unknown, busy, error, setError, track, act, dismissFinished } =
    useModalJob(opened, initialJobId, path, initialJob)
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
    }
  }, [opened, path, initialJobId])

  const start = async () => {
    if (path === undefined) return
    setStarting(true)
    setError(null)
    try {
      const res = await api.deleteWorktree({ path, delete_branch: deleteBranch })
      if (onStarted) onStarted(res.job)
      else track(res.job)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
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
  // A job that ended out of sight is over, whatever its last state said.
  const question = job?.state === "needs_answer" && !gone ? job.question : null
  const failed = !gone && (job?.state === "failed" || job?.state === "interrupted")
  const showError = job !== undefined && !gone ? jobErrorToShow(job) : undefined
  const running = job?.state === "running" && !gone

  return (
    <Modal opened={opened} onClose={close} title={title} size="lg">
      <Stack gap="sm">
        {unknown && <Text size="sm">{JOB_UNKNOWN_TEXT}</Text>}
        {!job && !unknown && (
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

        {job && <JobStepper steps={job.steps} quiet={gone} />}

        {error && <Alert color="red" variant="light">{error}</Alert>}
        {showError && <Alert color="red" variant="light">{showError}</Alert>}

        {question?.key === "remove_directory" && (
          <Alert color="yellow" variant="light">
            <Text size="sm">
              This is usually leftover build output or read-only files in the worktree.
            </Text>
          </Alert>
        )}

        {gone && <Text size="xs" c="dimmed">{JOB_GONE_TEXT}</Text>}

        {running && (
          <Text size="xs" c="dimmed">This keeps running if you close this window.</Text>
        )}

        <Group justify="flex-end">
          {!job && !unknown && (
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
          {job?.state === "succeeded" && !gone && <Button onClick={() => void ok()}>OK</Button>}
          {running && <Button variant="default" onClick={close}>Close</Button>}
          {(gone || unknown) && <Button onClick={close}>Close</Button>}
        </Group>
      </Stack>
    </Modal>
  )
}
