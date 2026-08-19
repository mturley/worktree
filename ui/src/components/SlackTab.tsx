import { useEffect, useState } from "react"
import { ActionIcon, Alert, Button, Code, Grid, Group, Modal, NavLink, Stack, Text, TextInput } from "@mantine/core"
import { useWorktreeSlackThreads, type SlackThreadRef } from "../hooks/useWorktreeSlackThreads"
import { useThread } from "../hooks/useThread"
import { ThreadView } from "./slack/ThreadView"
import { defaultTabName, type Tab } from "../state/tabs"
import { api } from "../api/client"

interface SlackTabProps {
  path: string
}

function threadRefToTab(ref: SlackThreadRef): Tab {
  return {
    id: ref.id,
    channel: ref.channel,
    threadTs: ref.threadTs,
    name: ref.customName || defaultTabName(ref.channel, ref.threadTs),
    description: ref.customDescription || "",
  }
}

/**
 * True when a thread fetch failed because Slack isn't configured (the backend
 * returns 503 "slack not configured"). Distinguishes the "run setup" case
 * from a real per-thread load error so we can show a friendlier notice.
 */
function isNotConfigured(error: string | undefined): boolean {
  return !!error && error.includes("503")
}

export function SlackTab({ path }: SlackTabProps) {
  const { threads, refetch } = useWorktreeSlackThreads(path)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Surfaces a failed "save thread details" write so a rejected setResourceMeta
  // isn't silently swallowed (the modal closes on submit) and mistaken for success.
  const [saveError, setSaveError] = useState<string | null>(null)
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [addUrl, setAddUrl] = useState("")
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  // Default the selection to the first thread, and keep it valid if the set
  // of threads changes (e.g. a resource is added/removed out from under us).
  useEffect(() => {
    if (threads.length === 0) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (!selectedId || !threads.some((t) => t.id === selectedId)) {
      setSelectedId(threads[0].id)
    }
  }, [threads, selectedId])

  const selected = threads.find((t) => t.id === selectedId) ?? null
  const tab = selected ? threadRefToTab(selected) : null
  // useThread short-circuits on a null tab, so calling it unconditionally
  // keeps hook order stable across the empty/selected states.
  const thread = useThread(tab)

  const closeAddModal = () => {
    setAddModalOpen(false)
    setAddUrl("")
    setAddError(null)
  }

  const handleAddSubmit = async () => {
    if (!addUrl.trim()) return
    setAdding(true)
    setAddError(null)
    try {
      await api.addResource({ path, url: addUrl.trim() })
      await refetch()
      closeAddModal()
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e))
    } finally {
      setAdding(false)
    }
  }

  const addModal = (
    <Modal opened={addModalOpen} onClose={closeAddModal} title="Add Slack thread">
      <Stack gap="sm">
        {addError ? (
          <Alert color="red" variant="light" title="Couldn't add thread" withCloseButton onClose={() => setAddError(null)}>
            <Text size="sm">{addError}</Text>
          </Alert>
        ) : null}
        <TextInput
          label="Paste a Slack thread URL"
          value={addUrl}
          onChange={(e) => setAddUrl(e.currentTarget.value)}
          data-autofocus
        />
        <Group justify="flex-end">
          <Button onClick={handleAddSubmit} loading={adding} disabled={!addUrl.trim()}>
            Add
          </Button>
        </Group>
      </Stack>
    </Modal>
  )

  if (threads.length === 0) {
    return (
      <>
        {addModal}
        <Alert
          color="gray"
          variant="light"
          title="No Slack threads"
          icon={
            <ActionIcon aria-label="Add Slack thread" variant="light" size="sm" onClick={() => setAddModalOpen(true)}>
              +
            </ActionIcon>
          }
        >
          <Text size="sm">
            No Slack threads. Add one with <Code>worktree add &lt;slack-thread-url&gt;</Code>, or use the{" "}
            <Text span fw={700}>
              +
            </Text>{" "}
            button.
          </Text>
        </Alert>
      </>
    )
  }

  return (
    <Grid gutter="md">
      {addModal}
      <Grid.Col span={{ base: 12, sm: 4 }}>
        <Group justify="space-between" mb={4}>
          <Text size="sm" fw={500} c="dimmed">
            Threads
          </Text>
          <ActionIcon aria-label="Add Slack thread" variant="light" size="sm" onClick={() => setAddModalOpen(true)}>
            +
          </ActionIcon>
        </Group>
        <Stack gap={2}>
          {threads.map((t) => (
            <NavLink
              key={t.id}
              active={t.id === selectedId}
              label={threadRefToTab(t).name}
              onClick={() => setSelectedId(t.id)}
              styles={{ label: { wordBreak: "break-all" } }}
            />
          ))}
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, sm: 8 }}>
        {saveError ? (
          <Alert
            color="red"
            variant="light"
            title="Couldn't save thread details"
            withCloseButton
            onClose={() => setSaveError(null)}
            mb="sm"
          >
            <Text size="sm">{saveError}</Text>
          </Alert>
        ) : null}
        {isNotConfigured(thread.error) ? (
          <Alert color="yellow" variant="light" title="Slack not configured">
            <Text size="sm">
              Run <Code>worktree setup</Code> to enable Slack.
            </Text>
          </Alert>
        ) : tab ? (
          <ThreadView
            tab={tab}
            thread={thread}
            onUpdateTab={async (id, updates) => {
              // The modal closes itself on submit, so a rejected write would
              // vanish silently and look like success. Catch it and surface an
              // inline error instead.
              try {
                setSaveError(null)
                await api.setResourceMeta({
                  type: "slack",
                  id,
                  name: updates.name,
                  description: updates.description,
                })
                await refetch()
              } catch (e) {
                setSaveError(e instanceof Error ? e.message : String(e))
              }
            }}
            onOpenThread={(url, opts) => {
              window.open(url, opts.background ? "_blank" : "_self", "noreferrer")
            }}
          />
        ) : null}
      </Grid.Col>
    </Grid>
  )
}
