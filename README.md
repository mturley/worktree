# worktree

CLI for managing git worktrees with GitHub/Jira integration and optional cmux support.

Create, discover, and manage git worktrees with automatic port allocation, isolated kubeconfigs, and one-command PR review workflows.

## Install

### From source

```bash
git clone https://github.com/mturley/worktree.git
cd worktree
make build
make install    # installs to /usr/local/bin and runs setup
```

### Via `go install`

```bash
go install github.com/mturley/worktree@latest
worktree setup
```

### Setup

`worktree setup` configures your environment:

- Creates the worktrees directory (default: `~/.worktrees`)
- Adds a `.worktree-env` auto-source snippet to your shell RC (zsh, bash, or fish)
- Creates a default config file at `~/.config/worktree/config.yaml`

Run `worktree setup --uninstall` to reverse all setup changes.

## Quick Start

```bash
# Create a worktree for a new branch
worktree my-feature-branch

# Create a worktree for a PR (by number or URL)
worktree 1234
worktree https://github.com/org/repo/pull/1234

# Create a worktree for a Jira issue
worktree https://redhat.atlassian.net/browse/RHOAIENG-5678

# List all discovered worktrees
worktree list

# Show info about the current worktree
worktree info
```

## Usage

### Smart Argument Routing

The root `worktree` command detects what you're passing and does the right thing:

| Input | Action |
|-------|--------|
| (no args) | List all worktrees with interactive selection |
| `1234` | Create/open a worktree for PR #1234 |
| `https://github.com/.../pull/1234` | Create/open a worktree for the linked PR |
| `https://...atlassian.net/browse/KEY-123` | Create a worktree with the Jira key as the branch name |
| `my-feature` | Create a worktree for a new branch from upstream/main |
| `/path/to/worktree` | Show info for an existing worktree |

### Commands

#### Worktree Management

```bash
worktree list                    # List all discovered worktrees
worktree info [path]             # Show worktree info (branch, ports, resources)
worktree info --local            # Skip API calls (fast)
worktree delete [path]           # Remove a worktree and clean up
worktree cleanup                 # Interactive multi-select removal
worktree dotfiles [path]         # Copy gitignored dotfiles from main worktree
worktree ports                   # Show allocated port ranges
```

#### Open in Editor or Browser

```bash
worktree open [path]             # Open in editor ($EDITOR or configured)
worktree open --github           # Open the associated PR in browser
worktree open --jira             # Open the associated Jira issue in browser
```

#### Jira Integration

```bash
worktree jira [path]             # Show associated Jira issues
worktree jira add KEY-123        # Associate a Jira issue (primary)
worktree jira add KEY-456 --related  # Associate as context-watching
worktree jira remove KEY-123     # Remove an association
```

#### Admin

```bash
worktree setup                   # First-time setup
worktree setup --uninstall       # Reverse setup changes
worktree update                  # Self-update (if installed via go install)
worktree version                 # Print version
```

## What Happens When You Create a Worktree

When you run `worktree <arg>`, the tool:

1. Creates the git worktree under `~/.worktrees/<repo>/<name>`
2. Allocates a unique port range (10 ports starting at 4020, e.g. `4020-4029`)
3. Seeds an isolated kubeconfig at `~/.kube/config-<repo>-<name>`
4. Generates `.worktree-env` with exported environment variables
5. Seeds `.worktree-resources` with PR/Jira associations (if applicable)
6. Adds `.worktree-env` and `.worktree-resources` to `.git/info/exclude`
7. Offers to copy gitignored dotfiles from the main worktree
8. Prints the worktree info and path

### Per-Worktree Files

#### `.worktree-env`

Auto-sourced by your shell when you `cd` into the worktree (after running `worktree setup`):

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
jira:RHOAIENG-456 https://redhat.atlassian.net/browse/RHOAIENG-456
~ jira:RHOAIENG-400 https://redhat.atlassian.net/browse/RHOAIENG-400
```

Unmarked lines are **primary** (the reason this worktree exists). Lines prefixed with `~ ` are **related** (watching for context).

## Configuration

Config file at `~/.config/worktree/config.yaml`:

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

# Jira integration
jira:
  host: your-org.atlassian.net
  email: you@example.com
  token_env: JIRA_TOKEN
  projects:
    - MYPROJECT
```

### Environment Variable Overrides

For backward compatibility, these env vars override config file values:

| Variable | Overrides |
|----------|-----------|
| `WORKTREES_BASE` | `worktrees_base` |
| `WORKTREE_SEARCH_ROOTS` (colon-separated) | `search.roots` |
| `WORKTREE_SEARCH_DEPTH` | `search.depth` |

## Dependencies

**Required:** `git`

**Optional:**
- `gh` (GitHub CLI) — for PR metadata and workflows
- Jira credentials — for Jira API enrichment
- cmux — for workspace integration (coming soon)

## License

CC0 1.0 Universal — public domain dedication.
