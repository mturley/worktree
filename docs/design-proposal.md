# Worktree CLI: Design Proposal

A Go-based CLI for managing git worktrees with GitHub/Jira integration and optional cmux support. Replaces the old `worktree-old` bash script with a focused, maintainable tool.

## Design Principles

1. **CLI-first** — Every action is a subcommand with flags. No action requires a REPL.
2. **Standalone by default** — Works in any terminal with no dependencies beyond `git`.
3. **cmux as an upgrade** — When running inside cmux, unlock extra features (workspace management, browser panes).
4. **Tool-agnostic resource tracking** — `.worktree-resources` remains a simple, parseable format other tools can read/write.
5. **Self-contained binary** — Single Go binary with embedded assets. `go install` or `make install` followed by `worktree setup`.

---

## Decisions

### Keep

| Feature | Notes |
|---------|-------|
| **Worktree discovery** | Scan search roots, group by repo, show status (prunable, orphaned, missing) |
| **PR worktree workflow** | Accept PR number or URL, fetch metadata, find/create worktree, set up tracking |
| **Branch worktree workflow** | Accept branch name, create from upstream/main or origin/main |
| **Path-based open** | Accept existing worktree path directly |
| **No-args listing** | Discover and list all worktrees with interactive selection |
| **Cleanup** | Remove worktrees, release ports, prune stale entries |
| **Port range system** | Unique port range per worktree for parallel dev servers |
| `.worktree-env` | Auto-sourced env file (ports, title, path, kubeconfig) |
| `.worktree-resources` | PR/Jira associations with primary/related roles |
| **Isolated kubeconfig** | `~/.kube/config-<repo>-<worktree>` |
| **Shell RC auto-source** | Setup installs the `chpwd` hook; cleanup removes it |
| `.git/info/exclude` | Auto-exclude `.worktree-env`, `.worktree-resources` |
| **GitHub** (via `gh` CLI) | PR metadata, branch detection, open in browser |
| **Jira** (via REST API) | Issue detection from branch/PR, API enrichment, manual association, open in browser |
| **cmux** | Workspace creation with configurable layout, deduplication, browser panes for PR/Jira |
| **Dotfile copying** | On worktree creation, offer to copy gitignored dotfiles from the main clone (replaces the broader file cloning system) |

### Cut

| Feature | Why |
|---------|-----|
| **mprocs integration** | cmux does this better |
| **GNU Screen persistence** | cmux handles persistence natively |
| **iTerm tab titles** | Narrow use case |
| **Nested mprocs sessions** | Gone with mprocs |
| **Multi-arg parallel open** | Unnecessary complexity; single worktree per invocation |
| **Preference caching in /tmp** | Use config file instead |
| **Editor detection/caching** | Use `$EDITOR` or config file |
| **VS Code tasks.json** | Niche |
| **File cloning (node_modules, dist/, bin/)** | Too complex; dotfile copying covers the useful case |
| **python3 dependency** | Go handles JSON natively |
| **osascript notifications** | macOS-only, unnecessary |
| **Powerlevel10k patching** | Fragile and surprising |
| **REPL** | Not in v1. Every action works as a subcommand. May add later if missed. |
| **Claude Code skill** | Overkill for this tool |

---

## CLI Structure

### Primary Commands (Smart Argument Routing)

```
worktree                                    # list/select worktrees (interactive)
worktree <PR-number>                        # create/open PR worktree
worktree <PR-URL>                           # create/open PR worktree (from URL)
worktree <branch-name>                      # create/open branch worktree
worktree <path>                             # open existing worktree
```

"Open" for existing worktrees means: show info and enter the worktree context (cd, set env). For new worktrees: create, seed `.worktree-env` and `.worktree-resources`, offer to copy dotfiles, show info.

### Subcommands

```
worktree info [<path>]                      # show worktree info (default: current dir)
worktree info --local                       # skip API calls (fast)
worktree list                               # list all discovered worktrees
worktree delete [<path>]                    # remove worktree + cleanup
worktree cleanup                            # interactive multi-select removal + stale cleanup
worktree ports                              # show/manage port allocations

worktree open [<path>]                      # open in editor ($EDITOR or configured)
worktree open --github                      # open PR in browser
worktree open --jira                        # open Jira issue(s) in browser

worktree jira [<path>]                      # show/manage Jira associations
worktree jira add <key> [--related]         # associate a Jira issue
worktree jira remove <key>                  # remove a Jira association

worktree setup                              # post-install configuration
worktree setup --uninstall                  # reverse setup changes
worktree update                             # self-update + re-run setup
worktree version                            # print version
```

### Implicit Worktree Context

Most subcommands accept an optional `[<path>]` argument. When omitted, they detect the current worktree from the working directory (via `git rev-parse --show-toplevel` and checking for `.worktree-env`). This means you can `cd` into a worktree and just run `worktree info`, `worktree open --jira`, etc.

---

## Configuration

Config file at `~/.config/worktree/config.yaml` (or `$XDG_CONFIG_HOME/worktree/config.yaml`):

```yaml
# Where worktrees are created (default: ~/.worktrees)
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

# Jira integration
jira:
  host: your-org.atlassian.net
  email: you@example.com
  token_env: JIRA_TOKEN          # env var name (not the token itself)
  projects:
    - RHOAIENG
    - RHOAI
    - ODH

# Editor for `worktree open` (default: $EDITOR)
editor: cursor

# cmux workspace layout (used when creating workspaces inside cmux)
cmux:
  layout:
    # Pane configuration for new workspaces
    # Each pane has a role, position, and optional size
    panes:
      - role: terminal           # worktree shell
        position: left
        size: 50%
      - role: browser            # PR/Jira URLs (only created when URLs are detected)
        position: right
        size: 50%
```

Environment variables still work as overrides for backward compatibility:
- `WORKTREES_BASE` overrides `worktrees_base`
- `WORKTREE_SEARCH_ROOTS` (colon-separated) overrides `search.roots`
- `WORKTREE_SEARCH_DEPTH` overrides `search.depth`

---

## Per-Worktree Files

### `.worktree-env`

Generated on worktree creation. Auto-sourced by shell RC hook when entering the directory.

```bash
# managed by worktree - do not edit
export WORKTREE_PORTS=4020-4029
export WORKTREE_TITLE="wt my-branch"
export WORKTREE_PATH=/Users/me/git/.worktrees/repo/my-branch
export KUBECONFIG=~/.kube/config-repo-my-branch
```

### `.worktree-resources`

Tracks associated external resources. Format is stable and tool-agnostic:

```
pr:owner/repo#123 https://github.com/owner/repo/pull/123
jira:RHOAIENG-456 https://redhat.atlassian.net/browse/RHOAIENG-456
~ jira:RHOAIENG-400 https://redhat.atlassian.net/browse/RHOAIENG-400
```

Unmarked lines are **primary**. Lines prefixed with `~ ` are **related** (context-watching).

---

## Install Experience

Following the agent-handler pattern:

1. **Build:** `make build` compiles to `bin/worktree`
2. **Install:** `make install` copies to `/usr/local/bin/worktree` (atomic write) and runs `worktree setup`
3. **Alternative:** `go install github.com/mturley/worktree@latest` then `worktree setup`
4. **Setup** (`worktree setup`):
   - Dry-run preview of all changes, prompt for confirmation
   - Create `worktrees_base` directory if needed
   - Add `.worktree-env` auto-source snippet to shell RC (zsh/bash/fish)
   - Create default config file if none exists
   - `--yes` flag for non-interactive use
5. **Uninstall** (`worktree setup --uninstall`):
   - Remove shell RC snippet
   - Remove config file (with confirmation)
   - Preserve worktree data (with instructions for full removal)
6. **Update** (`worktree update`):
   - Detect install method (go install vs manual)
   - Run `go install @latest` or prompt for manual update
   - Re-run `worktree setup`

---

## Project Structure (Go)

```
worktree/
  cmd/                        # cobra commands
    root.go                   # root command, smart argument routing
    info.go
    list.go
    delete.go
    cleanup.go
    ports.go
    open.go
    jira.go
    setup.go
    update.go
    version.go
  internal/
    config/                   # YAML config + env var overrides
    discovery/                # worktree discovery across search roots
    git/                      # git operations (worktree create/remove, branch, fetch)
    github/                   # gh CLI wrapper for PR operations
    jira/                     # Jira REST API client
    ports/                    # port range allocation
    resources/                # .worktree-resources file read/write
    env/                      # .worktree-env file generation
    dotfiles/                 # gitignored dotfile copying
    cmux/                     # cmux workspace integration
    setup/                    # shell RC integration, git exclude management
    ui/                       # terminal output (colors, spinners, prompts)
  embedded/                   # go:embed files (shell snippets, templates)
  Makefile
  go.mod
  main.go
```

---

## Dependencies

### Required
- `git` — core worktree operations

### Optional
- `gh` — GitHub PR operations (graceful degradation without it)
- Jira credentials — for Jira API enrichment
- cmux — for workspace integration

### Removed (vs old script)
- python3, mprocs, GNU Screen >= 5.0, curl, lsof

---

## Dotfile Copying

When creating a new worktree, the tool offers to copy gitignored dotfiles (top-level hidden files/dirs like `.env.local`, `.husky`, etc.) from the main clone. This replaces the old script's broader file cloning system.

**Behavior:**
1. Discover top-level gitignored dotfiles in the main worktree (excluding `.git`)
2. Show a list and prompt for confirmation (select all, select specific, or skip)
3. Copy using `cp -Rc` on macOS (APFS copy-on-write) or `cp -r` elsewhere
4. No caching of selections — prompt each time (simple and predictable)

Available as part of the create flow and as a standalone `worktree dotfiles [<path>]` subcommand for copying into existing worktrees.

---

## Info Display

`worktree info` shows a unified view:

```
my-branch (review/pr-1234-fix-pagination)
  Path:     ~/git/.worktrees/my-repo/review-pr-1234
  Repo:     my-org/my-repo
  Tracking: origin/my-branch (2 ahead, 0 behind)
  Ports:    4020-4029
  Kube:     ~/.kube/config-my-repo-review-pr-1234

  PR #1234: Fix pagination in list view
    Author: @someone · Created 3 days ago · Updated 1 hour ago
    Status: Open · Review: Changes requested

  Jira: RHOAIENG-5678 — Pagination breaks on page 3
    Type: Bug · Priority: Major · Status: In Progress · Assignee: Someone
  Related:
    ~ RHOAIENG-5600 — List view performance improvements
```

`worktree info --local` skips the PR and Jira API calls (shows only path, repo, tracking, ports, kube, and cached resource keys without enrichment).

The `.worktree-env` auto-source shows a compact one-liner:
```
[wt] my-branch · ~/git/.worktrees/my-repo/review-pr-1234 · ports 4020-4029
```
