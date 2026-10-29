import { ActionIcon, Tooltip } from "@mantine/core"
import { IconArrowRight } from "@tabler/icons-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"

/** Switches cmux to a workspace by ref, then refreshes the shared cmux query. */
export function useCmuxSelect() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ref: string) => api.cmuxSelect(ref),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cmux"] }),
  })
}

/**
 * A small arrow that switches cmux to the workspace `wsRef`. Its click stays
 * its own: it sits in hover cards whose target (a task row) opens a modal on
 * click. A failed switch shows its error in the tooltip.
 */
export function CmuxSwitchButton({ wsRef, title }: { wsRef: string; title: string }) {
  const select = useCmuxSelect()
  const label = `Switch cmux to ${title}`
  const failure = select.isError ? select.error.message : select.data && !select.data.ok ? select.data.error : undefined
  return (
    <Tooltip label={failure ?? label} color={failure ? "red" : undefined}>
      <ActionIcon
        size="xs"
        variant="subtle"
        aria-label={label}
        loading={select.isPending}
        color={failure ? "red" : undefined}
        onClick={(e) => {
          e.stopPropagation()
          select.mutate(wsRef)
        }}
      >
        <IconArrowRight size={14} />
      </ActionIcon>
    </Tooltip>
  )
}
