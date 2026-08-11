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
- Add a `.worktree-env` auto-source snippet to your shell RC (zsh, bash, or fish)
- Install shell completions for `worktree` and `wt` (zsh, bash, fish)
- Check that `gh` (GitHub CLI) is installed and authenticated
- Optionally configure Jira integration (host, email, API token, project prefixes)
- Test the Jira connection if configured

On re-runs, setup tests the existing Jira connection and offers to replace the token if it fails.

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

When creating a PR worktree, the tool automatically finds the local clone matching the PR's repository by searching your configured search roots. It resolves the correct remote by URL (not by name), so fork workflows with `origin`/`upstream` work correctly.

New branch worktrees branch from the current HEAD. Before creating one, the tool offers to `git pull` first.

### Commands

#### Worktree Management

```bash
worktree list                    # List all discovered worktrees
worktree info [path]             # Show worktree info (env vars, resources)
worktree info --local            # Skip API calls (fast)
worktree delete [path]           # Remove a worktree and clean up
worktree prune                   # Clean up stale ports/state after manual deletion
worktree cleanup                 # Interactive multi-select removal
worktree dotfiles [path]         # Copy gitignored dotfiles from main worktree
worktree ports                   # Show allocated port ranges
```

`delete` removes a worktree and cleans up its port allocation, kubeconfig, and git state. If git refuses to remove the directory (modified/untracked files), it tells you to delete the directory manually and run `worktree prune` to clean up the rest.

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

Jira issues are automatically detected from the PR title, PR body, and branch name when creating a PR worktree. Detected issues are saved to `.worktree-resources`.

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
2. Allocates a unique port range (10 ports starting at 4020, e.g. `4020-4029`)
3. Seeds an isolated kubeconfig at `~/.kube/config-<repo>-<name>`
4. Generates `.worktree-env` with exported environment variables
5. Detects Jira issues from branch name and PR metadata
6. Seeds `.worktree-resources` with PR and Jira associations
7. Adds `.worktree-env` and `.worktree-resources` to `.git/info/exclude`
8. Offers to copy gitignored dotfiles from the main worktree

When an existing review branch is found (e.g. the worktree was previously deleted), the tool shows whether it is up to date with the PR and asks for confirmation before reusing it.

### Per-Worktree Files

#### `.worktree-env`

Auto-sourced by your shell when you `cd` into the worktree (after running `worktree setup`). Run `worktree info` to see the current values and whether auto-sourcing is working.

```bash
export WORKTREE_PORTS=4020-4029
export WORKTREE_TITLE="wt my-branch"
export WORKTREE_PATH=/path/to/worktree
export KUBECONFIG=~/.kube/config-repo-my-branch
```

#### `.worktree-resources`

Tracks associated external resources. Format is stable and tool-agnostic — other tools can read/write it:

```
pr:owner/repo#123 https://github.com/owner/repo/pull/123
jira:PROJ-456 https://your-org.atlassian.net/browse/PROJ-456
~ jira:PROJ-400 https://your-org.atlassian.net/browse/PROJ-400
```

Unmarked lines are **primary** (the reason this worktree exists). Lines prefixed with `~ ` are **related** (watching for context).

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

# Where to search for existing worktrees
search:
  roots:
    - ~/git
  depth: 5
  prune:
    - node_modules
    - .Trash
    - .cache
    - .venv

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
| `WORKTREE_SEARCH_ROOTS` (colon-separated) | `search.roots` |
| `WORKTREE_SEARCH_DEPTH` | `search.depth` |

## Dependencies

**Required:** `git`

**Optional:**
- `gh` (GitHub CLI) — for PR metadata and workflows. Setup checks for this.
- Jira API token — for issue detection and enrichment. Setup configures this.
- [cmux](https://cmux.com/) — for workspace integration with split layouts and browser tabs.

## License

CC0 1.0 Universal — public domain dedication.
