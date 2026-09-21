import { useEffect, useRef, useState, type ReactNode } from "react"
import { ActionIcon, Box, Button, Checkbox, Code, Collapse, Group, Paper, Stack, Text, Textarea, Tooltip, UnstyledButton } from "@mantine/core"
import { IconChevronRight, IconTrash } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useLocation } from "wouter"
import { api } from "../api/client"
import { useCmuxMatches } from "../api/cmux"
import type { GitStatus, WorktreeSummary } from "../api/types"
import { useWorktreeNotes } from "../hooks/useWorktreeNotes"
import { relativeTime as rel } from "../lib/relativeTime"
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
 * The details card under the worktree detail page's header.
 *
 * Deliberately NOT the same component as the home page's WorktreeCard. That
 * card lists the worktree's focus resources, which here would duplicate the
 * resource cards immediately below it. This one answers the questions you
 * actually have while working IN a worktree instead: what is my environment,
 * what branch am I on, is the tree dirty, when did anything last happen, and
 * what was I in the middle of (notes).
 *
 * Kept slim while collapsed: one meta line, then one row of section toggles
 * that behave like tabs — at most one section open at a time.
 */
export function WorktreeDetailCard({ w }: { w: WorktreeSummary }) {
  const info = useQuery({
    queryKey: ["worktree-info", w.path],
    queryFn: () => api.worktreeInfo(w.path),
    enabled: !!w.path,
  })
  const notes = useWorktreeNotes(w.path)
  const workspaces = useCmuxMatches(w.path)

  const [, navigate] = useLocation()
  const qc = useQueryClient()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [section, setSection] = useState<"env" | "notes" | null>(null)
  const name = w.path.split("/").filter(Boolean).pop() || w.path
  const git = info.data?.git
  const hasEnv = !!info.data && info.data.env.length > 0
  const hasNotes = notes.notes.trim() !== ""

  // Notes that exist are what you came back for, so they start open — but
  // only decided once, on load. Emptying them later must not snap them shut.
  const autoOpened = useRef(false)
  useEffect(() => {
    if (autoOpened.current || !notes.loaded) return
    autoOpened.current = true
    if (hasNotes) setSection("notes")
  }, [notes.loaded, hasNotes])

  const toggle = (s: "env" | "notes") => {
    // Collapsing the notes (by either toggle) sends pending edits now.
    if (section === "notes") notes.flush()
    setSection((cur) => (cur === s ? null : s))
  }

  return (
    <Paper p="sm" withBorder>
      <Stack gap={6}>
        {/* The worktree and cmux workspace names live in the page header;
            this card is git state, environment and notes. */}
        <Group gap="xs" wrap="nowrap" justify="space-between">
          <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
            {[w.repo, git?.branch || w.branch].filter(Boolean).join(" · ")}
            {git && (
              <>
                {" · "}
                <Text span inherit c={git.staged || git.modified || git.untracked ? "yellow" : "dimmed"}>
                  {gitSummary(git)}
                  {git.upstream ? ` · ${git.upstream}` : ""}
                </Text>
              </>
            )}
            {w.latest_event_ts ? ` · ${rel(w.latest_event_ts)}` : ""}
          </Text>
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

        {/*
          Both sections are collapsed by default (except notes that already
          have content). The environment is long absolute paths that wrap to
          several lines each and push the resource list and timeline — the
          reasons you opened the page — below the fold. You need them when
          opening a terminal, which is a deliberate act, so a deliberate click
          is the right price.
        */}
        <Group gap="md">
          {hasEnv && (
            <SectionToggle
              open={section === "env"}
              onClick={() => toggle("env")}
              label={`${section === "env" ? "Hide" : "Show"} environment variables`}
            >
              {`Environment (${info.data!.env.length})`}
            </SectionToggle>
          )}
          <SectionToggle
            open={section === "notes"}
            onClick={() => toggle("notes")}
            label={`${section === "notes" ? "Hide" : "Show"} notes${hasNotes ? " (has notes)" : ""}`}
          >
            Notes
            {hasNotes && section !== "notes" && (
              <Box
                component="span"
                data-testid="notes-dot"
                w={6}
                h={6}
                ml={4}
                display="inline-block"
                bg="blue.5"
                style={{ borderRadius: "50%", verticalAlign: "middle" }}
              />
            )}
          </SectionToggle>
        </Group>

        {/*
          The same environment `worktree info` prints. Shown here because it is
          what you need when you open a terminal in this worktree, and it was
          previously only reachable from the CLI.
        */}
        {hasEnv && (
          <Collapse in={section === "env"}>
            <Stack gap={2}>
              {info.data!.env.map((kv) => (
                <Text key={kv.key} size="xs" style={{ overflowWrap: "anywhere" }}>
                  <Text span c="dimmed">{kv.key}=</Text>
                  <Code>{kv.value}</Code>
                </Text>
              ))}
            </Stack>
          </Collapse>
        )}

        <Collapse in={section === "notes"}>
          <NotesPanel notes={notes} workspaceCount={workspaces.length} />
        </Collapse>
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

function SectionToggle({ open, onClick, label, children }: {
  open: boolean
  onClick: () => void
  label: string
  children: ReactNode
}) {
  return (
    <UnstyledButton onClick={onClick} aria-expanded={open} aria-label={label}>
      <Group gap={4} wrap="nowrap">
        <IconChevronRight
          size={12}
          style={{
            transform: open ? "rotate(90deg)" : undefined,
            transition: "transform 150ms ease",
          }}
        />
        <Text size="xs" c="dimmed">{children}</Text>
      </Group>
    </UnstyledButton>
  )
}

/**
 * The notes textarea with its save status, and the opt-in mirror to the cmux
 * workspace description.
 *
 * The sync checkbox is offered only when exactly one cmux workspace matches:
 * with none there is nothing to write to, and with two there is no right
 * answer. If sync was turned on and the count has since changed, it stays
 * visible (so it can be turned off) with a note saying why nothing syncs.
 */
function NotesPanel({ notes, workspaceCount }: {
  notes: ReturnType<typeof useWorktreeNotes>
  workspaceCount: number
}) {
  if (notes.loadError) {
    return <Text size="xs" c="red">Could not load notes: {notes.loadError.message}</Text>
  }
  const showSync = workspaceCount === 1 || notes.syncCmux
  return (
    <Stack gap={4}>
      <Group gap="xs" justify="space-between" wrap="wrap" mih={22}>
        <NotesStatus notes={notes} />
        {showSync && (
          <Checkbox
            size="xs"
            label="Sync to cmux workspace description"
            checked={notes.syncCmux}
            disabled={!notes.loaded}
            onChange={(e) => notes.setSyncCmux(e.currentTarget.checked)}
          />
        )}
      </Group>
      {notes.syncCmux && workspaceCount !== 1 && (
        <Text size="xs" c="yellow">
          {workspaceCount === 0
            ? "Not syncing: this worktree has no cmux workspace."
            : `Not syncing: this worktree has ${workspaceCount} cmux workspaces.`}
        </Text>
      )}
      <Textarea
        aria-label="Worktree notes"
        placeholder="What's going on in this worktree?"
        size="xs"
        autosize
        minRows={3}
        value={notes.notes}
        disabled={!notes.loaded}
        onChange={(e) => notes.setNotes(e.currentTarget.value)}
      />
    </Stack>
  )
}

function NotesStatus({ notes }: { notes: ReturnType<typeof useWorktreeNotes> }) {
  const retry = (
    <Button size="compact-xs" variant="light" onClick={notes.retry}>
      Retry
    </Button>
  )
  switch (notes.status) {
    case "unsaved":
      return <Text size="xs" c="dimmed">Unsaved changes</Text>
    case "saving":
      return <Text size="xs" c="dimmed">Saving…</Text>
    case "error":
      return (
        <Group gap="xs">
          <Text size="xs" c="red">Save failed{notes.error ? `: ${notes.error}` : ""}</Text>
          {retry}
        </Group>
      )
    case "saved":
      if (notes.cmux?.outcome === "failed") {
        return (
          <Group gap="xs">
            <Tooltip label={notes.cmux.error} disabled={!notes.cmux.error}>
              <Text size="xs" c="yellow">Saved · cmux sync failed</Text>
            </Tooltip>
            {retry}
          </Group>
        )
      }
      return (
        <Text size="xs" c="dimmed">
          {notes.cmux?.outcome === "ok" ? "Saved · synced to cmux" : "Saved"}
        </Text>
      )
    default:
      return (
        <Text size="xs" c="dimmed">
          {notes.updatedAt ? `Saved ${rel(notes.updatedAt)}` : ""}
        </Text>
      )
  }
}
