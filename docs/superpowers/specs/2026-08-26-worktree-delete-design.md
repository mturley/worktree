# Deleting a worktree from the web UI — design

**Status:** approved decisions, ready to plan
**Date:** 2026-08-26
**Roadmap entry:** `docs/ui-feature-roadmap.md` → Phase G

## Goal

Delete a worktree from the web UI with the same care the CLI takes: confirm
deliberately, escalate to a forced removal only when git refuses, report what
was actually done, and optionally delete the branch.

Deleting a worktree is destructive and partly irreversible. The design's
priority is that the user always knows what happened — including which parts
failed — rather than being handed a bare success or failure.

## Why this is not one button

`worktree delete` (`cmd/delete.go`) is a conversation, not a call:

1. `gitutil.RemoveWorktree` tries `git worktree remove`, then `--force`.
2. If git still refuses — leftover build output, read-only files — it returns
   `*gitutil.ErrNeedsForce` carrying git's own output.
3. The CLI shows that output, explains the likely cause, and asks.
4. Only on confirmation does it call `gitutil.ForceRemoveWorktree`, which
   fixes permissions, removes the directory and prunes.
5. Afterwards it releases the port range, unregisters, drops tracked
   resources, deletes the kubeconfig and prunes.

Branch deletion adds a **second** escalation of the same shape: `git branch -d`
refuses to delete an unmerged branch, and a worktree's branch is usually
unmerged. Both escalations must be representable.

## Architecture

### A shared deletion runner

The post-removal cleanup lives inline in `cmd/delete.go` today. Both surfaces
need exactly that sequence, so it moves into a new package —
`internal/worktreedel` — that owns the whole run. Copying it into the handler
would leave two sequences to keep in step, and the failure mode is silent: a
worktree deleted from the UI that still holds its port range looks fine until
the range runs out.

```go
type StepKey string

const (
    StepRemoveDirectory StepKey = "remove_directory"
    StepReleasePorts    StepKey = "release_ports"
    StepUnregister      StepKey = "unregister"
    StepRemoveResources StepKey = "remove_resources"
    StepRemoveKubeconfig StepKey = "remove_kubeconfig"
    StepPrune           StepKey = "prune"
    StepDeleteBranch    StepKey = "delete_branch"
)

type Status string // "done" | "skipped" | "failed" | "needs_force" | "pending"

type Step struct {
    Key    StepKey
    Label  string // human text, shared by CLI output and the web stepper
    Status Status
    Detail string // git's output, or the reason for skipped/failed
}

type Options struct {
    Path           string
    DeleteBranch   bool
    ForceDirectory bool // granted after a needs_force on the directory
    ForceBranch    bool // granted after a needs_force on the branch
}

type Result struct {
    Steps     []Step
    NeedsForce StepKey // "" when nothing is waiting on a decision
    Err       error    // a hard failure, distinct from NeedsForce
}

// Run executes the sequence, reporting each step to observe as it completes.
// observe may be nil.
func Run(conn *sql.DB, cfg config.Config, opts Options, observe func(Step)) Result
```

The observer is what lets one runner serve two very different surfaces: the
CLI wraps each step in its existing `ui.SpinWhile` output, the web handler
collects the steps into a response. Neither reimplements the sequence.

### Every run is complete and idempotent

There is **no server-side session**. Granting a force re-POSTs the whole
request with that force set, and the runner starts from the top.

This only works if repeating a step is harmless, so each step must be
idempotent, and the runner marks work that was already done as `skipped` with
a reason rather than failing:

- directory already gone → `skipped`, "already removed"
- port range not allocated → `skipped`
- registry row absent → `skipped`
- kubeconfig absent → `skipped`

Idempotence is the price of statelessness, and it is worth it: the alternative
is a delete-session on the server that can be orphaned by a closed tab.

### Steps

| Step | Action | Notes |
|---|---|---|
| `remove_directory` | `gitutil.RemoveWorktree`, or `ForceRemoveWorktree` when `ForceDirectory` | `*ErrNeedsForce` → `needs_force`, run stops |
| `release_ports` | `ports.Release(conn, name)` | |
| `unregister` | `registry.Unregister(conn, path)` | |
| `remove_resources` | `resources.RemoveAll(conn, path)` | |
| `remove_kubeconfig` | `os.Remove(env.KubeconfigPath(repo, name))` | absent → `skipped` |
| `prune` | `gitutil.PruneWorktrees(repoRoot)` | |
| `delete_branch` | `gitutil.DeleteBranch(repoRoot, branch, force)` | only when `DeleteBranch`; unmerged → `needs_force` |

A `needs_force` stops the run: later steps stay `pending`, so the stepper can
show them greyed rather than pretending they were skipped.

A `failed` **cleanup** step does not stop the run. The CLI already warns and
carries on for these, and stopping would leave more mess than continuing; the
difference is that the failure is now visible instead of scrolling past.

`remove_directory` is the exception: if it fails outright — as opposed to
asking for force — the run **stops**, and every later step stays `pending`.
Continuing would unregister and release the ports of a worktree whose
directory is still on disk, stranding it: invisible to the tool, still
occupying its port range. This is also what makes the unreachable-worktree
case safe.

### New: `gitutil.DeleteBranch`

```go
// DeleteBranch deletes a local branch. With force=false it uses `git branch -d`,
// which refuses to delete a branch that is not fully merged; that refusal is
// returned as *ErrNeedsForce carrying git's message, so callers can escalate
// the same way they do for a worktree directory.
func DeleteBranch(repoRoot, branch string, force bool) error
```

Reusing `ErrNeedsForce` matters: both escalations then have one shape, and the
API and UI handle "which step needs forcing" rather than two special cases.

### Resolving repo root and branch

The CLI derives `repoRoot` from the worktree directory via `gitutil.RepoRoot` /
`CommonDir`. That fails once the directory is gone — and on a retry after a
successful removal, it is gone. The runner therefore prefers the **registry
row** (`registry.Get` gives `RepoRoot` and `Branch`) and falls back to
inspecting the directory when there is no row. If neither yields a repo root,
the request is rejected rather than half-run. This is also what makes `delete_branch` work on the
force retry, since by then the worktree is already deleted.

## HTTP API

```
POST /api/worktrees/delete
  { "path": "...", "delete_branch": false,
    "force_directory": false, "force_branch": false }

200 { "ok": true,
      "needs_force": "",              // or "remove_directory" | "delete_branch"
      "steps": [ { "key", "label", "status", "detail" } ] }
```

`needs_force` is a **200 with a body**, not a 500. Returning an error status
would make "git wants confirmation" indistinguishable from "the delete broke",
which is the one distinction the whole flow rests on.

A worktree the server cannot reach fails: `remove_directory` is `failed` with
the underlying error and `ok` is false. It is not silently unregistered —
dropping the registry row for a directory that still exists would strand it.

## UI

### Entry point

A red trash `ActionIcon` in the top-right of `WorktreeDetailCard`, on the same
row as the worktree name.

### Modal

**Confirm.** Explains what will be deleted, takes a text input that must match
the worktree name exactly before the Delete button enables, and offers
`☐ Also delete the branch <name>` — **unchecked by default**. Removing a
worktree destroys no work; deleting an unmerged branch can, so it is a
deliberate act on both surfaces.

**Progress.** A pipeline stepper, one stage per step, driven straight from
`steps[]`. The in-flight stage spins. Progress arrives **per phase**: one POST
per phase, each returning every step outcome for that phase. The slow part —
directory removal — is a single step covered by its own spinner, so a live
stream would buy accuracy the user cannot perceive, at the cost of a second
transport and reconnect semantics mid-delete.

**Escalation.** A `needs_force` stage shows a red ✗ with git's output and the
"usually leftover build output or read-only files" explanation. The
Cancel / Force prompt appears **beneath** that stage, leaving the completed
stages visible — the user should be able to see what already happened while
deciding. Confirming re-POSTs with the matching force flag; the stepper
resumes.

**Success.** The modal **stays open** showing the finished summary — ports
freed, registry, resources, kubeconfig, prune, branch — the way the CLI's
output does. It closes only on **OK**, which navigates to `/` and invalidates
`["worktrees"]`. Auto-closing would throw away the only report the user gets.

## CLI changes

`runDelete` becomes a driver over the shared runner, keeping its current
output. It also gains a branch prompt:

```
Delete the branch 'my-branch' too? [y/N]
```

**Defaulting to no**, matching the unchecked checkbox. Anyone habitually
pressing enter through the prompts must not lose a branch. `--force` (skip
confirmation) does not imply branch deletion; a separate `--delete-branch`
flag makes it scriptable.

## Error handling summary

| Situation | Behaviour |
|---|---|
| git refuses to remove the directory | `needs_force: remove_directory`, run stops, force offered |
| branch not fully merged | `needs_force: delete_branch`, force offered |
| worktree directory unreachable | `remove_directory` failed, `ok: false`, registry untouched |
| a cleanup step fails | step `failed`, run continues, failure visible in the summary |
| worktree not in the registry, but a readable git worktree | proceeds; repo root and branch come from inspecting the directory |
| neither in the registry nor readable | 400 — nothing identifies the repo root or branch |

## Testing

- **Runner** (`internal/worktreedel`): a temp git repo plus a temp DB, as
  `gitutil` and `webui` tests already do. Cases: clean run; needs-force on the
  directory and the forced retry; unmerged branch escalation; idempotent
  re-run after a successful delete (every step `skipped`, not `failed`); a
  failing cleanup step not aborting the rest; and a failing
  `remove_directory` DOES abort, leaving the registry row intact.
- **`gitutil.DeleteBranch`**: merged branch deletes with `-d`; unmerged
  returns `*ErrNeedsForce`; forced delete succeeds.
- **HTTP**: `needs_force` returns 200 with the marker (not 5xx); unreachable
  worktree gives `ok: false` and leaves the registry row; unknown worktree 400.
- **UI**: Delete disabled until the typed name matches; checkbox defaults
  unchecked; stepper renders each status; force prompt appears under the
  failed stage and re-posts with the flag; OK navigates home; modal does not
  close on its own.

## Out of scope

- Deleting the worktree that is serving the UI — `worktree ui` is always run
  from outside a worktree.
- Bulk deletion from the home page.
- Undo. Deletion is destructive by design; the confirmation is the safeguard.
