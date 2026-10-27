import { useState } from "react"
import { Button, Tooltip } from "@mantine/core"
import type { PRCommentsSummary } from "../../api/types"
import { summaryPR } from "../../hooks/usePRWrite"
import { prUnavailableReason, submitLabel, submitTooltip } from "./prWriteCopy"
import { SubmitReviewModal } from "./SubmitReviewModal"

/**
 * "Submit review to PR #N…", which opens the submit dialog. Hidden without a
 * PR; with one it can't reach (the watcher off, no token, an error), it stays
 * on screen, disabled, with the reason as its tooltip.
 */
export function SubmitReviewButton({ path, summary }: { path: string; summary: PRCommentsSummary | undefined }) {
  const [open, setOpen] = useState(false)
  const pr = summaryPR(summary)
  if (!pr) return null
  const reason = prUnavailableReason(summary)
  const off = reason !== undefined
  return (
    <>
      {/* A disabled button gets no hover, so an off one stays enabled to events (data-disabled). */}
      <Tooltip label={reason ?? submitTooltip(pr.number)} withArrow multiline maw={320} events={{ hover: true, focus: true, touch: true }}>
        <Button
          size="compact-xs"
          variant="light"
          color="grape"
          data-disabled={off || undefined}
          aria-disabled={off}
          onClick={() => {
            if (!off) setOpen(true)
          }}
        >
          {submitLabel(pr.number)}
        </Button>
      </Tooltip>
      <SubmitReviewModal path={path} opened={open} onClose={() => setOpen(false)} />
    </>
  )
}
