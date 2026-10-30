# CLI reference

← [Back to the README](../README.md) · [Setup guide](setup.md) · [Configuration](configuration.md)

Every command is available as `worktree <command>` or `wt <command>`. Run `worktree <command> --help` for the authoritative flag list. Running `worktree` with no arguments shows help followed by info about the current directory.

- [Worktrees](#worktrees)
- [Resources](#resources)
- [Tasks](#tasks)
- [Web UI](#web-ui)
- [Environment](#environment)
- [Jira](#jira)
- [Polling](#polling)
- [Admin](#admin)
- [For scripts and AI agents](#for-scripts-and-ai-agents)

## Worktrees

```bash
worktree add <arg>               # Create a worktree (see below)
worktree list                    # List worktrees; [open] marks those with a cmux workspace
worktree info [path]             # Branch, environment and resources
worktree info --local            # The same, without any API calls (fast)
worktree open [path]             # Open the worktree in your editor
worktree open --github           # Open its PR in the browser
worktree open --jira             # Open its Jira issue in the browser
worktree delete [path]           # Remove the worktree and clean up after it
worktree delete --delete-branch  # ...and delete its branch too
worktree delete --force          # ...without asking for confirmation
worktree dotfiles [path]         # Copy gitignored dotfiles from the main checkout
worktree cleanup                 # Reconcile the database with what's on disk (asks before removing anything)
```

### `worktree add`

| Argument | Creates |
|---|---|
| `my-feature` | A worktree on a new branch from the current HEAD (offering to `git pull` first) |
| `1234` | A worktree for PR #1234 in the current repo |
| `https://github.com/org/repo/pull/1234` | A worktree for that PR, from your local clone of that repo |
| `https://your-org.atlassian.net/browse/PROJ-56` | A worktree whose branch is named after the issue key |

A bare number is always read as a PR number. A Slack thread URL isn't a worktree, so `add` points you to `worktree resources add` instead, and an existing worktree path points you to `worktree info`.

For a PR, worktree finds your local clone of the PR's repo and picks the remote by URL, not by name, so fork setups with `origin` and `upstream` work. If a branch for the PR already exists (from a worktree you deleted earlier, for example), it shows whether that branch is up to date with the PR and asks before reusing it. Reading a PR needs the GitHub integration to be on.

Creating a worktree:

1. creates the git worktree under `~/.worktrees/<repo>/<name>` (or your `worktrees_base`)
2. reserves a range of 10 ports, starting at 4020
3. seeds a kubeconfig at `~/.kube/config-<repo>-<name>`, copied from your current one
4. registers the worktree and follows its PR and any Jira issues detected from the PR title, body and branch name
5. offers to copy gitignored dotfiles from the main checkout
6. from a cmux pane, offers to open a cmux workspace for it (see [cmux workspaces](#cmux-workspaces)); otherwise prints the `cd` command to enter it

### `worktree delete`

`delete` removes the directory, the port range, the registration, the kubeconfig and git's record of the worktree. It escalates to a forced removal only if git refuses. Deleting the branch is a separate opt-in (`--delete-branch`).

### cmux workspaces

When `worktree add` runs from a [cmux](https://cmux.com/) pane, it offers to open a workspace for the new worktree. It asks for a name (default `wt <branch>`), a group and a color, and lays the workspace out like this:

- **Left:** pinned browser tabs: the PR, then its Jira issues
- **Top right:** a shell, with the worktree's UI page pinned as a tab ahead of it (when `worktree ui` is running on its default port)
- **Bottom right:** a smaller terminal running `worktree info`

If a workspace already exists for that directory, worktree switches to it instead of creating another.

## Resources

A resource is something a worktree follows. There are four types: `pr`, `jira`, `slack` (a thread) and `link` (any web page). A resource is either **Focus** (`primary`: what the worktree is for) or **Related** (followed for context).

```bash
worktree resources list [--json]                   # This worktree's resources
worktree resources add <url> [--related]           # Follow a resource; type and id are inferred from the URL
worktree resources add <type> <id> [--url <url>]   # ...or state them explicitly
worktree resources set-name <type> <id> --name <name> [--description <text>]   # Custom name; empty --name clears it
worktree resources mark-read <type> <id> [--through <RFC3339>]                 # Mark read (for every worktree that follows it)
worktree resources unwatch <type> <id>             # Stop following (kept in history)
worktree resources remove <type> <id>              # Delete the resource outright
```

Every `resources` subcommand except `mark-read` takes `--worktree <path>` to act on a worktree other than the current one.

## Tasks

```bash
worktree tasks add <title> [--description ...] [--priority high|medium|low|none] [--star] [--due YYYY-MM-DD] [--focus <ref>]... [--related <ref>]... [--global]
worktree tasks list [--all | --worktree <path> | --resource <ref>] [--completed] [--archived] [--priority <p>]... [--state <s>]... [--starred]
worktree tasks show <id>                  # Links, subtasks, blockers, what it blocks, and recent history
worktree tasks edit <id> [--title ...] [--description ...] [--priority ...] [--due ...]
worktree tasks state <id> <not_started|in_progress|done>
worktree tasks star <id>                  # or: unstar
worktree tasks delete <id>
worktree tasks undo <event-id>            # Undo a state change, subtask check or delete
worktree tasks move <id> (--after <id> | --before <id> | --top | --bottom)

worktree tasks link <id> <ref> [--focus]  # Related unless --focus
worktree tasks unlink <id> <ref>
worktree tasks focus <id> <ref>           # or: unfocus

worktree tasks subtask add <id> <text>
worktree tasks subtask edit <subtask-id> <text>
worktree tasks subtask check|uncheck|remove <subtask-id>
worktree tasks subtask order <id> <subtask-id>...

worktree tasks block <id> (--task <id> | --resource <ref> | --other <text>)   # Prints the blocker's id
worktree tasks unblock <blocker-id>
worktree tasks resolve <blocker-id> [--unresolve]   # Slack, link and free-text blockers only
```

- **Task ids** look like `T42`. `t42` and `42` work too.
- **A `<ref>`** is a URL, `<type>:<id>`, `wt:<path>`, or `.` for the current worktree.
- **Default links:** `tasks add` inside a registered worktree links it as Focus unless you pass `--focus`, `--related` or `--global`.
- **Default list:** `tasks list` with no scope shows the current worktree's open tasks, or every open task outside a worktree.
- **Filters:** `--priority` and `--state` can be repeated to match any of several values. `--archived` (done tasks whose links are all archived) and `--state done` both imply `--completed`.
- **Blockers:** a task is blocked while any of its blockers is unresolved, and a done task is never blocked.
  - A task blocker resolves as soon as its task is done.
  - A PR or Jira blocker resolves when `worktree ui` sees the PR merged or closed, or the issue reach Done, so it waits for the UI server's next poll.
  - Slack, link and free-text blockers are resolved by hand with `tasks resolve`.
- **Undo:** `tasks undo` takes the `undo_event_id` that the original command returned with `--json`. It exits 1 if the task has changed since then, or if an agent tries to undo a change you made.

## Web UI

```bash
worktree ui                        # Serve on http://127.0.0.1:8475 and open a browser
worktree ui --port 9000            # A different local port
worktree ui --no-open              # Don't open a browser
worktree ui --local-only           # Don't start the HTTPS listener for other devices
worktree ui --api-only             # Serve only the JSON API (for the Vite dev server; implies --local-only)
worktree ui --revoke-all-sessions  # Log out every device, then exit
```

The UI needs `ui.password` to be set, which `worktree setup` does. See the [setup guide](setup.md#web-ui-password-and-remote-access).

## Environment

```bash
worktree env [path]      # Print export lines for a worktree: eval "$(worktree env)"
worktree ports           # Show every allocated port range
```

`worktree env` prints `WORKTREE_PATH`, `WORKTREE_TITLE`, `WORKTREE_PORTS` and `KUBECONFIG`, and nothing at all outside a worktree. The shell hook installed by `worktree setup` runs it each time you change directory.

## Jira

```bash
worktree jira [path]                # Show the worktree's Jira issues, with details from Jira
worktree jira add KEY-123           # Follow an issue as Focus
worktree jira add KEY-456 --related # ...or as Related
worktree jira remove KEY-123
```

## Polling

```bash
worktree watcher run [pr|jira|all]   # Poll followed PRs and Jira issues once
```

You rarely need this. While `worktree ui` is running, it polls every followed PR, Jira issue and Slack thread itself (about every 2 minutes, and again when you open a page whose data is stale). `watcher run` is for scripted refreshes and doesn't poll Slack.

## Admin

```bash
worktree setup               # Interactive setup; safe to re-run
worktree setup --yes         # Non-interactive: accept every default
worktree setup slack         # Test Slack credentials, capturing new ones if needed (--force to always capture)
worktree setup --uninstall   # Undo setup's changes (keeps the config file)
worktree setup --uninstall-mac-app  # Remove only the macOS menu bar app
worktree update              # Self-update (only when installed with go install)
worktree version
worktree completion <shell>  # Shell completions (setup installs these for you)
```

## For scripts and AI agents

- **`--json`:** every `tasks` command and `resources list` take `--json`.
- **`--as-agent`:** on `tasks`, this records a change as made by an AI agent. It's implied when running under Claude Code or agent-handler. Agent changes can notify you in the UI, and an agent can't undo a change you made.
- **Resource JSON:** `resources list --json` is a stable contract, used by [agent-handler](https://github.com/mturley/agent-handler):

  ```json
  [
    {"type":"pr","id":"owner/repo#123","url":"https://github.com/owner/repo/pull/123","primary":true},
    {"type":"jira","id":"PROJ-456","url":"https://your-org.atlassian.net/browse/PROJ-456","primary":true},
    {"type":"jira","id":"PROJ-400","url":"https://your-org.atlassian.net/browse/PROJ-400","primary":false}
  ]
  ```

  `primary: true` means Focus and `false` means Related. Entries can also carry `custom_name`, `custom_description` and `updated_at`.
- **Task JSON:** `tasks list --json` and `tasks show --json` include `blocked`, `blocker_count` and `blocker_labels`. `show` adds `blockers` and `blocks`.
