import { useState } from "react"
import { useLocation } from "wouter"
import { Affix, ActionIcon, Button, Group, Loader, Paper, Stack, Text } from "@mantine/core"
import { IconChevronDown, IconChevronUp, IconX } from "@tabler/icons-react"
import { api } from "../../api/client"
import type { Job } from "../../api/types"
import {
  currentStep, isFinished, openJobModal, useAttachedJobIds, useJobs,
} from "../../lib/jobsStore"
import { JobStepper } from "./JobStepper"

const HEADLINES: Record<string, string> = {
  reuse_branch: "reuse existing branch?",
  reset_to_pr: "reset to the PR's latest?",
  remove_directory: "force-remove the directory?",
  delete_branch: "force-delete the branch?",
}

const collapsedKey = (id: string) => `worktree.jobs.collapsed.${id}`

function readCollapsed(id: string): boolean {
  try {
    return localStorage.getItem(collapsedKey(id)) === "1"
  } catch {
    return false
  }
}

function writeCollapsed(id: string, collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(collapsedKey(id), "1")
    else localStorage.removeItem(collapsedKey(id))
  } catch {
    // Storage unavailable: the toast just starts expanded next time.
  }
}

/** The line under the steps for states that need one; undefined for none. */
function stateLine(job: Job): { text: string; color: string } | undefined {
  switch (job.state) {
    case "needs_answer": {
      const key = job.question?.key
      const headline = key === undefined ? undefined : HEADLINES[key]
      return { text: `Needs your answer: ${headline ?? "a question"}`, color: "yellow" }
    }
    case "failed": {
      const shown = job.steps.some((s) => s.status === "failed" && s.detail)
      return job.error && !shown ? { text: job.error, color: "red" } : undefined
    }
    case "interrupted":
      return { text: "Interrupted: the server stopped", color: "red" }
    default:
      return undefined
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function JobToast({ job }: { job: Job }) {
  const [, navigate] = useLocation()
  const [collapsed, setCollapsed] = useState(() => readCollapsed(job.id))
  const [error, setError] = useState<string | undefined>()
  const finished = isFinished(job)
  const line = stateLine(job)
  const clickable = job.state === "needs_answer"

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    writeCollapsed(job.id, next)
  }
  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const resultPath = job.state === "succeeded" && job.kind === "worktree_create"
    ? job.result?.path : undefined
  const summary = currentStep(job)?.label ?? line?.text

  return (
    <Paper
      withBorder
      shadow="md"
      p="sm"
      w={340}
      role="status"
      aria-label={job.title}
      onClick={clickable ? () => openJobModal(job.id) : undefined}
      style={clickable ? { cursor: "pointer" } : undefined}
    >
      <Stack gap={6}>
        <Group gap={8} wrap="nowrap" justify="space-between">
          <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
            {job.state === "running" && <Loader size={14} />}
            <Text size="sm" fw={600} truncate>{job.title}</Text>
          </Group>
          <Group gap={4} wrap="nowrap">
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label={collapsed ? "Expand" : "Collapse"}
              onClick={(e) => { e.stopPropagation(); toggle() }}
            >
              {collapsed ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
            </ActionIcon>
            {finished && (
              <ActionIcon
                variant="subtle"
                size="sm"
                aria-label="Dismiss"
                onClick={(e) => { e.stopPropagation(); void run(() => api.jobDismiss(job.id)) }}
              >
                <IconX size={14} />
              </ActionIcon>
            )}
          </Group>
        </Group>
        {collapsed ? (
          summary !== undefined && <Text size="xs" c="dimmed">{summary}</Text>
        ) : (
          <>
            <JobStepper steps={job.steps} />
            {line && <Text size="xs" c={line.color}>{line.text}</Text>}
            {resultPath !== undefined && (
              <Group>
                <Button
                  size="compact-xs"
                  onClick={(e) => {
                    e.stopPropagation()
                    void run(async () => {
                      navigate(`/worktree/${encodeURIComponent(resultPath)}`)
                      await api.jobDismiss(job.id)
                    })
                  }}
                >
                  Open worktree
                </Button>
              </Group>
            )}
            {(job.state === "failed" || job.state === "interrupted") && (
              <Group>
                <Button
                  size="compact-xs"
                  variant="light"
                  onClick={(e) => { e.stopPropagation(); void run(() => api.jobRetry(job.id)) }}
                >
                  Run again
                </Button>
              </Group>
            )}
          </>
        )}
        {error !== undefined && <Text size="xs" c="red">{error}</Text>}
      </Stack>
    </Paper>
  )
}

/** Every ongoing job, bottom-right, in every tab. Below Mantine's modals (200). */
export function JobToasts() {
  const jobs = useJobs()
  const attached = useAttachedJobIds()
  const shown = jobs.filter((j) => !attached.has(j.id))
  if (shown.length === 0) return null
  return (
    <Affix position={{ bottom: 16, right: 16 }} zIndex={150}>
      <Stack gap="xs">
        {shown.map((j) => <JobToast key={j.id} job={j} />)}
      </Stack>
    </Affix>
  )
}
