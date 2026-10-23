import { useCallback, useEffect, useState } from "react"
import { Alert, Box, Button, Center, Flex, Loader, Modal, Stack, Tabs, Text } from "@mantine/core"
import { useQueryClient } from "@tanstack/react-query"
import { HttpError } from "../../../api/client"
import type { TaskDetail, TaskState } from "../../../api/types"
import { taskDetailKey, useTaskDetail } from "../../../hooks/useTaskDetail"
import { taskUndoMessage, useOfferTaskUndo } from "../taskUndo"
import { ActivityTab } from "./ActivityTab"
import { discardDescriptionDraft } from "./DescriptionSection"
import { DetailsTab } from "./DetailsTab"
import { TaskModalHeader } from "./TaskModalHeader"
import { useTaskModal } from "./TaskModalProvider"
import { TaskSidebar } from "./TaskSidebar"
import { useOptimisticTask } from "./useOptimisticTask"

/**
 * The single task detail modal, mounted once in App and driven by
 * `?task=<id>` through TaskModalProvider.
 *
 * It is labelled by the title in its header: TaskModalHeader renders it as
 * Modal.Title, which is what Mantine points the dialog's aria-labelledby at.
 *
 * While the description has unsaved edits, an outside click does nothing,
 * and the close button or Esc asks before discarding them. The browser's
 * Back button can't be stopped in an SPA: it closes the modal regardless,
 * and the draft, which DescriptionSection keeps in sessionStorage, comes
 * back when the task is opened again.
 */
export function TaskDetailModal() {
  const { openId, close } = useTaskModal()
  // The last opened id outlives the param by the close transition, so the
  // content fades out instead of blanking first.
  const [shownId, setShownId] = useState<number | null>(openId)
  useEffect(() => {
    if (openId !== null) setShownId(openId)
  }, [openId])
  const id = openId ?? shownId
  // Which task's description is dirty. Keyed by task so switching tasks
  // can't carry it over; each task's DescriptionSection reports on mount.
  const [dirtyId, setDirtyId] = useState<number | null>(null)
  const dirty = id !== null && dirtyId === id
  const setDirty = useCallback(
    (taskId: number, d: boolean) => setDirtyId((cur) => (d ? taskId : cur === taskId ? null : cur)),
    [],
  )

  const guardedClose = useCallback(() => {
    if (dirty && id !== null) {
      if (!window.confirm("Discard unsaved description?")) return
      discardDescriptionDraft(id)
      setDirty(id, false)
    }
    close()
  }, [dirty, id, close, setDirty])

  return (
    <Modal
      opened={openId !== null}
      onClose={guardedClose}
      closeOnClickOutside={!dirty}
      size="xl"
      withCloseButton={false}
    >
      {id !== null && (
        <TaskModalBody key={id} id={id} active={openId !== null} onClose={guardedClose} onDirtyChange={setDirty} />
      )}
    </Modal>
  )
}

interface BodyProps {
  id: number
  active: boolean
  /** Closes the modal, asking first while the description has unsaved edits. */
  onClose: () => void
  onDirtyChange: (taskId: number, dirty: boolean) => void
}

function TaskModalBody({ id, active, onClose, onDirtyChange }: BodyProps) {
  const onDirty = useCallback((d: boolean) => onDirtyChange(id, d), [id, onDirtyChange])
  const { close } = useTaskModal()
  const qc = useQueryClient()
  // Fetching stops once the modal is closing, so a deleted task's detail is
  // never asked for again; its cached copy carries the fade-out.
  const q = useTaskDetail(active ? id : undefined)
  const task = q.data ?? (active ? undefined : qc.getQueryData<TaskDetail>(taskDetailKey(id)))

  if (task) return <TaskView task={task} onClose={onClose} onDirtyChange={onDirty} />
  if (!active) return null
  if (q.isPending) {
    return <Center py="xl"><Loader size="sm" /></Center>
  }
  const missing = q.error instanceof HttpError && q.error.status === 404
  return (
    <Stack align="center" py="lg" gap="sm">
      <Text fw={600}>{missing ? "Task not found" : "Couldn't load the task"}</Text>
      {!missing && q.error instanceof Error && <Text size="sm" c="dimmed">{q.error.message}</Text>}
      <Button variant="default" onClick={close}>Close</Button>
    </Stack>
  )
}

function TaskView({ task, onClose, onDirtyChange }: {
  task: TaskDetail
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const { close, open, notice, clearNotice } = useTaskModal()
  const qc = useQueryClient()
  const edits = useOptimisticTask(task.id)
  const [tab, setTab] = useState<string>("details")
  const offerUndo = useOfferTaskUndo()

  // Header and sidebar both change state through here, so both offer the undo.
  const onState = (s: TaskState) => {
    const title = task.title
    void edits.setState(s).then((t) => offerUndo(t?.undo_event_id, taskUndoMessage.state(title, s)))
  }

  const onDelete = () => {
    const { id, title } = task
    // Close first, then drop the cached detail and activity: the delete's
    // invalidation would otherwise refetch them (404) while still on screen.
    // A deleted task's unsaved description goes with it, unasked.
    discardDescriptionDraft(id)
    onDirtyChange(false)
    close()
    qc.removeQueries({ queryKey: taskDetailKey(id), exact: true })
    qc.removeQueries({ queryKey: ["tasks", "activity", id] })
    // One click, no confirmation: the undo toast is the way back, and
    // undoing reopens the modal the delete closed. A failed delete brings
    // the task back, saying why.
    edits.remove().then(
      (r) => offerUndo(r.undo_event_id, taskUndoMessage.deleted(title), () => open(id)),
      (e: unknown) => open(id, { error: `Couldn't delete: ${e instanceof Error ? e.message : "the request failed"}` }),
    )
  }

  return (
    <Stack gap="sm">
      <TaskModalHeader
        task={task}
        onUpdate={edits.update}
        onState={onState}
        onClose={onClose}
      />
      {edits.error ? (
        <Alert color="red" withCloseButton onClose={edits.clearError} py={6}>
          Couldn't save: {edits.error}
        </Alert>
      ) : notice ? (
        <Alert color="red" withCloseButton onClose={clearNotice} py={6}>
          {notice}
        </Alert>
      ) : null}
      <Flex gap="lg" direction={{ base: "column", sm: "row" }} align="flex-start">
        <Tabs value={tab} onChange={(v) => v && setTab(v)} style={{ flex: 1, minWidth: 0, width: "100%" }}>
          <Tabs.List>
            <Tabs.Tab value="details">Details</Tabs.Tab>
            <Tabs.Tab value="activity">Activity</Tabs.Tab>
          </Tabs.List>
          {/* Only the active tab mounts, so Activity fetches only when shown. */}
          <Tabs.Panel value="details" pt="sm">{tab === "details" && <DetailsTab task={task} onDescriptionDirty={onDirtyChange} />}</Tabs.Panel>
          <Tabs.Panel value="activity" pt="sm">{tab === "activity" && <ActivityTab task={task} />}</Tabs.Panel>
        </Tabs>
        <Box w={{ base: "100%", sm: 220 }} style={{ flex: "none" }}>
          <TaskSidebar task={task} onUpdate={edits.update} onState={onState} onDelete={onDelete} />
        </Box>
      </Flex>
    </Stack>
  )
}
