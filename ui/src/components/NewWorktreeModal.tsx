import {
  Alert, Button, Checkbox, Divider, Group, Modal, Select, Stack, Text, TextInput, Timeline,
} from "@mantine/core"
import { IconCheck, IconX, IconMinus, IconPoint } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { useLocation } from "wouter"
import { api } from "../api/client"
import { useCmux } from "../api/cmux"
import type { CreateConfirm, CreateStep } from "../api/types"

function StepIcon({ status }: { status: CreateStep["status"] }) {
  if (status === "done") return <IconCheck size={12} />
  if (status === "failed") return <IconX size={12} />
  if (status === "skipped") return <IconMinus size={12} />
  return <IconPoint size={12} />
}

/**
 * Create a worktree, taking the same inputs as `worktree add`.
 *
 * Confirmations replay: when the server returns a pending `confirm`, the whole
 * request is re-posted with the matching flag set. There is no session to
 * orphan, which is why every step tolerates having already run.
 */
export function NewWorktreeModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  const cmux = useCmux()

  const [input, setInput] = useState("")
  const [repoRoot, setRepoRoot] = useState<string | null>(null)
  const [pull, setPull] = useState(true)
  const [copyDotfiles, setCopyDotfiles] = useState(false)
  const [wsName, setWsName] = useState("")
  const [wsGroup, setWsGroup] = useState<string | null>(null)
  const [steps, setSteps] = useState<CreateStep[]>([])
  const [confirm, setConfirm] = useState<CreateConfirm | null>(null)
  const [error, setError] = useState("")
  const [donePath, setDonePath] = useState("")

  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api.repos(), enabled: opened })
  const dotfiles = useQuery({
    queryKey: ["repo-dotfiles", repoRoot],
    queryFn: () => api.repoDotfiles(repoRoot!),
    enabled: opened && !!repoRoot,
  })
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
    setSteps([]); setConfirm(null); setError(""); setDonePath("")
    setWsName(""); setWsGroup(null)
  }, [opened])

  useEffect(() => {
    if (opened && repos.data?.length && !repoRoot) setRepoRoot(repos.data[0].repo_root)
  }, [opened, repos.data, repoRoot])

  const create = useMutation({
    mutationFn: (answers: { reuse_branch?: boolean; reset_to_pr?: boolean; decline_reset?: boolean }) =>
      api.createWorktree({
        input: input.trim(),
        repo_root: repoRoot!,
        pull,
        copy_dotfiles: copyDotfiles,
        ...answers,
      }),
    onSuccess: async (res) => {
      setSteps(res.steps)
      setConfirm(res.confirm)
      setError(res.error ?? "")
      if (res.confirm || !res.ok || !res.path) return

      if (cmux.data?.available && wsName.trim()) {
        // A workspace failure never invalidates the worktree that was created.
        await api.cmuxCreate({
          path: res.path, name: wsName.trim(), group_ref: wsGroup ?? undefined,
        }).catch(() => {})
      }
      setDonePath(res.path)
      qc.invalidateQueries({ queryKey: ["worktrees"] })
      qc.invalidateQueries({ queryKey: ["cmux"] })
    },
  })

  const answers = { reuse_branch: false, reset_to_pr: false }

  return (
    <Modal opened={opened} onClose={onClose} title="New worktree" centered>
      <Stack gap="sm">
        <TextInput
          label="Branch, PR, or issue"
          description="A branch name, PR number or URL, or a Jira issue URL"
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          disabled={create.isPending || !!donePath}
        />
        <Select
          label="Repo"
          value={repoRoot}
          onChange={setRepoRoot}
          disabled={create.isPending || !!donePath}
          data={(repos.data ?? []).map((r) => ({ value: r.repo_root, label: r.name }))}
        />
        <Checkbox
          label="git pull first"
          checked={pull}
          onChange={(e) => setPull(e.currentTarget.checked)}
          disabled={create.isPending || !!donePath}
        />
        {(dotfiles.data?.length ?? 0) > 0 && (
          <Checkbox
            label={`copy ${dotfiles.data!.length} gitignored dotfiles`}
            description={dotfiles.data!.join(", ")}
            checked={copyDotfiles}
            onChange={(e) => setCopyDotfiles(e.currentTarget.checked)}
            disabled={create.isPending || !!donePath}
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
              disabled={create.isPending || !!donePath}
            />
            <Select
              label="Group"
              placeholder="(none)"
              clearable
              value={wsGroup}
              onChange={setWsGroup}
              disabled={create.isPending || !!donePath}
              data={(cmuxMeta.data?.groups ?? []).map((g) => ({ value: g.ref, label: g.name }))}
            />
          </>
        )}

        {steps.length > 0 && (
          // `pending` is overloaded: it means both "this step is running right
          // now" and "this step was never reached" (finish() pads unreached
          // steps as pending too). The first pending step in the list is the
          // one currently in flight; every pending step after it is genuinely
          // unreached. Render only the first one as in-progress.
          <Timeline active={steps.filter((s) => s.status !== "pending").length - 1} bulletSize={20}>
            {steps.map((s, i) => {
              const firstPendingIdx = steps.findIndex((x) => x.status === "pending")
              const inFlight = s.status === "pending" && i === firstPendingIdx
              return (
                <Timeline.Item
                  key={s.key}
                  bullet={<StepIcon status={s.status} />}
                  title={inFlight ? `${s.label} (in progress)` : s.label}
                >
                  {s.detail && <Text size="xs" c="dimmed">{s.detail}</Text>}
                </Timeline.Item>
              )
            })}
          </Timeline>
        )}

        {confirm && (
          <Alert color="yellow" title={confirm.key === "reuse_branch" ? "Branch already exists" : "Local differs from the PR"}>
            <Stack gap="xs">
              <Text size="sm">
                {confirm.key === "reuse_branch"
                  ? `Branch ${confirm.branch} is already checked out elsewhere.`
                  : `Local (${confirm.local_head?.slice(0, 8)}) differs from the PR's latest (${confirm.remote_head?.slice(0, 8)}).`}
              </Text>
              <Group justify="flex-end">
                {/* Declining the RESET is not a cancel. By this point git has
                    already created the worktree, so closing the modal would
                    strand it — on disk, unregistered, holding no ports. Re-post
                    with decline_reset so the runner skips the reset and
                    finishes. Declining the BRANCH REUSE is a genuine cancel:
                    nothing has been created yet. */}
                {confirm.key === "reset_to_pr" ? (
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => create.mutate({ ...answers, reuse_branch: true, decline_reset: true })}
                  >
                    Keep current commit
                  </Button>
                ) : (
                  <Button size="xs" variant="subtle" onClick={() => { setConfirm(null); onClose() }}>
                    Cancel
                  </Button>
                )}
                <Button
                  size="xs"
                  onClick={() =>
                    create.mutate(
                      confirm.key === "reuse_branch"
                        ? { ...answers, reuse_branch: true }
                        : { ...answers, reuse_branch: true, reset_to_pr: true },
                    )
                  }
                >
                  {confirm.key === "reuse_branch" ? "Reuse branch" : "Reset to PR"}
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}

        {error && <Alert color="red">{error}</Alert>}

        <Group justify="flex-end">
          {donePath ? (
            <Button onClick={() => { onClose(); navigate(`/worktree/${encodeURIComponent(donePath)}`) }}>
              OK
            </Button>
          ) : (
            <>
              <Button variant="subtle" onClick={onClose}>Cancel</Button>
              <Button
                onClick={() => create.mutate(answers)}
                loading={create.isPending}
                disabled={!input.trim() || !repoRoot || !!confirm}
              >
                Create
              </Button>
            </>
          )}
        </Group>
      </Stack>
    </Modal>
  )
}
