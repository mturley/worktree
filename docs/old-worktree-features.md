# Old Worktree Script: Complete Feature Catalog

This document catalogs every feature of the old `worktree` bash script (now `worktree-old` in `~/git/work-scripts/`) to inform the design of the new Go-based `worktree` CLI.

## Source Files

| File | Lines | Role |
|------|-------|------|
| `src/worktree-old/worktree.sh` | 1421 | Main script |
| `lib/helpers.sh` | 2908 | Shared library (bulk of the logic) |
| `lib/worktree-ensure.sh` | 142 | Worktree creation helper |
| `lib/clone-worktree-files.sh` | 162 | File cloning helper |
| `lib/load-env.sh` | 60 | Environment/secrets loader |
| `lib/mprocs-motd.sh` | 39 | mprocs keybinding cheat sheet |
| `lib/claude-sessions.sh` | 133 | Claude Code session lookup (not used by worktree) |

Total: ~4,800 lines of bash across 6 files.

---

## 1. Entry Modes (Argument Types)

The script accepts these argument forms, which can be mixed freely:

| Input | Behavior |
|-------|----------|
| No arguments | List all discovered worktrees grouped by repo. Interactive selection by number (single, comma-separated like `1,3,5`, or `all`). If already inside a worktree directory, drops directly into the REPL. |
| PR number (e.g. `1234`) | Fetches PR metadata via `gh pr view`, finds or creates a worktree for that PR. |
| GitHub PR URL | Extracts owner/repo/PR number from URL. Auto-locates the matching local clone across `~/` if not in the right repo. |
| Branch name (e.g. `my-feature-branch`) | Creates a new branch from `upstream/main` or `origin/main`, or reuses an existing one. |
| Worktree path | Opens an existing worktree directly. |
| Multiple arguments | Opens all specified worktrees in parallel mprocs panes. |

## 2. CLI Flags

| Flag | Description |
|------|-------------|
| `-h`, `--help` | Show full usage help |
| `--open` | Auto-open editor on REPL entry |
| `--info` | Show full worktree info (PR + Jira status via API calls), then exit |
| `--info-simple` | Show fast info (no API calls — branch, path, env, oc context), then exit |
| `--ports` | Show allocated port ranges, offer to free stale ones |
| `--no-persist` | Skip GNU Screen wrapping (mprocs only, no persistence) |
| `-s`, `--standalone` | Skip mprocs/screen entirely, just exec a shell in the worktree |
| `--sessions` | List active persistent (screen) worktree sessions |
| `--kill-session <name>` | Kill a persistent session and clean up its temp files |
| `--cleanup` | Interactive multi-select of worktrees to remove + clean up stale files |
| `--cleanup-prefs` | Clean up saved preferences only |

Flags can appear in any position among arguments.

## 3. Interactive REPL

The core interactive experience. Single-letter shortcuts and full words both work.

### Navigation
- `h` / `help` — Show help
- `i` / `info` — Re-gather and display full worktree info (PR, Jira, git status, tracking, environment)
- `l` / `log` — Run `git log --oneline --graph --decorate`
- `q` / `quit` / `exit` — Exit the REPL

### Manage
- `f` / `files` — Clone gitignored files from the main worktree (dotfiles, node_modules, dist/, bin/). Three modes: all, config-only, nothing. Per-repo cached selections. APFS copy-on-write on macOS, rsync on other platforms.
- `p` / `prefs` / `preferences` — Show all saved preferences with values, optionally clean them up
- `n` / `name` — Rename the mprocs pane or cmux workspace
- `d` / `delete` — Remove the worktree, release port range, prune git worktree list, clean up git exclude

### Open
- `e` / `editor` — Open worktree in editor (VS Code, Cursor, Zed detection + caching)
- `s` / `shell` — Start a shell in the worktree (inline subshell or nested mprocs)
- `c` / `claude` — Start Claude Code in the worktree
- `g` / `github` — Open PR URL in browser
- `j` / `jira` — Open associated Jira issue(s). Picker for multiple. Manual association with primary/related roles.

### REPL Prompt
Shows branch name and tracking remote:
```
worktree [my-branch...origin/my-branch]>
```

## 4. Worktree Discovery

Searches across all `WORKTREE_SEARCH_ROOTS`, finds `.git` directories up to `WORKTREE_SEARCH_DEPTH`, queries each repo for its worktree list via `git worktree list --porcelain`. Populates parallel arrays with path, branch, repo, label, and prunable status. Marks orphaned and prunable worktrees. Prunes directories matching `WORKTREE_SEARCH_PRUNE`.

## 5. PR Worktree Workflow

1. Parse PR number from argument (number or URL)
2. Locate the matching local repo (searches current repo, nested repos, then `~/`)
3. Fetch PR metadata via `gh pr view` (number, title, URL, head ref, head owner, author, timestamps)
4. Fetch PR's latest commit into `refs/pr-review/<number>` (avoids FETCH_HEAD race)
5. Search for related worktrees (by PR's head ref or `review/pr-*` pattern)
6. If one found: reuse with sync check (offers reset-to-latest or keep-as-is, with backup branch)
7. If multiple found: show picker with commit info and ahead/behind status
8. If none found: check for existing local branch, offer to reuse or create new `review/pr-<number>-<slug>`
9. Set up branch tracking against the PR author's remote
10. Enter REPL

## 6. Branch Worktree Workflow

1. Resolve repo root (handles nested repos with interactive picker)
2. Fetch `upstream/main` or `origin/main` and create branch with `--no-track`
3. Handle status: `created`, `reused-branch`, `exists` (offer to recreate), `exists-elsewhere` (offer to move)
4. Enter REPL

## 7. Files Created/Managed

### Per-Worktree Files

| File | Purpose |
|------|---------|
| `.worktree-env` | Auto-sourced env file exporting `WORKTREE_PORTS`, `WORKTREE_TITLE`, `WORKTREE_PATH`, `KUBECONFIG`. Shows info on first shell load. |
| `.worktree-resources` | Tracks PR and Jira associations. Format: `<type>:<id> <url>`, with `~ ` prefix for related resources. |
| `~/.kube/config-<repo>-<worktree>` | Isolated kubeconfig, seeded from current kubeconfig on first setup. |
| `.vscode/tasks.json` | Optional auto-REPL task for VS Code/Cursor. |

### Global Files

| File | Purpose |
|------|---------|
| `$WORKTREES_BASE/.port-ranges` | Port range allocation table. |
| `.git/info/exclude` | Modified to add `.worktree-env`, `.worktree-resources`, `.vscode/` between managed markers. |
| `~/.zshrc` / `~/.bashrc` / `~/.config/fish/config.fish` | Optional auto-source snippet for `.worktree-env`. |
| `~/.p10k.zsh` | Optionally changes `POWERLEVEL9K_INSTANT_PROMPT` to `quiet`. |

### Temp Files (in `/tmp`)

Numerous cached preference files (`worktree-editor-preference`, `worktree-zed-window-preference`, etc.), mprocs configs, screen configs, socket files, and launch scripts. All keyed by PID or session name.

## 8. Port Range System

Each worktree gets a unique range of 10 ports starting at 4020. Port range 4010-4019 is reserved for the main checkout. Allocations tracked in `$WORKTREES_BASE/.port-ranges`. Released on worktree deletion. Viewable/freeable via `--ports`.

## 9. Environment Variables

### User-Configurable

| Variable | Default | Purpose |
|----------|---------|---------|
| `WORKTREES_BASE` | `~/git/.worktrees` | Root directory for worktree storage |
| `WORKTREE_SEARCH_ROOTS` | `~/git` | Colon-separated roots for discovery |
| `WORKTREE_SEARCH_DEPTH` | `5` | Max find depth |
| `WORKTREE_SEARCH_PRUNE` | `node_modules:.Trash:.cache:.venv:venv` | Dirs to skip |
| `WORKTREE_PERSISTENT` | `true` | Whether to wrap mprocs in GNU Screen |
| `WORKTREE_HIDE_KEYMAP` | `true` | Hide mprocs keymap pane |

### Exported Per-Worktree (via `.worktree-env`)

| Variable | Purpose |
|----------|---------|
| `WORKTREE_PORTS` | Assigned port range (e.g. `4020-4029`) |
| `WORKTREE_TITLE` | Human-readable title |
| `WORKTREE_PATH` | Absolute path to the worktree |
| `KUBECONFIG` | Isolated kubeconfig path |

### Jira Credentials (loaded from secrets file)

`JIRA_HOST`, `JIRA_EMAIL`, `JIRA_TOKEN`, `JIRA_PROJECTS`

## 10. Jira Integration

**Detection sources:** cached `.worktree-resources`, branch name scanning, PR title/body scanning.

**API enrichment:** fetches summary, type, status, assignee, priority with emoji indicators and color coding. Falls back silently on API failure.

**Manual association:** via REPL `j` command. Validates against configured project prefixes. Supports primary (replaces) or related (appended) role. Persists to `.worktree-resources`.

## 11. GitHub Integration

- `gh pr view` for PR metadata (title, URL, head ref, author, timestamps)
- `gh pr list` for PR detection by branch name
- Fetch PR commits into isolated refs (`refs/pr-review/<number>`)
- Open PR URL in browser via `open` command

## 12. External Tool Integrations

| Tool | Usage |
|------|-------|
| **git** | Core worktree management, branch operations, fetch, log, status |
| **gh** | PR metadata, PR detection by branch |
| **python3** | JSON parsing, HTML comment stripping, cmux RPC parsing |
| **mprocs** | Multi-pane terminal multiplexer with socket-based control |
| **screen** (GNU >= 5.0) | Persistence layer wrapping mprocs |
| **cmux** | Alternative workspace manager with split layouts and RPC |
| **curl** | Jira REST API calls |
| **iTerm2** | Tab title setting via escape sequences |
| **VS Code / Cursor** | Editor integration with optional `.vscode/tasks.json` |
| **Zed** | Editor integration (same/new window) |
| **Claude Code** | `claude` command launched from REPL |
| **oc** | OpenShift CLI for cluster context display |
| **osascript** | macOS notification on clone completion |
| **lsof** | Port availability check |

## 13. cmux Integration

When `CMUX_SOCKET_PATH` is set, uses cmux workspaces instead of mprocs/screen:

- **Layout:** Top-left (1/3 height) = REPL, Bottom-left (2/3 height) = Claude Code, Right (50% width, optional) = browser tabs for PR/Jira URLs
- **Persistence:** handled natively by cmux
- **Deduplication:** checks existing workspaces by working directory
- **Discovery:** shows `[open]` marker for worktrees with existing cmux workspaces

## 14. Persistence System (GNU Screen + mprocs)

- Single canonical screen session named `wt-all`
- mprocs runs inside screen via wrapper script with EXIT trap
- Detach with `Ctrl+a d`, reattach with `worktree <args>` or `screen -r wt-all`
- Multi-attach support (shared screen sessions)
- Automatic merging of existing worktrees into persistent session

## 15. Cleanup System

Comprehensive cleanup via `--cleanup`:
1. Multi-select worktrees to remove
2. Release port ranges, remove worktrees, clean up kubeconfigs
3. Prune git worktree lists, clean up git exclude entries
4. Remove empty project subdirectories
5. Check for stale port range entries
6. Offer to kill persistent screen session
7. Clean up stale mprocs config files in `/tmp`
8. Offer to clean up saved preferences
9. Offer to remove shell RC auto-source snippet

**Automatic stale cleanup** runs on every invocation (dead PID detection).

## 16. File Cloning System

Discovers cloneable gitignored content: dotfiles (top-level hidden files/dirs) and directories (node_modules, dist/, bin/). Uses APFS copy-on-write on macOS, rsync elsewhere. Cached selections per repo. Background execution with spinner.

## 17. Shell RC Integration

Adds auto-source snippet for `.worktree-env` to shell RC file. Supports zsh (with `chpwd` hook), bash, and fish (with `--on-variable PWD`). Optionally patches Powerlevel10k instant prompt. Revertible via `--cleanup`.
