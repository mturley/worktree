import { closeJobModal, getJob, useJobs, useOpenJobId } from "../../lib/jobsStore"
import { DeleteWorktreeModal } from "../DeleteWorktreeModal"
import { NewWorktreeModal } from "../NewWorktreeModal"

/** Opens the modal for the job a toast asked about. */
export function JobModalHost() {
  const id = useOpenJobId()
  // Re-render when the job arrives, changes or leaves the store.
  useJobs()
  if (id === undefined) return null
  const job = getJob(id)
  if (!job) return null
  if (job.kind === "worktree_delete") {
    return <DeleteWorktreeModal opened jobId={id} onClose={closeJobModal} onDeleted={closeJobModal} />
  }
  return <NewWorktreeModal opened jobId={id} onClose={closeJobModal} />
}
