# worktree

CLI for managing git worktrees with GitHub/Jira integration and optional cmux support. Also available as `wt`.

Create, discover, and manage git worktrees with automatic port allocation, isolated kubeconfigs, and one-command PR review workflows.

## Install

### From source

```bash
git clone https://github.com/mturley/worktree.git
cd worktree
make build
make install    # installs worktree + wt symlink to /usr/local/bin, runs setup
```

### Via `go install`

```bash
go install github.com/mturley/worktree@latest
worktree setup
```

### Setup

`worktree setup` is an interactive setup wizard that configures your environment. It runs automatically after `make install`, or you can run it manually. It is safe to re-run — it shows what is already configured and only prompts for what is missing.

Setup will:
- Prompt for your git project root directory (where you clone repos)
- Prompt for your worktrees directory (default: `~/.worktrees`)
- Create a config file at `~/.config/worktree/config.yaml`
- Create a SQLite database at `${XDG_DATA_HOME:-~/.local/share}/worktree/worktree.db` if needed
- Add a shell hook (`chpwd`) that runs `eval "$(worktree env)"` on directory change (zsh, bash, or fish)
- Install shell completions for `worktree` and `wt` (zsh, bash, fish)
- Check that `gh` (GitHub CLI) is installed and authenticated
- Test and repair credentials for **GitHub, Slack, and Jira** — the shared watcher
  credential flow (`credsetup`) validates each service's credentials in
  `~/.config/watcher/auth.yaml` and, if a credential is missing or invalid, walks
  you through configuring and re-validating a new one. Each service is optional
  (setup asks before configuring one that isn't set up yet).
- Optionally configure Jira project prefixes (used for issue-key detection),
  stored in `~/.config/worktree/config.yaml`

On every run (not just the first), setup re-tests the existing GitHub, Slack, and
Jira credentials and offers to replace any that fail — so an expired token is
caught early. Credentials live in the shared `~/.config/watcher/auth.yaml`
(GitHub via `gh`; Slack + Jira written here), not in worktree's own config.

Slack credential setup can extract your browser session token and cookie
**automatically** — it drives a headed Chromium via Playwright to log in and pull
the `xoxc-` token + `xoxd-` cookie (a one-time Chromium download cached under
`~/.cache/worktree`; requires `node`/`npx`). If Node isn't available it falls back
to a guided manual walkthrough.

Run `worktree setup --uninstall` to reverse setup changes. The config file is preserved (it contains credentials) — setup tells you how to remove it manually.

## Quick Start

```bash
# Create a worktree for a new branch
worktree add my-feature-branch

# Create a worktree for a PR (by number or URL)
worktree add 1234
worktree add https://github.com/org/repo/pull/1234

# Create a worktree for a Jira issue
worktree add https://your-org.atlassian.net/browse/PROJ-5678

# List all discovered worktrees
worktree list

# Show info about the current worktree
worktree info
```

## Usage

Running `worktree` with no arguments shows help followed by info about the current directory.

### Creating Worktrees — `worktree add`

`worktree add <arg>` detects what you're passing and does the right thing:

| Argument | Action |
|----------|--------|
| `1234` | Create/open a worktree for PR #1234 (from the current repo) |
| `https://github.com/.../pull/1234` | Create/open a worktree for the linked PR |
| `https://...atlassian.net/browse/KEY-123` | Create a worktree with the Jira key as the branch name |
| `my-feature` | Create a worktree for a new branch from the current HEAD |
| `/path/to/worktree` | Show info for an existing worktree |

When creating a PR worktree, the tool automatically finds the local clone matching the PR's repository. It resolves the correct remote by URL (not by name), so fork workflows with `origin`/`upstream` work correctly.

New branch worktrees branch from the current HEAD. Before creating one, the tool offers to `git pull` first.

### Commands

#### Worktree Management

```bash
worktree list                    # List worktrees from the database
worktree info [path]             # Show worktree info (env vars, resources)
worktree info --local            # Skip API calls (fast)
worktree delete [path]           # Remove a worktree and clean up
worktree cleanup                 # Interactively reconcile disk vs database (prompts before removing)
worktree dotfiles [path]         # Copy gitignored dotfiles from main worktree
worktree ports                   # Show allocated port ranges (database-backed)
```

`delete` removes a worktree and cleans up its port allocation, kubeconfig, and git state. `cleanup` reconciles the database with the filesystem, removing worktree entries whose directories no longer exist.

#### Open in Editor or Browser

```bash
worktree open [path]             # Open in editor ($EDITOR or configured)
worktree open --github           # Open the associated PR in browser
worktree open --jira             # Open the associated Jira issue in browser
```

#### Jira Integration

```bash
worktree jira [path]             # Show associated Jira issues (with API enrichment)
worktree jira add KEY-123        # Associate a Jira issue (primary)
worktree jira add KEY-456 --related  # Associate as context-watching
worktree jira remove KEY-123     # Remove an association
```

Jira issues are automatically detected from the PR title, PR body, and branch name when creating a PR worktree. Detected issues are stored in the database.

#### Environment & Resources

```bash
worktree env                     # Print shell environment variables (use: eval "$(worktree env)")
worktree resources list          # List tracked resources (database-backed)
worktree resources list --json   # JSON format for agent-handler integration
worktree resources add <type> <id> [--url <url>] [--related]  # Add a resource
worktree resources unwatch <type> <id>  # Soft-remove a resource (mark inactive)
worktree resources remove <type> <id>   # Hard-remove a resource from database
```

Resource types are `pr`, `jira`, and `slack`. The `--json` output
(`[{type,id,url,primary}]`, where `primary = !related`) is a stable contract:
[agent-handler](https://github.com/mturley/agent-handler) reads it to auto-watch
a worktree's **primary** resources when a session registers, and propagates its
own `/watch` back via `worktree resources add`. worktree works fine without
agent-handler; the integration is best-effort on both sides.

#### Watcher (Timeline Integration)

```bash
worktree watcher run [pr|jira|all]  # One-shot poller for PR/Jira timeline events
```

This is a one-shot poll of tracked PR and Jira resources, writing timeline
events to the database. It exists for manual/scripted refreshes — during normal
use the `worktree ui` server runs its own background poll loop (every ~2 min,
plus on-view-if-stale) covering PRs, Jira issues, **and** Slack threads, so you
rarely need to run this by hand. (Slack is polled by the UI server's loop, not
by this standalone command.)

#### Admin

```bash
worktree setup                   # Interactive setup wizard
worktree setup --uninstall       # Reverse setup changes
worktree setup --yes             # Non-interactive setup (for CI)
worktree update                  # Self-update (if installed via go install)
worktree version                 # Print version
```

## What Happens When You Create a Worktree

When you run `worktree add <arg>`, the tool:

1. Creates the git worktree under `~/.worktrees/<repo>/<name>`
2. Allocates a unique port range in the database (10 ports starting at 4020, e.g. `4020-4029`)
3. Seeds an isolated kubeconfig at `~/.kube/config-<repo>-<name>`
4. Registers the worktree in the database
5. Detects Jira issues from branch name and PR metadata
6. Stores PR and Jira associations in the database
7. Offers to copy gitignored dotfiles from the main worktree

When an existing review branch is found (e.g. the worktree was previously deleted), the tool shows whether it is up to date with the PR and asks for confirmation before reusing it.

### Persistence (Database-Backed)

Worktree state is stored in a SQLite database at `${XDG_DATA_HOME:-~/.local/share}/worktree/worktree.db` (overridable via `WORKTREE_DB`).

**Environment variables** are generated on-demand by `worktree env`:

```bash
$ eval "$(worktree env)"
$ echo $WORKTREE_PORTS
4020-4029
$ echo $KUBECONFIG
~/.kube/config-repo-my-branch
```

Your shell RC hook (installed by `worktree setup`) automatically runs `eval "$(worktree env)"` when you `cd` into a worktree.

**Resource tracking** (PR/Jira associations) is stored in the database. Use `worktree resources list --json` to get a machine-readable format:

```json
[
  {"type":"pr","id":"owner/repo#123","url":"https://github.com/owner/repo/pull/123","primary":true},
  {"type":"jira","id":"PROJ-456","url":"https://your-org.atlassian.net/browse/PROJ-456","primary":true},
  {"type":"jira","id":"PROJ-400","url":"https://your-org.atlassian.net/browse/PROJ-400","primary":false}
]
```

Unmarked entries (or `"primary":true`) are the reason this worktree exists. Entries with `"primary":false` are **related** (watching for context).

## Web UI

```bash
worktree ui                # start the web UI on http://localhost:8475 and open it in a browser
worktree ui --port 9000    # use a different port
worktree ui --no-open      # don't auto-open a browser
worktree ui --api-only     # serve only the JSON API (used with the Vite dev server, see `make dev`)
```

The web UI is a single embedded binary — no separate frontend install required. It shows:

- **Home view:** every managed worktree (from the database registry) with resource/primary counts and missing-on-disk markers, plus a global timeline of events across all watched PR/Jira resources (newest first, attributed to the worktree(s) that watch them), with a "Show archived" toggle for events on resources no longer actively watched.
- **Detail view:** an "Overview" tab with a single worktree's resources (primary vs. related) and a timeline scoped to its subscriptions (opening a worktree triggers a fresh poll if its data is stale, i.e. poll-on-view), plus a **"Slack" tab** showing that worktree's linked Slack threads (view, reply, and react) if any are added.

While running, the server polls all active PR/Jira resources in the background every 2 minutes and pushes updates to the browser over Server-Sent Events, so the timeline stays close to live without a manual refresh. This phase is read-only — no watch/unwatch/create/delete actions from the UI yet.

### Slack

`worktree add <slack-thread-url>` links a Slack thread to a worktree as a resource; it then appears in that worktree's "Slack" tab in the web UI, where you can view the thread, reply, and react. Run `worktree setup` to acquire Slack credentials — it walks you through extracting your browser session token and cookie and stores them (plus your workspace domain) in the shared watcher config at `~/.config/watcher/auth.yaml`.

**Security note:** the Slack token and cookie are your own Slack session credentials (not an app token) — treat them like a password. They're stored in `~/.config/watcher/auth.yaml` (mode `0600`) and are never committed to any repo.

## cmux Integration

When running inside [cmux](https://cmux.com/), worktree creation automatically creates a cmux workspace with a split layout:

- **Left:** Terminal running Claude Code
- **Top-right:** Browser tabs for the PR and detected Jira issues (PR tab is focused by default)
- **Bottom-right:** Terminal showing `worktree info`

On creation, the tool prompts for:
- **Workspace name** (default: `wt <branch>`)
- **Workspace group** (from existing groups, or none)
- **Workspace color** (from cmux's named colors, or none)

If a cmux workspace already exists for the worktree's directory, the tool switches to it instead of creating a duplicate.

`worktree list` marks worktrees that have open cmux workspaces with `[open]`.

## Configuration

Config file at `~/.config/worktree/config.yaml` (created by `worktree setup`):

```yaml
# Where worktrees are created
worktrees_base: ~/.worktrees

# Editor for `worktree open`
editor: cursor

# Jira integration (configured by setup wizard)
jira:
  host: your-org.atlassian.net
  email: you@example.com
  token: your-jira-api-token
  projects:
    - MYPROJECT
    - OTHERPROJECT
```

### Environment Variable Overrides

These env vars override config file values:

| Variable | Overrides |
|----------|-----------|
| `WORKTREES_BASE` | `worktrees_base` |
| `WORKTREE_DB` | Database path (default: `${XDG_DATA_HOME:-~/.local/share}/worktree/worktree.db`) |

## Dependencies

**Required:** `git`

**Optional:**
- `gh` (GitHub CLI) — for PR metadata and workflows. Setup checks for this.
- Jira API token — for issue detection and enrichment. Setup configures this.
- [cmux](https://cmux.com/) — for workspace integration with split layouts and browser tabs.

## License

CC0 1.0 Universal — public domain dedication.
