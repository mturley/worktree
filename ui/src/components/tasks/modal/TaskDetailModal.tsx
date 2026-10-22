import { useEffect, useState } from "react"
import { Alert, Box, Button, Center, Flex, Loader, Modal, Stack, Tabs, Text } from "@mantine/core"
import { useQueryClient } from "@tanstack/react-query"
import { HttpError } from "../../../api/client"
import type { TaskDetail } from "../../../api/types"
import { taskDetailKey, useTaskDetail } from "../../../hooks/useTaskDetail"
import { ActivityTab } from "./ActivityTab"
import { DetailsTab } from "./DetailsTab"
import { TaskModalHeader } from "./TaskModalHeader"
import { useTaskModal } from "./TaskModalProvider"
import { TaskSidebar } from "./TaskSidebar"
import { useOptimisticTask } from "./useOptimisticTask"

/**
 * The single task detail modal, mounted once in App and driven by
 * `?task=<id>` through TaskModalProvider.
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

  return (
    <Modal
      opened={openId !== null}
      onClose={close}
      size="xl"
      withCloseButton={false}
      aria-label="Task details"
    >
      {id !== null && <TaskModalBody key={id} id={id} active={openId !== null} />}
    </Modal>
  )
}

function TaskModalBody({ id, active }: { id: number; active: boolean }) {
  const { close } = useTaskModal()
  const qc = useQueryClient()
  // Fetching stops once the modal is closing, so a deleted task's detail is
  // never asked for again; its cached copy carries the fade-out.
  const q = useTaskDetail(active ? id : undefined)
  const task = q.data ?? (active ? undefined : qc.getQueryData<TaskDetail>(taskDetailKey(id)))

  if (task) return <TaskView task={task} />
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

function TaskView({ task }: { task: TaskDetail }) {
  const { close, open, notice, clearNotice } = useTaskModal()
  const qc = useQueryClient()
  const edits = useOptimisticTask(task.id)
  const [tab, setTab] = useState<string>("details")

  const onDelete = () => {
    // Close first, then drop the cached detail and activity: the delete's
    // invalidation would otherwise refetch them (404) while still on screen.
    close()
    qc.removeQueries({ queryKey: taskDetailKey(task.id), exact: true })
    qc.removeQueries({ queryKey: ["tasks", "activity", task.id] })
    // A failed delete brings the task back, saying why.
    edits.remove().catch((e: unknown) =>
      open(task.id, { error: `Couldn't delete: ${e instanceof Error ? e.message : "the request failed"}` }),
    )
  }

  return (
    <Stack gap="sm">
      <TaskModalHeader
        task={task}
        onUpdate={edits.update}
        onState={edits.setState}
        onClose={close}
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
          <Tabs.Panel value="details" pt="sm">{tab === "details" && <DetailsTab task={task} />}</Tabs.Panel>
          <Tabs.Panel value="activity" pt="sm">{tab === "activity" && <ActivityTab task={task} />}</Tabs.Panel>
        </Tabs>
        <Box w={{ base: "100%", sm: 220 }} style={{ flex: "none" }}>
          <TaskSidebar task={task} onUpdate={edits.update} onState={edits.setState} onDelete={onDelete} />
        </Box>
      </Flex>
    </Stack>
  )
}
