import { useState } from "react"
import { ActionIcon, Tooltip } from "@mantine/core"
import { IconTrash } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useLocation } from "wouter"
import { api } from "../api/client"
import type { WorktreeSummary } from "../api/types"
import { DeleteWorktreeModal } from "./DeleteWorktreeModal"

/**
 * The worktree details card's delete control: a trash icon that opens
 * DeleteWorktreeModal, then returns to the list once the worktree is gone.
 */
export function DeleteWorktreeButton({ w }: { w: WorktreeSummary }) {
  // Same query key as the details card, so this shares its fetch rather than
  // adding one. The live branch beats the summary's when it has loaded.
  const info = useQuery({
    queryKey: ["worktree-info", w.path],
    queryFn: () => api.worktreeInfo(w.path),
    enabled: !!w.path,
  })
  const [, navigate] = useLocation()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const name = w.path.split("/").filter(Boolean).pop() || w.path

  return (
    <>
      <Tooltip label="Delete worktree">
        <ActionIcon variant="subtle" color="red" aria-label="Delete worktree" onClick={() => setOpen(true)}>
          <IconTrash size={16} />
        </ActionIcon>
      </Tooltip>
      {open && (
        <DeleteWorktreeModal
          opened
          path={w.path}
          name={name}
          branch={info.data?.git?.branch || w.branch}
          onClose={() => setOpen(false)}
          onDeleted={() => {
            setOpen(false)
            // The worktree is gone; the list is the only place left to be.
            void qc.invalidateQueries({ queryKey: ["worktrees"] })
            // Its tasks lose their worktree link.
            void qc.invalidateQueries({ queryKey: ["tasks"] })
            navigate("/")
          }}
        />
      )}
    </>
  )
}
