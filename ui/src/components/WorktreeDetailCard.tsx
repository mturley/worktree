import { useEffect, useRef, useState, type ReactNode } from "react"
import { ActionIcon, Box, Button, Checkbox, Code, Collapse, Group, Paper, Stack, Text, Textarea, Tooltip, UnstyledButton } from "@mantine/core"
import { IconCheck, IconChevronRight, IconCopy, IconPencil, IconTrash } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useLocation } from "wouter"
import { api } from "../api/client"
import { useCmuxMatches } from "../api/cmux"
import type { GitStatus, WorktreeSummary } from "../api/types"
import { useWorktreeNotes } from "../hooks/useWorktreeNotes"
import { toggleTaskAt } from "../lib/taskList"
import { relativeTime as rel } from "../lib/relativeTime"
import { DeleteWorktreeModal } from "./DeleteWorktreeModal"
import { NotesMarkdown } from "./NotesMarkdown"

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

  // Notes are read-only until "Edit notes", so a stray click or keystroke
  // cannot change them. Collapsing ends editing: you always come back to the
  // read-only view.
  const [editing, setEditing] = useState(false)
  const doneEditing = () => {
    notes.flush()
    setEditing(false)
  }

  const toggle = (s: "env" | "notes") => {
    // Collapsing the notes (by either toggle) sends pending edits now.
    if (section === "notes") doneEditing()
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
          {hasEnv && (
            <SectionToggle
              open={section === "env"}
              onClick={() => toggle("env")}
              label={`${section === "env" ? "Hide" : "Show"} environment variables`}
            >
              {`Environment (${info.data!.env.length})`}
            </SectionToggle>
          )}
        </Group>
      </Stack>

      {/*
        The sections sit OUTSIDE the Stack, and carry their own top padding:
        a collapsed Collapse is 0px tall but would still take a Stack gap,
        leaving empty space under the toggles.
      */}

      {/*
        The same environment `worktree info` prints. Shown here because it is
        what you need when you open a terminal in this worktree, and it was
        previously only reachable from the CLI.
      */}
      {hasEnv && (
        <Collapse in={section === "env"}>
          <Stack gap={2} pt={6}>
            {info.data!.env.map((kv) => <EnvVarRow key={kv.key} name={kv.key} value={kv.value} />)}
          </Stack>
        </Collapse>
      )}

      <Collapse in={section === "notes"}>
        <Box pt={6}>
          <NotesPanel
            notes={notes}
            workspaceCount={workspaces.length}
            editing={editing}
            onEdit={() => setEditing(true)}
            onDone={doneEditing}
          />
        </Box>
      </Collapse>

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

const COPIED_FEEDBACK_MS = 1500

/** One environment variable, with a button that copies its value. */
function EnvVarRow({ name, value }: { name: string; value: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    } catch {
      // Clipboard access can be denied; the value is still selectable.
    }
  }

  return (
    <Group gap={4} wrap="nowrap" align="flex-start">
      <Text size="xs" style={{ overflowWrap: "anywhere" }}>
        <Text span c="dimmed">{name}=</Text>
        <Code>{value}</Code>
      </Text>
      <Tooltip label={copied ? "Copied" : "Copy value"}>
        <ActionIcon
          variant="subtle"
          color={copied ? "teal" : "gray"}
          size="xs"
          aria-label={`Copy ${name}`}
          onClick={copy}
          style={{ flexShrink: 0 }}
        >
          {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
        </ActionIcon>
      </Tooltip>
    </Group>
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
 * The notes, read-only (rendered as Markdown) until "Edit notes" swaps in the
 * textarea. Task checkboxes stay clickable in the read-only view — a targeted
 * edit to that one marker, saved immediately, like a GitHub description. Editing auto-saves as before; "Done editing" (or Esc) sends any
 * pending edit and returns to the read-only view.
 *
 * The cmux sync checkbox is shown only while editing, so it cannot be toggled
 * by accident either. It is offered only when exactly one cmux workspace
 * matches: with none there is nothing to write to, and with two there is no
 * right answer. If sync was turned on and the count has since changed, it
 * stays visible (so it can be turned off) with a note saying why nothing
 * syncs.
 */
function NotesPanel({ notes, workspaceCount, editing, onEdit, onDone }: {
  notes: ReturnType<typeof useWorktreeNotes>
  workspaceCount: number
  editing: boolean
  onEdit: () => void
  onDone: () => void
}) {
  if (notes.loadError) {
    return <Text size="xs" c="red">Could not load notes: {notes.loadError.message}</Text>
  }
  const showSync = editing && (workspaceCount === 1 || notes.syncCmux)
  return (
    <Stack gap={4}>
      <Group gap="xs" justify="space-between" wrap="wrap" mih={22}>
        <NotesStatus notes={notes} />
        <Group gap="sm">
          {showSync && (
            <Checkbox
              size="xs"
              label="Sync to cmux workspace description"
              checked={notes.syncCmux}
              disabled={!notes.loaded}
              onChange={(e) => notes.setSyncCmux(e.currentTarget.checked)}
            />
          )}
          {editing ? (
            <Button size="compact-xs" variant="light" leftSection={<IconCheck size={12} />} onClick={onDone}>
              Done editing
            </Button>
          ) : (
            <Button
              size="compact-xs"
              variant="subtle"
              leftSection={<IconPencil size={12} />}
              disabled={!notes.loaded}
              onClick={onEdit}
            >
              Edit notes
            </Button>
          )}
        </Group>
      </Group>
      {showSync && notes.syncCmux && workspaceCount !== 1 && (
        <Text size="xs" c="yellow">
          {workspaceCount === 0
            ? "Not syncing: this worktree has no cmux workspace."
            : `Not syncing: this worktree has ${workspaceCount} cmux workspaces.`}
        </Text>
      )}
      {editing ? (
        <Textarea
          aria-label="Worktree notes"
          placeholder="What's going on in this worktree? (Markdown)"
          size="xs"
          autosize
          minRows={3}
          autoFocus
          value={notes.notes}
          onChange={(e) => notes.setNotes(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault()
              onDone()
            }
          }}
        />
      ) : notes.notes.trim() ? (
        <NotesMarkdown
          text={notes.notes}
          onToggleTask={(offset) => notes.editNotes((text) => toggleTaskAt(text, offset))}
        />
      ) : (
        <Text size="xs" c="dimmed" fs="italic">No notes yet</Text>
      )}
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
