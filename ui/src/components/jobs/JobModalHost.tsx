import { useQueryClient } from "@tanstack/react-query"
import { useLocation } from "wouter"
import { closeJobModal, useOpenJobModal } from "../../lib/jobsStore"
import { DeleteWorktreeModal } from "../DeleteWorktreeModal"
import { NewWorktreeModal } from "../NewWorktreeModal"

/** The worktree a /worktree/… route is showing, if it is showing one. */
function routedWorktree(location: string): string | undefined {
  const prefix = "/worktree/"
  if (!location.startsWith(prefix)) return undefined
  try {
    return decodeURIComponent(location.slice(prefix.length))
  } catch {
    return undefined // a malformed escape in the URL names no worktree
  }
}

/**
 * Every job modal is mounted here, at the root, rather than beside the control
 * that started the job: a delete removes the worktree its own page is built
 * from, so a modal living on that page would be torn down at the very moment
 * it has something to report.
 *
 * Which modal to show was settled by openJobModal, so the job leaving the
 * store — the server's ten-second expiry, another tab dismissing it — does not
 * close it either. Only closeJobModal does.
 */
export function JobModalHost() {
  const open = useOpenJobModal()
  const [location, navigate] = useLocation()
  const qc = useQueryClient()
  if (open === undefined) return null

  if (open.kind === "worktree_delete") {
    const onDeleted = () => {
      closeJobModal()
      // The worktree is gone: its tasks lose their link to it, and its own
      // page has nothing left to show.
      void qc.invalidateQueries({ queryKey: ["tasks"] })
      if (routedWorktree(location) === open.target) navigate("/")
    }
    return (
      <DeleteWorktreeModal
        opened
        jobId={open.id}
        initialJob={open}
        onClose={closeJobModal}
        onDeleted={onDeleted}
      />
    )
  }
  if (open.kind === "worktree_create") {
    return <NewWorktreeModal opened jobId={open.id} initialJob={open} onClose={closeJobModal} />
  }
  // A kind this build has no modal for: its toast still shows it.
  return null
}
