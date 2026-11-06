---
name: worktree
description: Use when the user asks about their worktrees, PRs, Jira issues, Slack threads, tasks, unread activity, or "what needs my attention" — answers from the worktree CLI's local database.
---

# worktree

The `worktree` CLI manages the user's git worktrees and the PRs, Jira issues and
Slack threads each one follows. Its web UI polls those services into a local
database, and these commands read that database. They need no server or login.

## Start here

Run `worktree status --json` first. It gives `ui_running`, `ui_url`, `stale`,
`stale_reason[]` and `services[]` (each with `name`, `enabled`, `stale`, and when they
apply `last_success`, `error` and `reason`; absent means none).

New activity only arrives while `worktree ui` is running. Only a service with
resources to poll can be stale; one with none is fine even if it never polled. If
`stale` is true, say why and how old the data is, then answer from the cache anyway:

- `ui_running` is false (`ui_not_running`): tell the user to start `worktree ui` so
  the watchers poll. Never start it yourself.
- `ui_running` is true: starting it won't help, so look at the stale service.
  `poll_failing` means its poll is erroring: quote its `error`, and if that looks like
  expired or rejected credentials, tell the user to re-run `worktree setup`.
  `no_success_yet` means it has not polled successfully, which is normal for a couple
  of minutes after the UI starts and otherwise usually means missing credentials
  (`worktree setup`). `poll_old` means polling stopped; suggest the Logs tab in Settings.

Read commands never create or upgrade the database, so `status` can exit 2. Tell the
user what the error says and stop: with "no worktree database yet", they need to run
`worktree setup` or `worktree ui`; with "database needs upgrading", they need to start
`worktree ui`. Both are theirs to run, and there is no cache to answer from
until then.

## Reading output

- Always pass `--json`. Every JSON output is an object with `schema_version` and
  named fields.
- Exit 0 is success. Exit 1 means nothing was found, and is a real answer, not a
  failure: `attention` with nothing to show, `activity --unread` with no unread
  events, `pr-threads list` when the branch has no open PR. Exit 2 is an error.
- `unread` always exits 0.
- In any output carrying resources, `updated_at` is when the custom name was set
  (absent if never), and `resource_updated_at` is the resource's own time. Its format
  depends on the source: RFC 3339 for PRs, `2026-10-21T14:12:17.410+0000` for Jira,
  and a Slack timestamp (`1787257539.775119`) for Slack. Parse by resource type, and
  don't compare it across types.

## "What's going on?" and "what needs me?"

Run `worktree attention --json`. It returns `items[]`, in a fixed order, plus
`status`. Each item has `kind` (`resource` or `task`), `signals`, `priority_rank`,
`events`, and a `resource` or `task` object. Signals are `review_requested`,
`changes_requested`, `ci_failing`, `needs_rebase`, `assigned_to_you`, `mentioned`, `stale_draft`,
`task_due_soon` and `blocker_resolved`. Event bodies are cut to 500 characters.

The list is a starting point, not the answer:

1. Read each item's `events` and judge whether it actually needs a response. A
   bot comment or an FYI usually doesn't.
2. Group a PR with its Jira issue, and related items together.
3. Lead with the lowest `priority_rank` (the most critical).
4. Keep it short, and link each item's URL.

Add `--worktree .` to cover only the current worktree.

## Drill-downs

**What happened since yesterday (standup):** `worktree activity --since 24h --json`.
Narrow with `--unread`, `--source github` (or `jira`, `slack`, `tasks`),
`--worktree .`, `--resource <url>` and `--limit`. Use `--since 72h` after a weekend.

**Where is X?** `worktree resources list --all --json` lists every followed
resource once, with the worktrees following it.

**Which worktrees can go?** `worktree list --json --git`. A worktree is a candidate
only when all of these hold:

- `focus_resources` has at least one entry. A worktree with none has nothing to say
  it's finished, so it isn't a candidate.
- Every focus resource is done: a PR's `state` is `MERGED` or `CLOSED` (`OPEN` is not),
  and a Jira issue's `status` means finished, such as `Closed`, `Resolved` or `Done`
  (the names vary by project). A Slack thread has no done state, so leave that call to
  the user.
- `git.dirty` is false and `git.ahead` is 0, with `git.upstream` present. `ahead` means
  commits not pushed, and it says nothing when there is no upstream.

A worktree with no `git` field (`on_disk` is false, or git couldn't read it) can't be
judged from this output, so say it needs a look. All of this is a suggestion to the
user. Show them the list with your reasons; never delete anything yourself.

**Where did I leave off?** For a worktree (the current one by default):

- `worktree info --json` for git state and resources
- `worktree notes show --json` for the user's notes
- `worktree review-comments list --json` for draft review comments

**What's running?** `worktree ports --listening --json` attributes listening ports
to worktrees.

**What's unread?** `worktree unread --json --by worktree`, or `--by resource`.

**Tasks:** `worktree tasks list --all --json`, then `worktree tasks show <id> --json`.

**Jira issues of a worktree, from the cache:** `worktree jira --json`.

## Live commands: on request only

These contact GitHub, Jira or Slack, so don't run them by default. Use them when the
user asks about something the cache doesn't hold:

- `worktree pr-threads list --json` shows review threads on the branch's open PR.
- `worktree linked <url> --json` shows what a PR, Jira issue or Slack thread links to.

## Never write without the user's explicit permission

Do not change anything unless the user has plainly asked for that change. Finding
something that looks stale, read or finished is not permission. When you think a
write would help, say so and ask. Always pass `--as-agent` on a write. `tasks` commands
record it as made by an agent; other commands accept the flag and record nothing.

These are the writes:

- `worktree resources mark-read`, `worktree resources add`, `worktree resources remove`,
  `worktree resources unwatch`, `worktree resources set-name`
- `worktree activity mark-read`, which marks one event read (`--undo` takes it back),
  and `worktree activity mark-unread`, which marks one unread even behind its cursor
- `worktree notes set`
- `worktree tasks add`, `worktree tasks edit`, `worktree tasks state`,
  `worktree tasks star`, `worktree tasks unstar`, `worktree tasks block`,
  `worktree tasks unblock`, `worktree tasks resolve`, `worktree tasks link`,
  `worktree tasks unlink`, `worktree tasks focus`, `worktree tasks unfocus`,
  `worktree tasks move`, `worktree tasks delete`, `worktree tasks undo`
- `worktree tasks subtask add`, `worktree tasks subtask check`,
  `worktree tasks subtask uncheck`, `worktree tasks subtask edit`,
  `worktree tasks subtask order`, `worktree tasks subtask remove`
- `worktree jira add`, `worktree jira remove`
- `worktree add`, `worktree delete`, `worktree cleanup`, `worktree dotfiles`
- `worktree watcher run`
- `worktree open` and `worktree ui` act on the user's machine: they open an editor
  or browser, or start a server.

Read state is shared with the web UI: marking something read changes what the user
sees there, for every worktree following it. Slack read state is Slack's. `mark-read`
skips Slack threads and `activity mark-read` and `mark-unread` refuse Slack events, so
nothing here can change a thread's read state.

Never install or uninstall anything: no `worktree setup`, no `worktree setup slack`,
no `worktree update`.
Those are the user's to run.
