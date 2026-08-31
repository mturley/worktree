# cmux integration and worktree creation from the web UI — design

**Status:** approved decisions, ready to plan
**Date:** 2026-08-27
**Roadmap entry:** `docs/ui-feature-roadmap.md` → Phase H

## Goal

Three related pieces, sequenced so each builds on the last:

- **H1** — show a worktree's cmux workspace on its cards, and switch to it.
- **H2** — create a worktree from the home page, reusing H1's workspace fields
  when running inside cmux.
- **H2a** — narrow `worktree add` to inputs that actually create a worktree,
  moving the rest to the commands that own them.

H1 ships first: H2's modal embeds H1's workspace fields. H2a rides with H2
because both turn on the same URL-detection code.

## Background: corrections to the 2026-08-25 research

An earlier research note recorded three claims that direct measurement
disproves. They are corrected here because each one changes the design:

- **`internal/cmux` already exists** and is used by `worktree new`
  (`cmd/root.go:401-449`). The note's "nothing to import, reimplement the two
  commands" is obsolete — the package is already richer than that.
- **`custom_color` is a hex string** (`"#AD1457"`), not a colour name, and is
  `null` on workspaces that never had one set. Note the asymmetry:
  `SetWorkspaceColor` *writes* a name (`"Blue"`); cmux stores hex.
- **`cmux workspace select` works from a non-TTY, non-surface context** —
  verified directly (`OK workspace:30`, exit 0). The note flagged this as the
  risk that could sink the design. It is not one. The `worktree ui` server also
  inherits `CMUX_SOCKET_PATH`, so `cmux.IsAvailable()` gates correctly there.

Two of the note's claims survive and constrain the design: a worktree with no
matching workspace is a **normal** state (7 of 10 matched locally), and path
ambiguity is real (5 workspaces share `/Users/mturley`).

---

## H1 — cmux workspace section on the worktree cards

### Presentation

A section **above the worktree title** on both `WorktreeCard` (home list) and
`WorktreeDetailCard`: a colour bar matching the workspace's colour, the
workspace title, and a switch button on the right.

```
┌────────────────────────────────────┐
│ ▌ wt-ui-fixes (resume…)  [Current] │  ← 3px bar = custom_color
│ ▌ wt-ui-fixes review      [Switch] │  ← second match, its own row
│ wt-ui-fixes                 [trash]│
│ worktree · main · 2h ago           │
└────────────────────────────────────┘
```

| State | Behaviour |
|---|---|
| not inside cmux | section does not render at all; card identical to today |
| cmux up, no match | one dimmed row, "No cmux workspace", **Create** button |
| one or more matches | one row per match, each independently switchable |
| a match with `selected: true` | disabled **Current** instead of **Switch** |
| a match with no `custom_color` | neutral dark bar, so rows stay aligned |

Multiple matches each get a row rather than being collapsed: it costs nothing
in the common single-match case and never silently hides a real workspace.

### Matching happens in Go

Paths are compared after `Abs → EvalSymlinks → Clean` — the same
canonicalization `internal/db`'s `Subscriber` uses. TypeScript cannot resolve
symlinks, which is the deciding reason matching cannot move to the client.

Canonicalize each side **once** (N+M syscalls, not N×M).
`internal/webui/timeline.go:279` records what per-pair `EvalSymlinks` cost the
Phase F timeline; do not repeat it.

This exposes a latent CLI bug: `cmux.FindByDirectory` compares raw strings, so
`worktree new` already fails to find an existing workspace when either path
runs through a symlink. Reimplementing it over the shared matcher fixes both
surfaces at once.

### `internal/cmux` changes

```go
// Workspace gains Title and CustomColor. cmux leaves custom_title null on
// workspaces it titles itself (e.g. "◐ handler-ratelimits"), so Title is the
// primary source and CustomTitle the fallback.
type Workspace struct {
    Ref              string  `json:"ref"`
    Title            string  `json:"title"`
    CustomTitle      string  `json:"custom_title"`
    CustomColor      *string `json:"custom_color"` // hex, or nil
    CurrentDirectory string  `json:"current_directory"`
    Selected         bool    `json:"selected"`
}

// DisplayTitle returns Title, else CustomTitle, else Ref.
func (w Workspace) DisplayTitle() string

// Match maps each requested path to the workspaces whose current_directory
// resolves to it. Both sides are canonicalized once.
func Match(workspaces []Workspace, paths []string) map[string][]Workspace

// Activate raises the cmux app (osascript). Best-effort; errors are returned
// but callers treat them as non-fatal.
func Activate() error
```

`FindByDirectory` is reimplemented over `Match`. `cmuxCmd` becomes a package
`var` so handler tests can stub exec — the only refactor of existing code.

### HTTP API

```
GET /api/cmux
200 { "available": true,
      "matches": { "/path/to/worktree": [
          { "ref": "workspace:30", "title": "wt-ui-fixes",
            "color": "#AD1457", "selected": true } ] } }

200 { "available": false }        // not inside cmux, or the list call failed
```

`matches` is keyed by **exactly the path the UI already holds**, so the client
does no path logic. One shared TanStack query means N cards cost one
`cmux workspace list` per refetch, not N. Polled at 15s: cmux titles carry live
agent-status glyphs and do go stale.

```
GET  /api/cmux-groups   200 { "groups": [...], "colors": [{name,hex}] }
POST /api/cmux/select   { "ref": "workspace:30" }        → { "ok": true }
POST /api/cmux/create   { "path", "name", "group_ref", "color" }
                                                          → { "ok": true, "ref": "..." }
```

`/api/cmux-groups` is fetched only when a modal opens, keeping the polled
endpoint to a single exec. Colours are served from `cmux.NamedColors` rather
than duplicated as a TS constant — one source of truth for the swatches.

**Rejected:** putting `cmux_workspaces` on `WorktreeSummary`. `/api/worktrees`
is on the SSE-driven hot path, and Phase F deliberately moved subprocess work
off it into `/api/worktree-info`. This follows that precedent.

### Create-workspace modal

Full parity with the CLI: name (defaulting to `wt <branch>`), group select,
colour swatches. The created workspace reuses `cmux.BuildLayout` built from the
worktree's resources **as they are now** — usually better than at creation
time, since resources get added later. The server knows its own port
(`Server.Port`), so the pinned UI tab is easier here than in the CLI, where
`runningUIDetailURL` has to probe for a listener.

After creating: set colour, pin browser tabs, focus the first browser tab,
select, activate — the same order `openCmuxWorkspace` uses.

### Switching

`POST /api/cmux/select` runs `cmux workspace select <ref>` then
`osascript -e 'tell application "cmux" to activate'`. Always activating is
harmless when cmux is already frontmost and essential when the click came from
an external browser.

### Errors

Every cmux exec fails soft. A failed list → `available: false` → the section
disappears rather than rendering an error. Select and create failures raise a
notification and leave the card untouched. **No cmux failure ever 500s a page.**

### Frontend gotcha

On the home list the whole card is one navigation target, so the Switch and
Create buttons need `stopPropagation` — otherwise clicking Switch also
navigates to the detail page.

---

## H2 — create a worktree from the home page

A **New worktree** button on the home page opening a modal that takes the same
inputs as `worktree add` and, inside cmux, folds in H1's workspace fields so
one submission produces a worktree and its workspace.

```
New worktree

  [ 9465 | RHOAIENG-123 | my-branch     ]   ← detects what you paste
  Repo   [ odh-dashboard             ▾ ]   ← most recent first

  ☑ git pull first
  ☐ copy 3 gitignored dotfiles
      .env.local, .npmrc, .vscode

  ── cmux ──────────────────  (only inside cmux)
  Name   [ wt wt-my-feature            ]
  Group  [ (none)                    ▾ ]
  Colour ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ●

                      [Cancel]  [Create]
```

### A shared runner

Creation lives inline across `cmd/root.go` today (`handleBranch`, `handlePR`,
`handleJiraIssue`, `finalizeWorktree`). Both surfaces need that whole sequence,
so it moves into `internal/worktreenew` — exactly as deletion moved into
`internal/worktreedel` in Phase G.

Copying it would leave two sequences to keep in step, and the drift is silent:
a web-created worktree that never allocated a port range looks fine until the
range runs out.

```go
type StepKey string

const (
    StepPull           StepKey = "pull"
    StepCreateWorktree StepKey = "create_worktree"
    StepAllocatePorts  StepKey = "allocate_ports"
    StepRegister       StepKey = "register"
    StepKubeconfig     StepKey = "kubeconfig"
    StepResources      StepKey = "resources"
    StepDotfiles       StepKey = "dotfiles"
    StepCmuxWorkspace  StepKey = "cmux_workspace"
)

type Status string // "done" | "skipped" | "failed" | "needs_confirm" | "pending"

type Step struct {
    Key    StepKey
    Label  string
    Status Status
    Detail string
}

type Options struct {
    Input        string // branch name, Jira key/URL, PR number, or PR URL
    RepoRoot     string
    Pull         bool
    CopyDotfiles bool

    // Answers to confirmations, carried on the re-POST.
    ReuseBranch bool
    ResetToPR   bool

    Cmux *CmuxOptions // nil when not creating a workspace
}

// ConfirmKey names a pending question. It is deliberately its own type rather
// than a StepKey: both questions arise inside create_worktree, so a step key
// could not tell them apart.
type ConfirmKey string

const (
    ConfirmReuseBranch ConfirmKey = "reuse_branch"
    ConfirmResetToPR   ConfirmKey = "reset_to_pr"
)

// Confirm carries what the user needs in order to answer. LocalHead and
// RemoteHead are empty for ConfirmReuseBranch on a synced branch.
type Confirm struct {
    Key        ConfirmKey
    Branch     string
    LocalHead  string
    RemoteHead string
}

type Result struct {
    Steps   []Step
    Confirm *Confirm // nil when nothing is waiting on an answer
    Path    string
    Branch  string
    Err     error
}

func Run(conn *sql.DB, cfg config.Config, opts Options, observe func(Step)) Result
```

The observer lets one runner serve both surfaces: the CLI wraps each step in
its existing `ui.SpinWhile` output, the web handler collects steps into a
response. Neither reimplements the sequence.

### Input dispatch

Only four of `worktree add`'s six branches create a worktree:

| Input | Resolution |
|---|---|
| branch name | `gitutil.CreateBranchWorktree` |
| Jira URL or key | branch named after the lowercased key; the issue is saved as the primary resource |
| PR number | repo comes from the selection, not cwd |
| PR URL | repo resolved by matching remotes against the selection |

Detection reuses the CLI's own patterns (`prURLPattern`, `jira.IsJiraURL`,
`strconv.Atoi`) through the shared package H2a extracts — never a second set.

Slack URLs and paths are rejected with the same redirects H2a adds to the CLI.

### Repo selection

The CLI takes the repo from cwd; a server has none. The list comes from the
registry (`DISTINCT repo_root`), **sorted by the creation date of each repo's
most recent worktree, with the most recent repo selected by default**.

Known limitation, accepted: a repo with zero registered worktrees cannot be
picked, so its first worktree is still created from the CLI.

`findRepoForPR` improves as a side effect — today it only checks cwd and errors
otherwise; given an explicit repo selection it becomes a `MatchesRemote` check
against the chosen repo.

### Confirmations

The PR path asks **two** questions inline (`cmd/root.go:127`, `336`): reuse an
existing branch, and reset to the PR's latest commit.

(The roadmap called this three. Reading the code settles it at two: an existing
*directory* — `PRWorktreeExistingDir` — is not confirmed at all, it goes
straight to `offerPRSync`, which asks the reset question. So "reuse the
directory" is not a separate prompt. Both questions can also fire in one run: a
branch that exists *and* is behind asks to reuse, then asks to reset.)

These use **Phase G's proven shape**: the question comes back as an HTTP **200
with a marker**, and the client re-POSTs the whole request with the answer set.
There is **no server-side session** — one that a closed tab could orphan.

```
POST /api/worktrees/create
  { "input": "9465", "repo_root": "...", "pull": true, "copy_dotfiles": false,
    "reuse_branch": false, "reset_to_pr": false,
    "cmux": { "name": "...", "group_ref": "...", "color": "..." } }

200 { "ok": true,
      "confirm": null,                // or the pending question:
      //  { "key": "reuse_branch" | "reset_to_pr",
      //    "branch": "...", "local_head": "...", "remote_head": "..." }
      "steps": [ { "key", "label", "status", "detail" } ],
      "path": "...", "branch": "..." }
```

Returning a pending `confirm` as 200 keeps "git wants an answer"
distinguishable from "the create broke" — the one distinction the flow rests
on. `confirm` is a single nullable object rather than a marker plus a detail
block, so the two can never disagree about whether a question is pending.

**Replay is safe**, which is what makes statelessness work here:
`CreateBranchWorktree` returns the existing worktree with `Created: false`,
`CreatePRWorktree` re-reports its status, `ports.Allocate` and
`registry.Register` are upserts, and a second `git pull` or dotfile copy is
harmless. Steps that were already done report as `skipped` with a reason rather
than failing.

A `needs_confirm` stops the run: later steps stay `pending`, so the stepper
greys them rather than pretending they were skipped. Declining a confirmation
aborts without creating.

### Progress

A pipeline stepper driven straight from `steps[]`, matching Phase G's delete
modal so both destructive-ish flows read the same way. On success the modal
stays open showing the summary and closes on **OK**, which navigates to the new
worktree's detail page and invalidates `["worktrees"]`.

### Dotfiles discovery

The dotfiles checkbox lists the files it would copy, so it needs
`GET /api/repo-dotfiles?repo_root=…` over `dotfiles.Discover`, fetched once a
repo is chosen. It is unchecked by default: copying `.env` files nobody asked
for is exactly the surprise the CLI's prompt exists to prevent.

---

## H2a — narrow `worktree add` to creation

The two non-creating branches come out of `worktree add`, so the command
creates a worktree or fails. The functionality moves to the commands that
already own it: `worktree resources add` for Slack URLs, `worktree info <path>`
for paths.

This is a breaking CLI change and needs three pieces **in this order**:

**1. `worktree resources add` must accept a URL first.** It takes
`<type> <id>` today, so a Slack thread would otherwise have to be added as
`resources add slack C069KSM8T9N:1787257539.775119` — an id nobody can derive
by hand from a URL. It gains a one-argument form (`cobra.RangeArgs(1, 2)`): one
argument is a URL to infer from, two are the explicit type and id as now.

**2. Unrecognized input must be rejected explicitly.** `runAdd` currently
*falls through* to `handleBranch`, so merely deleting the Slack branch would
make a pasted Slack URL create a branch named `https://…`. Both removed forms
keep their detection and turn it into a pointed error:

```
worktree add: Slack URLs are tracked as resources, not worktrees.
  Try: worktree resources add <url>

worktree add: that path is an existing worktree.
  Try: worktree info <path>
```

Detecting-and-redirecting is the whole point. A silent fall-through to branch
creation is worse than the behaviour being removed.

**3. `inferResource` moves out of `webui`.** It already maps a URL to
`(type, id)` for all three types, and its own comment concedes it
hand-duplicates `prURLPattern` from `cmd/root.go` and is "kept in sync". With
the CLI, the web handler, and `worktreenew` all needing it, it moves to a
shared package (`internal/resourceurl`) and the hand-sync hazard goes with it.

`worktree info` already accepts an optional `[path]`, so that half needs no new
capability — only the redirect.

---

## Error handling summary

| Situation | Behaviour |
|---|---|
| not inside cmux | `available: false`; no section, no error |
| `cmux workspace list` fails | `available: false`; section disappears |
| `workspace select` fails | notification; card untouched |
| `workspace create` fails | notification; worktree creation still counts as succeeded |
| no workspace matches a worktree | normal state; Create button |
| PR branch or directory exists | `needs_confirm`, run stops, question offered |
| a cleanup step fails | step `failed`, run continues, failure visible in the summary |
| `create_worktree` fails | run stops, later steps stay `pending` |
| repo has no registered worktrees | not offered in the picker; CLI still handles it |

## Testing

- **`cmux.Match`**: symlinked temp dirs — the case `FindByDirectory` gets wrong
  today; multiple workspaces on one path; no match; `available` false with the
  env unset.
- **`cmux` handlers**: stubbed `cmuxCmd`; a failing list yields
  `available: false`, not a 500.
- **`worktreenew`**: temp git repo plus temp DB, as `worktreedel` tests already
  do. Cases: branch create; Jira key create with the resource saved; PR branch
  exists → `needs_confirm` and the confirmed retry; replay after a successful
  create (steps `skipped`, not `failed`); a failing cleanup step not aborting;
  a failing `create_worktree` DOES abort.
- **Input dispatch**: each of the four creating forms resolves correctly; Slack
  URLs and paths are rejected with the redirect message, **never** creating a
  branch named after the input.
- **`resources add`**: one-argument URL form infers the same `(type, id)` the
  two-argument form takes explicitly.
- **UI**: section hidden when unavailable; one row per match; `Current` on the
  selected one; Create appears at zero matches; a Switch click does not
  navigate; the create modal's cmux fields appear only when available; the
  stepper renders each status; a confirmation prompt re-posts with its flag.

## Out of scope

- Creating a worktree for a repo with no registered worktrees (CLI only).
- Renaming, recolouring, or deleting cmux workspaces from the web UI.
- handler's terminal-peek / content-capture feature — it lives in the same
  handler files as the switch logic; take the workspace pieces, leave
  `Capture`/`Notify`/peek-cache.
- Bulk worktree creation.
