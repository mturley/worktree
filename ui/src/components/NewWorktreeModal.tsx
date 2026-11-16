import {
  Alert, Button, Checkbox, Divider, Group, Modal, Select, Stack, Text, TextInput, Tooltip,
} from "@mantine/core"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useDebouncedValue } from "@mantine/hooks"
import { useEffect, useState } from "react"
import { useUnsavedChanges } from "../lib/unsavedChanges"
import { useLocation } from "wouter"
import { api } from "../api/client"
import { useCmux } from "../api/cmux"
import { isFinished } from "../lib/jobsStore"
import { JobStepper } from "./jobs/JobStepper"
import { useModalJob } from "./jobs/useModalJob"

/**
 * Create a worktree, taking the same inputs as `worktree add`.
 *
 * The create runs as a background job on the server, which also opens the cmux
 * workspace as its last step; this modal renders the job from the jobs store,
 * so closing it stops nothing. A confirmation parks the job with a question
 * that is answered in place.
 */
export function NewWorktreeModal({ opened, jobId: initialJobId, onClose }: {
  opened: boolean
  /** Open on this existing job, skipping the form. */
  jobId?: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  const cmux = useCmux()

  const [input, setInput] = useState("")
  const [repoRoot, setRepoRoot] = useState<string | null>(null)
  const [pull, setPull] = useState(true)
  const [copyDotfiles, setCopyDotfiles] = useState(false)
  // null until the user edits the branch name; until then the field shows the
  // server's default for the input.
  const [branchEdit, setBranchEdit] = useState<string | null>(null)
  const [wsName, setWsName] = useState("")
  const [wsGroup, setWsGroup] = useState<string | null>(null)
  const [wsColor, setWsColor] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const { jobId, job, busy, error, setError, track, act, dismissFinished } =
    useModalJob(opened, initialJobId)
  // Once a job exists the form is moot: the work carries on server-side.
  useUnsavedChanges(
    opened && jobId === undefined
      && (input.trim() !== "" || wsName.trim() !== "" || branchEdit !== null),
  )
  const [debouncedInput] = useDebouncedValue(input.trim(), 300)

  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api.repos(), enabled: opened })
  const dotfiles = useQuery({
    queryKey: ["repo-dotfiles", repoRoot],
    queryFn: () => api.repoDotfiles(repoRoot!),
    enabled: opened && !!repoRoot,
  })
  // A PR's default needs its title from GitHub, hence the debounce.
  const defaultBranch = useQuery({
    queryKey: ["default-branch", debouncedInput, repoRoot],
    queryFn: () => api.defaultBranch(debouncedInput, repoRoot!),
    enabled: opened && !!debouncedInput && !!repoRoot,
  })
  // A plain branch name has no default: the input already is the branch.
  const branchDefault = debouncedInput === input.trim() ? defaultBranch.data?.branch ?? "" : ""
  const branch = branchEdit ?? branchDefault
  const asksBranch = branchDefault !== "" || branchEdit !== null

  // An edit belongs to the input it was made for.
  useEffect(() => { setBranchEdit(null) }, [input, repoRoot])

  const cmuxMeta = useQuery({
    queryKey: ["cmux-groups"],
    queryFn: () => api.cmuxGroups(),
    enabled: opened && !!cmux.data?.available,
  })

  // Reset on open, and default to the most recent repo (the list is already
  // sorted newest-first by the server).
  useEffect(() => {
    if (!opened) return
    setInput(""); setPull(true); setCopyDotfiles(false)
    setStarting(false)
    setWsName(""); setWsGroup(null); setWsColor(null)
  }, [opened])

  useEffect(() => {
    if (opened && repos.data?.length && !repoRoot) setRepoRoot(repos.data[0].repo_root)
  }, [opened, repos.data, repoRoot])

  const start = async () => {
    if (!repoRoot) return
    const workspaceName = cmux.data?.available ? wsName.trim() : ""
    setStarting(true)
    setError(null)
    try {
      const res = await api.createWorktree({
        input: input.trim(),
        repo_root: repoRoot,
        pull,
        copy_dotfiles: copyDotfiles,
        branch: asksBranch && branch.trim() ? branch.trim() : undefined,
        workspace_name: workspaceName || undefined,
        workspace_group_ref: workspaceName ? wsGroup ?? undefined : undefined,
        workspace_color: workspaceName ? wsColor ?? undefined : undefined,
      })
      track(res.job)
      void qc.invalidateQueries({ queryKey: ["worktrees"] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  const close = () => {
    if (job && isFinished(job)) void dismissFinished()
    onClose()
  }

  // OK on a success: acknowledge, close and open the new worktree.
  const ok = async () => {
    const path = job?.result?.path
    await dismissFinished()
    void qc.invalidateQueries({ queryKey: ["worktrees"] })
    void qc.invalidateQueries({ queryKey: ["cmux"] })
    onClose()
    if (job?.state === "succeeded" && path !== undefined) {
      navigate(`/worktree/${encodeURIComponent(path)}`)
    }
  }

  // Declining the branch reuse ends (and dismisses) the job on the server, so
  // the modal closes. Declining the PR reset keeps the current commit and the
  // job carries on to completion, so the modal stays to show that.
  const decline = async () => {
    const reuse = job?.question?.key === "reuse_branch"
    if (!(await act((id) => api.jobAnswer(id, "no")))) return
    if (reuse) onClose()
  }

  const question = job?.state === "needs_answer" ? job.question : null
  const failed = job?.state === "failed" || job?.state === "interrupted"
  const locked = starting
  const showForm = !job

  return (
    <Modal opened={opened} onClose={close} title={job ? job.title : "New worktree"} centered>
      <Stack gap="sm">
        {showForm && (<>
        <TextInput
          label="Branch, PR, or issue"
          description="A branch name, PR number or URL, or a Jira issue URL"
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          disabled={locked}
        />
        {asksBranch && (
          <TextInput
            label="Branch name"
            value={branch}
            onChange={(e) => setBranchEdit(e.currentTarget.value)}
            disabled={locked}
          />
        )}
        <Select
          label="Repo"
          value={repoRoot}
          onChange={setRepoRoot}
          disabled={locked}
          data={(repos.data ?? []).map((r) => ({ value: r.repo_root, label: r.name }))}
        />
        <Checkbox
          label="git pull first"
          checked={pull}
          onChange={(e) => setPull(e.currentTarget.checked)}
          disabled={locked}
        />
        {(dotfiles.data?.length ?? 0) > 0 && (
          <Checkbox
            label={`copy ${dotfiles.data!.length} gitignored dotfiles`}
            description={dotfiles.data!.join(", ")}
            checked={copyDotfiles}
            onChange={(e) => setCopyDotfiles(e.currentTarget.checked)}
            disabled={locked}
          />
        )}

        {cmux.data?.available && (
          <>
            <Divider label="cmux" labelPosition="left" />
            <TextInput
              label="Workspace name"
              placeholder="leave empty to skip creating a workspace"
              value={wsName}
              onChange={(e) => setWsName(e.currentTarget.value)}
              disabled={locked}
            />
            <Select
              label="Group"
              placeholder="(none)"
              clearable
              value={wsGroup}
              onChange={setWsGroup}
              disabled={locked}
              data={(cmuxMeta.data?.groups ?? []).map((g) => ({ value: g.ref, label: g.name }))}
            />
            <Stack gap={4}>
              <Group gap={6} wrap="wrap">
                {(cmuxMeta.data?.colors ?? []).map((c) => (
                  <Tooltip key={c.name} label={c.name}>
                    <button
                      type="button"
                      aria-label={c.name}
                      onClick={() => setWsColor(wsColor === c.name ? null : c.name)}
                      disabled={locked}
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: "50%",
                        background: c.hex,
                        cursor: "pointer",
                        border: wsColor === c.name
                          ? "2px solid var(--mantine-color-text)"
                          : "2px solid transparent",
                      }}
                    />
                  </Tooltip>
                ))}
              </Group>
            </Stack>
          </>
        )}
        </>)}

        {job && <JobStepper steps={job.steps} />}

        {question && (
          <Alert color="yellow" title={question.key === "reuse_branch" ? "Branch already exists" : "Local differs from the PR"}>
            <Text size="sm">
              {question.key === "reuse_branch"
                ? `Branch ${question.branch} is already checked out elsewhere.`
                : `Local (${question.local_head?.slice(0, 8)}) differs from the PR's latest (${question.remote_head?.slice(0, 8)}).`}
            </Text>
          </Alert>
        )}

        {error && <Alert color="red">{error}</Alert>}
        {failed && job.error !== undefined && <Alert color="red">{job.error}</Alert>}

        {job?.state === "running" && (
          <Text size="xs" c="dimmed">This keeps running if you close this window.</Text>
        )}

        <Group justify="flex-end">
          {showForm && (
            <>
              <Button variant="subtle" onClick={onClose}>Cancel</Button>
              <Button
                onClick={() => void start()}
                loading={starting}
                disabled={!input.trim() || !repoRoot}
              >
                Create
              </Button>
            </>
          )}
          {question && (
            <>
              <Button size="xs" variant="subtle" onClick={() => void decline()} disabled={busy}>
                {question.key === "reset_to_pr" ? "Keep current commit" : "Cancel"}
              </Button>
              <Button size="xs" loading={busy} onClick={() => void act((id) => api.jobAnswer(id, "yes"))}>
                {question.key === "reuse_branch" ? "Reuse branch" : "Reset to PR"}
              </Button>
            </>
          )}
          {failed && (
            <>
              <Button variant="default" loading={busy} onClick={() => void act((id) => api.jobRetry(id))}>
                Run again
              </Button>
              <Button onClick={close}>Close</Button>
            </>
          )}
          {job?.state === "succeeded" && <Button onClick={() => void ok()}>OK</Button>}
          {job?.state === "running" && <Button variant="default" onClick={close}>Close</Button>}
        </Group>
      </Stack>
    </Modal>
  )
}
