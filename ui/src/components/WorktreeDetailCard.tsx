import { useState } from "react"
import { ActionIcon, Badge, Code, Group, Paper, Stack, Text, Tooltip } from "@mantine/core"
import { IconTrash } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useLocation } from "wouter"
import { api } from "../api/client"
import type { GitStatus, WorktreeSummary } from "../api/types"
import { relativeTime as rel } from "../lib/relativeTime"
import { CmuxWorkspaceSection } from "./CmuxWorkspaceSection"
import { DeleteWorktreeModal } from "./DeleteWorktreeModal"

/**
 * Renders a git status as a short line: "3 modified · 1 untracked · ahead 2",
 * or "clean" when the working tree has nothing outstanding.
 *
 * Ahead/behind are reported even when clean, because a branch with unpushed
 * commits is not the same situation as one in sync — a single "dirty" flag
 * would hide that.
 */
function gitSummary(g: GitStatus): string {
  const parts: string[] = []
  if (g.staged) parts.push(`${g.staged} staged`)
  if (g.modified) parts.push(`${g.modified} modified`)
  if (g.untracked) parts.push(`${g.untracked} untracked`)
  if (parts.length === 0) parts.push("clean")
  if (g.ahead) parts.push(`ahead ${g.ahead}`)
  if (g.behind) parts.push(`behind ${g.behind}`)
  return parts.join(" · ")
}

/**
 * The header card on the worktree detail page.
 *
 * Deliberately NOT the same component as the home page's WorktreeCard. That
 * card lists the worktree's focus resources, which here would duplicate the
 * resource cards immediately below it. This one answers the questions you
 * actually have while working IN a worktree instead: what is my environment,
 * what branch am I on, is the tree dirty, when did anything last happen.
 */
export function WorktreeDetailCard({ w }: { w: WorktreeSummary }) {
  const info = useQuery({
    queryKey: ["worktree-info", w.path],
    queryFn: () => api.worktreeInfo(w.path),
    enabled: !!w.path,
  })

  const [, navigate] = useLocation()
  const qc = useQueryClient()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const name = w.path.split("/").filter(Boolean).pop() || w.path
  const git = info.data?.git

  return (
    <Paper p="sm" withBorder>
      <Stack gap={8}>
        <CmuxWorkspaceSection path={w.path} branch={git?.branch || w.branch} />
        <Group gap="xs" wrap="nowrap" justify="space-between">
          <Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
            <Text fw={700} size="md" style={{ overflowWrap: "anywhere" }}>{name}</Text>
            {!w.on_disk && <Badge size="xs" color="red">missing</Badge>}
          </Group>
          <Tooltip label="Delete worktree">
            <ActionIcon
              variant="subtle"
              color="red"
              size="sm"
              aria-label="Delete worktree"
              onClick={() => setDeleteOpen(true)}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>

        <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
          {[
            w.repo,
            git?.branch || w.branch,
            w.latest_event_ts ? rel(w.latest_event_ts) : "",
          ].filter(Boolean).join(" · ")}
        </Text>

        {git && (
          <Text size="xs" c={git.staged || git.modified || git.untracked ? "yellow" : "dimmed"}>
            {gitSummary(git)}
            {git.upstream ? ` · ${git.upstream}` : ""}
          </Text>
        )}

        {/*
          The same environment `worktree info` prints. Shown here because it is
          what you need when you open a terminal in this worktree, and it was
          previously only reachable from the CLI.
        */}
        {info.data && info.data.env.length > 0 && (
          <Stack gap={2}>
            {info.data.env.map((kv) => (
              <Text key={kv.key} size="xs" style={{ overflowWrap: "anywhere" }}>
                <Text span c="dimmed">{kv.key}=</Text>
                <Code>{kv.value}</Code>
              </Text>
            ))}
          </Stack>
        )}
      </Stack>

      {deleteOpen && (
        <DeleteWorktreeModal
          opened
          path={w.path}
          name={name}
          branch={git?.branch || w.branch}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => {
            setDeleteOpen(false)
            // The worktree is gone; the list is the only place left to be.
            void qc.invalidateQueries({ queryKey: ["worktrees"] })
            navigate("/")
          }}
        />
      )}
    </Paper>
  )
}
