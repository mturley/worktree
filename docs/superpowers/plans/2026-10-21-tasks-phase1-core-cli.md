# Tasks Phase 1 — Core + CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store tasks (with links, subtasks, master ordering and an activity history) in worktree's DB, and expose all of it through a `worktree tasks` CLI that agents can drive.

**Architecture:** A new pure-DB package `internal/tasks` owns four new worktree-owned tables and every rule (state timestamps, Focus/Related links, fractional-index ordering, membership and archived computation, event recording with an actor). `cmd/tasks*.go` is a thin cobra layer over it. Later phases (web UI, modal, activity/unread, blockers, undo) build on this package; nothing here touches `internal/webui`.

**Tech Stack:** Go, SQLite (`modernc.org/sqlite` via `internal/db`), cobra.

**Spec:** `docs/superpowers/specs/2026-10-21-tasks-design.md`

**Phasing (this plan is Phase 1 of 6; the tracker is the spec's "Phases" section — set Phase 1 to "done" there in the final commit):** 1 Core + CLI · 2 Task lists in the UI (API, tabs, rows, quick add, sort/filter, drag, pin, badges, search) · 3 Detail modal + linked events + "＋ task" · 4 Activity integration (feeds, unread, mark-read, notifications) · 5 Blockers (holds, watcher `status_category` release, Unblocked notifications) · 6 Undo (state/subtask/delete, cascades, purge sweep). Blocker and event-link tables are added by their phases, not here.

## Global Constraints

- States are exactly `not_started`, `in_progress`, `done`; priorities exactly `high`, `medium`, `low`, `none`.
- Due dates are dates only: `YYYY-MM-DD`, or absent.
- `started_at` is set when state first becomes `in_progress` (or `done`, if it skipped straight there) and cleared on returning to `not_started`. `completed_at` is set on entering `done` and cleared on leaving it.
- Links point at a resource (type + id) or a worktree. Each is Focus (`is_primary = 1`) or Related. Any number may be Focus, including none. Removing a Focus link promotes nothing.
- A task created from a context gets that context as Focus. Links added later default to Related.
- One master order for all tasks. Moves rewrite only the moved row.
- Worktree identity always goes through `wdb.Subscriber` canonicalisation (CLAUDE.md "Gotcha"). Store the canonical path (`wdb.WorktreePathFromSubscriber(wdb.Subscriber(p))`).
- A resource counts as "followed" only through `watcher_subscriptions` rows whose subscriber starts with `worktree:` and whose `deleted_at IS NULL`. Ignore every other subscriber prefix (Phase 5 adds `task:`).
- Task events record `actor` = `user` | `agent` and an optional `actor_session`. CLI: `agent` when `CLAUDECODE` is non-empty, or `HANDLER_SESSION_ID` is non-empty (which is also the session), or `--as-agent` is passed. Otherwise `user`.
- Task events live in the worktree-owned `task_events` table, never `watcher_events`.
- Every CLI command takes `--json`. Display task IDs as `T<n>`, and accept `T<n>`, `t<n>` or `<n>`.
- Commits: `git commit --signoff`, with message trailer lines `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01HAFCNa6UnHnRzp1mmxFzto`. Add files by name, never `git add -A`.

## Review Focus

1. **Repeated insertion at one spot.** Dragging task after task into the same gap must keep producing strictly ordered keys. Test: 200 consecutive `KeyBetween(a, k)` calls (Task 1).
2. **Symlinked worktree paths.** A link created through a symlinked path must match the registry and subscriptions written through the real path. Test: `TestWorktreeLinkCanonicalisesSymlink` (Task 4).
3. **Orphaned tasks.** An open task whose resource is followed by nothing and whose worktree is deleted must still appear in the all-scope, marked archived. A completed one appears only with `IncludeArchived`. Tests: `TestListArchivedFallback` and `TestListCompletedArchivedHidden` (Task 4).
4. **Bad input never half-writes.** Unknown state or priority, malformed due date (`2026-13-01`) and empty title are rejected with an error, and no row or event is written. Test: `TestRejectsInvalidInput` (Task 2).
5. **Re-linking is idempotent.** Adding an existing link again doesn't duplicate it or write an event; with a different group it behaves as a group toggle. Test: `TestAddLinkTwice` (Task 4).

---

### Task 1: Fractional-index keys

**Files:**
- Create: `internal/tasks/rank.go`
- Test: `internal/tasks/rank_test.go`

**Interfaces:**
- Produces: `func KeyBetween(a, b string) (string, error)`. `""` for `a` means "before everything", and `""` for `b` means "after everything". It returns a key strictly between them under plain Go string comparison, and an error when `a != "" && b != "" && a >= b`.

- [ ] **Step 1: Write the failing tests**

```go
func TestKeyBetweenOrders(t *testing.T) {
	cases := [][2]string{{"", ""}, {"", "V"}, {"V", ""}, {"V", "W"}, {"V", "V1"}, {"Vz", "W"}, {"1", "2"}}
	for _, c := range cases {
		k, err := KeyBetween(c[0], c[1])
		if err != nil { t.Fatalf("%q,%q: %v", c[0], c[1], err) }
		if (c[0] != "" && !(c[0] < k)) || (c[1] != "" && !(k < c[1])) {
			t.Fatalf("KeyBetween(%q,%q) = %q not strictly between", c[0], c[1], k)
		}
		if strings.HasSuffix(k, "0") { t.Fatalf("key %q ends in the zero digit", k) }
	}
}

func TestKeyBetweenRepeatedInsertStaysOrdered(t *testing.T) {
	a, b := "", "V"
	for i := 0; i < 200; i++ {
		k, err := KeyBetween(a, b)
		if err != nil || !(k < b) || (a != "" && !(a < k)) { t.Fatalf("iter %d: %q (%v)", i, k, err) }
		b = k // always insert at the very top
	}
	a, b = "V", "W"
	for i := 0; i < 200; i++ {
		k, _ := KeyBetween(a, b)
		if !(a < k && k < b) { t.Fatalf("iter %d: %q", i, k) }
		a = k // always insert just above "W"
	}
}

func TestKeyBetweenRejectsInverted(t *testing.T) {
	if _, err := KeyBetween("W", "V"); err == nil { t.Fatal("want error") }
	if _, err := KeyBetween("V", "V"); err == nil { t.Fatal("want error") }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test ./internal/tasks/ -run KeyBetween`
Expected: FAIL (`KeyBetween` undefined)

- [ ] **Step 3: Implement `KeyBetween` in `internal/tasks/rank.go`**

The alphabet is base-62 `0-9A-Za-z` in ASCII order, so string comparison is numeric comparison of the fraction `0.<digits>`. Keys never end in `'0'`. Midpoint algorithm, recursive over digits (`base = 62`, and digit `0` for a position past the end of `a`):

```go
// midpoint returns a digit string strictly between a and b (b == "" means 1.0).
func midpoint(a, b string) string {
	if b != "" {
		n := 0 // shared prefix, treating a's missing digits as '0'
		for n < len(b) && digitAt(a, n) == b[n] { n++ }
		if n > 0 { return b[:n] + midpoint(tail(a, n), b[n:]) }
	}
	da := 0
	if a != "" { da = idx(a[0]) }
	db := base
	if b != "" { db = idx(b[0]) }
	if db-da > 1 { return string(alphabet[(da+db)/2]) }
	if b != "" && len(b) > 1 { return b[:1] }
	return string(alphabet[da]) + midpoint(tail(a, 1), "")
}
```

`KeyBetween` validates its arguments and returns `midpoint(a, b)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/tasks/ -run KeyBetween`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/tasks/rank.go internal/tasks/rank_test.go
git commit --signoff -m "feat(tasks): fractional-index keys for the master task order" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HAFCNa6UnHnRzp1mmxFzto"
```

---

### Task 2: Schema, task CRUD, state rules, events with actor

**Files:**
- Modify: `internal/db/migrate.go` (append to `stmts`)
- Create: `internal/tasks/tasks.go` (types, Create/Get/Update/SetState/Delete)
- Create: `internal/tasks/events.go` (event types, `record`, `Events`)
- Test: `internal/tasks/tasks_test.go`, `internal/tasks/events_test.go`

**Interfaces:**
- Consumes: `KeyBetween` (Task 1).
- Produces:

```go
type State string    // StateNotStarted "not_started", StateInProgress "in_progress", StateDone "done"
type Priority string // PriorityHigh "high", PriorityMedium "medium", PriorityLow "low", PriorityNone "none"
type Actor struct{ Kind string; Session string } // Kind: ActorUser "user" | ActorAgent "agent"

type Task struct {
	ID          int64
	Title       string
	Description string
	State       State
	Priority    Priority
	Starred     bool
	Due         string // "YYYY-MM-DD" or ""
	Rank        string
	CreatedAt, UpdatedAt, StartedAt, CompletedAt string // RFC3339 UTC; "" when unset
	Links    []Link    // filled by Get/List (Task 4)
	Implicit []string  // canonical worktree paths reached via live resource links (Task 4)
	Archived bool      // every link archived (Task 4); false for a global task
	Subtasks []Subtask // filled by Get/List (Task 5)
}

type NewTask struct{ Title, Description string; Priority Priority; Starred bool; Due string; Focus []LinkTarget }
func Create(conn *sql.DB, a Actor, n NewTask) (Task, error)   // appended at the bottom of the master order
func Get(conn *sql.DB, id int64) (Task, error)                 // ErrNotFound for a missing or deleted task
type Patch struct{ Title, Description *string; Priority *Priority; Starred *bool; Due *string } // Due "" clears
func Update(conn *sql.DB, a Actor, id int64, p Patch) (Task, error)
type StateChange struct{ From, To State; PrevStartedAt, PrevCompletedAt, StartedAt, CompletedAt string; EventID int64 }
func SetState(conn *sql.DB, a Actor, id int64, to State) (StateChange, error) // EventID 0 when nothing changed
func Delete(conn *sql.DB, a Actor, id int64) error             // soft: sets deleted_at
var ErrNotFound, ErrInvalid error

type Event struct{ ID, TaskID int64; TS, Type, Actor, ActorSession string; Payload json.RawMessage }
func Events(conn *sql.DB, taskID int64) ([]Event, error) // newest first
```

`LinkTarget` is defined in Task 4. Declare it here as `type LinkTarget struct{}` in `tasks.go` so `NewTask.Focus` compiles, and have `Create` ignore it. Task 4 replaces that placeholder with the real struct in `links.go`.

Event type constants (`events.go`): `task_created`, `task_edited` (payload `{"changes":{"<field>":{"from":…,"to":…}}}` for title, description, priority, starred, due), `task_state_changed` (`{"from","to"}`), `task_deleted`, `task_linked`, `task_unlinked`, `task_focus_changed`, `subtask_added`, `subtask_edited`, `subtask_checked`, `subtask_unchecked`, `subtask_removed`. Reordering tasks or subtasks writes **no** event (it's noise in a feed). Every write and its event go in one transaction.

- [ ] **Step 1: Add the tables to `stmts` in `internal/db/migrate.go`**

```sql
CREATE TABLE IF NOT EXISTS tasks (
	id           INTEGER PRIMARY KEY AUTOINCREMENT,
	title        TEXT NOT NULL,
	description  TEXT NOT NULL DEFAULT '',
	state        TEXT NOT NULL DEFAULT 'not_started',
	priority     TEXT NOT NULL DEFAULT 'none',
	starred      INTEGER NOT NULL DEFAULT 0,
	due_date     TEXT,
	rank         TEXT NOT NULL,
	created_at   TEXT NOT NULL,
	updated_at   TEXT NOT NULL,
	started_at   TEXT,
	completed_at TEXT,
	deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS tasks_rank ON tasks (rank, id);
CREATE TABLE IF NOT EXISTS task_links (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	kind          TEXT NOT NULL CHECK (kind IN ('resource','worktree')),
	resource_type TEXT NOT NULL DEFAULT '',
	resource_id   TEXT NOT NULL DEFAULT '',
	worktree_path TEXT NOT NULL DEFAULT '',
	is_primary    INTEGER NOT NULL DEFAULT 0,
	sort_order    INTEGER,
	created_at    TEXT NOT NULL,
	UNIQUE (task_id, kind, resource_type, resource_id, worktree_path)
);
CREATE INDEX IF NOT EXISTS task_links_resource ON task_links (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS task_links_worktree ON task_links (worktree_path);
CREATE TABLE IF NOT EXISTS task_subtasks (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	text       TEXT NOT NULL,
	checked    INTEGER NOT NULL DEFAULT 0,
	position   INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id       INTEGER NOT NULL,
	ts            TEXT NOT NULL,
	type          TEXT NOT NULL,
	actor         TEXT NOT NULL,
	actor_session TEXT NOT NULL DEFAULT '',
	payload       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task_id, ts);
```

Each statement is its own element of `stmts`, and each gets a short comment in the file's style: worktree-owned; `task_events` deliberately not `watcher_events`; `task_events` has no FK because history must outlive a Phase 6 purge decision. `ts` uses the same RFC3339 UTC second format as the rest of the DB.

- [ ] **Step 2: Write the failing tests** (`internal/tasks/tasks_test.go`, using a `newDB(t)` helper that calls `wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))`)

```go
var user = Actor{Kind: ActorUser}

func TestCreateGetDefaults(t *testing.T) {
	conn := newDB(t)
	tk, err := Create(conn, user, NewTask{Title: "Write repro"})
	// err nil; tk.ID > 0; tk.State == StateNotStarted; tk.Priority == PriorityNone; !tk.Starred; tk.Rank != ""
	got, _ := Get(conn, tk.ID) // equal Title/State/Rank
}

func TestCreateAppendsAtBottom(t *testing.T) {
	// three Creates; ranks strictly increasing in creation order
}

func TestSetStateTimestamps(t *testing.T) {
	// not_started -> in_progress: StartedAt set, CompletedAt ""
	// in_progress -> done: StartedAt unchanged, CompletedAt set
	// done -> in_progress: CompletedAt cleared, StartedAt unchanged
	// in_progress -> not_started: StartedAt cleared
	// fresh task not_started -> done: StartedAt and CompletedAt both set
	// SetState to the current state: EventID == 0, no new event row
	// each real change: StateChange.From/To correct, PrevStartedAt/PrevCompletedAt hold the values before
}

func TestRejectsInvalidInput(t *testing.T) {
	// Create with Title "  " -> errors.Is(err, ErrInvalid); Create with Due "2026-13-01" -> ErrInvalid
	// Create with Priority "urgent" -> ErrInvalid; SetState(id, "blocked") -> ErrInvalid
	// after all of the above: SELECT COUNT(*) FROM tasks == 1 (the one valid task) and task_events count unchanged
}

func TestUpdateRecordsChangedFieldsOnly(t *testing.T) {
	// Update Title and Starred; Events()[0].Type == "task_edited"
	// payload changes has exactly keys "title","starred" with from/to
	// Update with values equal to current -> no new event
}

func TestDeleteHidesTask(t *testing.T) {
	// Delete -> Get returns ErrNotFound; a task_deleted event exists
}
```

`internal/tasks/events_test.go`:

```go
func TestEventsCarryActor(t *testing.T) {
	agent := Actor{Kind: ActorAgent, Session: "tasks-feature"}
	tk, _ := Create(conn, agent, NewTask{Title: "x"})
	ev, _ := Events(conn, tk.ID)
	// ev[0].Type == "task_created", ev[0].Actor == "agent", ev[0].ActorSession == "tasks-feature"
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `go test ./internal/tasks/`
Expected: FAIL (undefined: Create, …)

- [ ] **Step 4: Implement `tasks.go` and `events.go` to the interfaces above**

Validate before opening the transaction. The title is trimmed and must be non-empty. Due must parse with `time.Parse("2006-01-02", …)`. `Create` computes `Rank` as `KeyBetween(<max rank over ALL rows, deleted included>, "")`. Deleted rows are included so a later restore can't collide.

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/tasks/ ./internal/db/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add internal/db/migrate.go internal/tasks/tasks.go internal/tasks/events.go internal/tasks/tasks_test.go internal/tasks/events_test.go
git commit --signoff -m "feat(tasks): schema, task CRUD, state timestamps and actor-stamped events" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HAFCNa6UnHnRzp1mmxFzto"
```

---

### Task 3: Moving tasks in the master order

**Files:**
- Create: `internal/tasks/order.go`
- Test: `internal/tasks/order_test.go`

**Interfaces:**
- Consumes: `KeyBetween`, `Task.Rank`.
- Produces:

```go
func MoveAfter(conn *sql.DB, id, afterID int64) error  // immediately after afterID in the master order
func MoveBefore(conn *sql.DB, id, beforeID int64) error // immediately before beforeID
func MoveToTop(conn *sql.DB, id int64) error
func MoveToBottom(conn *sql.DB, id int64) error
```

"Immediately after X" means between X's rank and the next-greater rank among **all other rows, deleted included**, excluding `id` itself. That's how a drag in a filtered view leaves hidden tasks where they were (spec "Ordering"). Ties on rank sort by `id`. Moving a task relative to itself is a no-op. No event is written.

- [ ] **Step 1: Write the failing tests**

```go
func TestMoveAfterSkipsOnlyTheGap(t *testing.T) {
	// create A,B,C,D (master order A<B<C<D); MoveAfter(D, A)
	// order by (rank,id) is A,D,B,C — B and C, which a filtered view may not have shown, did not move
}
func TestMoveBeforeAndEdges(t *testing.T) {
	// MoveBefore(C, A) -> C,A,B ; MoveToBottom(C) -> A,B,C ; MoveToTop(B) -> B,A,C
}
func TestMoveRewritesOnlyMovedRow(t *testing.T) {
	// snapshot ranks; MoveAfter(D, A); every rank except D's is unchanged
}
func TestMoveAroundDeletedNeighbour(t *testing.T) {
	// A,B,C; Delete(B); MoveAfter(C, A): ranks strictly increase A < C < B (B kept its rank)
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test ./internal/tasks/ -run Move`
Expected: FAIL

- [ ] **Step 3: Implement `order.go`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/tasks/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/tasks/order.go internal/tasks/order_test.go
git commit --signoff -m "feat(tasks): move tasks within the one master order" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HAFCNa6UnHnRzp1mmxFzto"
```

---

### Task 4: Links, membership, archived, and List

**Files:**
- Create: `internal/tasks/links.go` (link CRUD, Focus/Related, link order)
- Create: `internal/tasks/list.go` (Scope, Filter, List; membership + archived computed in Go)
- Modify: `internal/tasks/tasks.go` (`Create` writes `NewTask.Focus` as Focus links; `Get` fills Links/Implicit/Archived)
- Test: `internal/tasks/links_test.go`, `internal/tasks/list_test.go`

**Interfaces:**
- Consumes: Task 2 types. `wdb.Subscriber`, `wdb.WorktreePathFromSubscriber`, `registry.List`, and the `watcher_subscriptions` table (read directly).
- Produces:

```go
type LinkKind string // LinkResource "resource" | LinkWorktree "worktree"
type LinkTarget struct{ Kind LinkKind; ResourceType, ResourceID, Worktree string } // Worktree: any path; canonicalised on write
type Link struct {
	ID       int64
	LinkTarget            // Worktree holds the canonical path
	Primary  bool         // Focus
	Archived bool
}
func AddLink(conn *sql.DB, a Actor, taskID int64, t LinkTarget, focus bool) (Link, error)
func RemoveLink(conn *sql.DB, a Actor, taskID int64, t LinkTarget) error
func SetLinkFocus(conn *sql.DB, a Actor, taskID int64, t LinkTarget, focus bool) error   // lands at the bottom of the new group
func SetLinkOrder(conn *sql.DB, taskID int64, focus, related []LinkTarget) error       // declarative, like resources.SetOrder

type ScopeKind string // ScopeAll "all" | ScopeWorktree "worktree" | ScopeResource "resource"
type Scope struct{ Kind ScopeKind; Worktree, ResourceType, ResourceID string }
type Filter struct {
	Scope            Scope
	IncludeCompleted bool
	IncludeArchived  bool // only meaningful with IncludeCompleted
	Priorities       []Priority // empty = all
	StarredOnly      bool
}
func List(conn *sql.DB, f Filter) ([]Task, error) // master order: (rank, id)
```

Rules, all in Go over three small loads: every non-deleted task with its links; active `worktree:` subscriptions as a map resource→[]canonical path; tombstoned `worktree:` subscriptions, likewise; and the registry as a set of canonical paths.
- A resource link is **archived** when no active `worktree:` subscription to it exists. A worktree link is archived when its path isn't in the registry.
- `Task.Implicit`: the canonical paths of active `worktree:` subscribers to the task's resource links, de-duplicated and sorted.
- `Task.Archived`: the task has at least one link and every link is archived.
- **Worktree scope W** includes a task if it has a worktree link to W, or W is in `Implicit`, or (the fallback) the task is Archived, W is registered, and W holds a *tombstoned* subscription to one of its resource links.
- **Resource scope** includes a task if it links to that resource. **All scope** includes every task.
- Completed tasks are dropped unless `IncludeCompleted`. Completed **and** Archived tasks are dropped unless `IncludeArchived` too.
- Link order inside a task: Focus before Related, then `sort_order` (NULL last), then `created_at`. This mirrors `resources.Load`.
- `AddLink` on an existing target with the same group is a no-op (no event). With the other group it behaves as `SetLinkFocus`.

- [ ] **Step 1: Write the failing tests**

Test fixtures: register worktrees with `registry.Register`, and write subscriptions with the watcher library's `watcherdb.Subscribe(conn, wdb.Subscriber(path), watcher.Resource{Type, ID}, watcherdb.SubscribeOpts{})`. Tombstone with `watcherdb.Unsubscribe`. Use `t.TempDir()` paths. No real git repo is needed, because `internal/tasks` doesn't go through `resources.Add`'s worktree guard.

```go
func TestCreateWithFocusContext(t *testing.T) {
	// Create(..., NewTask{Title:"x", Focus: []LinkTarget{{Kind: LinkResource, ResourceType:"pr", ResourceID:"o/r#1"}}})
	// Get: len(Links)==1, Links[0].Primary == true
}
func TestAddLinkDefaultsAndRemoveDoesNotPromote(t *testing.T) {
	// AddLink(jira, focus=false) -> Primary false; RemoveLink(the pr Focus link) -> remaining link still Primary false
}
func TestAddLinkTwice(t *testing.T) {
	// AddLink same target same group twice -> 1 row, 1 task_linked event
	// AddLink same target with focus flipped -> Primary flipped, a task_focus_changed event, still 1 row
}
func TestSetLinkOrder(t *testing.T) {
	// three links; SetLinkOrder(focus=[c], related=[b,a]) -> Get().Links in order c,b,a with c Primary
}
func TestWorktreeLinkCanonicalisesSymlink(t *testing.T) {
	// real dir D, symlink S -> D; registry.Register(Path: D); AddLink(worktree S)
	// Links[0].Worktree == canonical D, not Archived; List(Scope worktree D) contains the task
}
func TestListImplicitMembership(t *testing.T) {
	// worktrees X, Y both subscribe pr:o/r#1; task linked to that PR only
	// List(worktree X) and List(worktree Y) both contain it; Implicit == [X, Y] (canonical, sorted)
}
func TestListResourceScope(t *testing.T) { /* only tasks linking that resource */ }
func TestListArchivedFallback(t *testing.T) {
	// X subscribes then Unsubscribes pr:1 (tombstone); task linked to pr:1, open
	// Archived == true; List(worktree X) contains it; List(all) contains it
	// registry.Unregister(X): List(worktree X) empty, List(all) still contains it with Archived
}
func TestListCompletedArchivedHidden(t *testing.T) {
	// archived task set to done: absent from List(all, IncludeCompleted) ; present with IncludeCompleted+IncludeArchived
	// a done, non-archived task: present with IncludeCompleted alone
}
func TestListIgnoresNonWorktreeSubscribers(t *testing.T) {
	// only subscription to pr:1 is subscriber "task:7" -> link Archived, Implicit empty
}
func TestListFiltersAndOrder(t *testing.T) {
	// Priorities filter, StarredOnly; result order equals master order after a MoveToTop
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test ./internal/tasks/ -run 'Link|List|Focus'`
Expected: FAIL

- [ ] **Step 3: Implement `links.go`, `list.go`, and the `tasks.go` changes**

`Get` is `List` with an all-scope filter including completed and archived, narrowed to one ID. Don't write a second membership path.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/tasks/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/tasks/links.go internal/tasks/list.go internal/tasks/tasks.go internal/tasks/links_test.go internal/tasks/list_test.go
git commit --signoff -m "feat(tasks): Focus/Related links, implicit worktree membership and archived fallback" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HAFCNa6UnHnRzp1mmxFzto"
```

---

### Task 5: Subtasks

**Files:**
- Create: `internal/tasks/subtasks.go`
- Modify: `internal/tasks/list.go` (fill `Task.Subtasks`, ordered by `position`)
- Test: `internal/tasks/subtasks_test.go`

**Interfaces:**
- Produces:

```go
type Subtask struct{ ID, TaskID int64; Text string; Checked bool; Position int }
func AddSubtask(conn *sql.DB, a Actor, taskID int64, text string) (Subtask, error)   // appended at the end
func EditSubtask(conn *sql.DB, a Actor, id int64, text string) error
type SubtaskChange struct{ From, To bool; EventID int64 }
func SetSubtaskChecked(conn *sql.DB, a Actor, id int64, checked bool) (SubtaskChange, error) // EventID 0 when unchanged
func RemoveSubtask(conn *sql.DB, a Actor, id int64) error
func SetSubtaskOrder(conn *sql.DB, taskID int64, ids []int64) error // declarative; unknown ids ignored, omitted ones appended
```

Each subtask event payload carries `{"subtask_id", "text"}`. Empty or whitespace text is `ErrInvalid`. `SetSubtaskOrder` writes no event.

- [ ] **Step 1: Write the failing tests**

```go
func TestSubtaskLifecycle(t *testing.T) {
	// add a,b,c -> Get().Subtasks texts a,b,c ; SetSubtaskChecked(b,true) -> From false To true, event subtask_checked
	// SetSubtaskChecked(b,true) again -> EventID 0 ; EditSubtask(a,"a2") -> subtask_edited ; RemoveSubtask(c) -> 2 left
}
func TestSetSubtaskOrderForgiving(t *testing.T) {
	// a,b,c ; SetSubtaskOrder([c, a, 999]) -> c,a,b
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test ./internal/tasks/ -run Subtask`
Expected: FAIL

- [ ] **Step 3: Implement `subtasks.go` and fill `Subtasks` in `list.go`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/tasks/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/tasks/subtasks.go internal/tasks/list.go internal/tasks/subtasks_test.go
git commit --signoff -m "feat(tasks): ordered checkbox subtasks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HAFCNa6UnHnRzp1mmxFzto"
```

---

### Task 6: CLI — list, show, add, edit, state, star, delete

**Files:**
- Create: `cmd/tasks.go` (command tree, actor detection, ID and link-ref parsing, scope resolution)
- Create: `cmd/tasks_json.go` (JSON DTOs + human-readable lines)
- Test: `cmd/tasks_test.go`

**Interfaces:**
- Consumes: everything in `internal/tasks`, `resolveWorktreePath` (`cmd/info.go`), `registry.Get`, `resourceurl.InferAny`.
- Produces (used by Task 7):

```go
func actorFromEnv(asAgent bool, getenv func(string) string) tasks.Actor
func parseTaskID(s string) (int64, error)            // "T42", "t42", "42" -> 42
func formatTaskID(id int64) string                   // "T42"
func parseLinkRef(s string) (tasks.LinkTarget, error)
// a URL (resourceurl.InferAny) | "<type>:<id>" split on the FIRST ':' only (Slack ids contain ':') |
// "wt:<path>" | "." (the current worktree)
func currentWorktree() (string, bool, error)         // canonical path of the registered worktree containing cwd
```

Commands (`GroupID: "worktree"`, all with `--json` and the persistent `--as-agent` flag):

| Command | Behaviour |
|---|---|
| `tasks list` | Defaults to worktree scope for `currentWorktree()` when registered, otherwise all. Flags: `--all`, `--worktree <path>`, `--resource <ref>`, `--completed`, `--archived`, `--priority <p>` (repeatable), `--starred`. |
| `tasks show <id>` | Everything: fields, links (Focus/Related, archived), implicit worktrees, subtasks, last 20 events |
| `tasks add <title>` | `--priority`, `--star`, `--due`, `--description`, `--focus <ref>` / `--related <ref>` (repeatable), `--global`. With no link flags and no `--global`, Focus-links the current worktree when inside a registered one. Prints the new ID. |
| `tasks edit <id>` | `--title`, `--description`, `--priority`, `--due` (`""` clears) |
| `tasks state <id> <not_started\|in_progress\|done>` | |
| `tasks star <id>` / `tasks unstar <id>` | |
| `tasks delete <id>` | |

The JSON task shape (snake_case, and the contract agent tooling binds to): `id` ("T42"), `title`, `description`, `state`, `priority`, `starred`, `due` (omitempty), `created_at`, `updated_at`, `started_at`/`completed_at` (omitempty), `archived`, `links` (`[{kind, resource_type?, resource_id?, worktree?, focus, archived}]`), `implicit_worktrees` (`[]`, never null), `subtasks` (`[{id, text, checked}]`, never null), and on `show` only, `events` (`[{ts, type, actor, actor_session?, payload}]`).

Human `list` line: `T42 ◩ ★ !!! Title  [due 2026-10-24] [2/5] [pr:o/r#1 +2]`. The state glyphs are `☐` not started, `◩` in progress, `☑` done. The priority marks are `!!!`/`!!`/`!`/blank.

- [ ] **Step 1: Write the failing tests**

```go
func TestActorFromEnv(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	// {} -> user ; {"CLAUDECODE":"1"} -> agent, Session "" ; {"HANDLER_SESSION_ID":"abc"} -> agent, Session "abc"
	// asAgent=true with {} -> agent
}
func TestParseTaskID(t *testing.T) { /* "T42","t42","42" -> 42 ; "T", "x1", "-3" -> error */ }
func TestParseLinkRef(t *testing.T) {
	// "https://github.com/o/r/pull/1" -> resource pr ; "jira:RHOAIENG-1" -> resource jira
	// "slack:C069KSM8T9N:1787257539.775119" -> type slack, id "C069KSM8T9N:1787257539.775119"
	// "wt:/tmp/x" -> worktree ; "nonsense" -> error
}
func TestTaskJSONContract(t *testing.T) {
	// marshal a Task with no links/subtasks: "links", "implicit_worktrees", "subtasks" are [] not null; "id" == "T7"
	// exact key set for a minimal task
}
func TestTasksAddListShowRoundTrip(t *testing.T) {
	// WORKTREE_DB=<tempdir db>; run rootCmd with args add "Write repro" --priority high --star --global --json
	// then list --all --json -> one task, priority "high", starred true ; show T1 --json -> events[0].type "task_created"
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test ./cmd/ -run 'Task|ActorFromEnv|ParseLinkRef'`
Expected: FAIL

- [ ] **Step 3: Implement `cmd/tasks.go` and `cmd/tasks_json.go`**

Follow `cmd/resources.go` conventions: package-level flag vars, `RunE` functions, and output through `cmd.OutOrStdout()`. Map `tasks.ErrNotFound` to `task T<n> not found`. Map `tasks.ErrInvalid` to its message.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./cmd/ ./internal/tasks/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cmd/tasks.go cmd/tasks_json.go cmd/tasks_test.go
git commit --signoff -m "feat(cli): worktree tasks list/show/add/edit/state/star/delete" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HAFCNa6UnHnRzp1mmxFzto"
```

---

### Task 7: CLI — links, subtasks, moves; docs

**Files:**
- Modify: `cmd/tasks.go`
- Test: `cmd/tasks_test.go`
- Modify: `.claude/CLAUDE.md` (add `tasks` to the `internal/` package list)
- Modify: `README.md` (only if it lists CLI commands; add `worktree tasks`)

**Interfaces:**
- Consumes: Task 6 helpers and Tasks 3–5 functions.

| Command | Calls |
|---|---|
| `tasks link <id> <ref> [--focus]` | `AddLink` |
| `tasks unlink <id> <ref>` | `RemoveLink` |
| `tasks focus <id> <ref>` / `tasks unfocus <id> <ref>` | `SetLinkFocus` |
| `tasks subtask add <id> <text>` | `AddSubtask` (prints the subtask ID) |
| `tasks subtask edit <subtask-id> <text>` / `check` / `uncheck` / `remove` | the matching function |
| `tasks subtask order <id> <subtask-id>...` | `SetSubtaskOrder` |
| `tasks move <id> (--after <id> \| --before <id> \| --top \| --bottom)` | `MoveAfter`/`MoveBefore`/`MoveToTop`/`MoveToBottom`; exactly one flag, else an error |

- [ ] **Step 1: Write the failing tests**

```go
func TestTasksLinkFocusMoveCLI(t *testing.T) {
	// add A --global, add B --global ; link T1 jira:RH-1 ; show T1 --json -> links[0].focus false
	// focus T1 jira:RH-1 -> focus true ; move T2 --top ; list --all --json -> ids ["T2","T1"]
	// move T1 --top --bottom -> error mentioning "exactly one"
}
func TestTasksSubtaskCLI(t *testing.T) {
	// subtask add T1 a ; subtask add T1 b ; subtask check <id of a> ; show T1 --json -> subtasks [{a,true},{b,false}]
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test ./cmd/ -run 'TasksLink|TasksSubtask'`
Expected: FAIL

- [ ] **Step 3: Implement the subcommands. Add the CLAUDE.md package entry** (one bullet in the existing style: "`tasks` — to-do items attached to worktrees and resources; one master order (fractional keys); membership and archived computed in Go; actor-stamped `task_events`. Spec: `docs/superpowers/specs/2026-10-21-tasks-design.md`.")

- [ ] **Step 4: Run the full suite**

Run: `make test`
Expected: PASS

- [ ] **Step 5: Smoke-test against a scratch DB**

Run: `go build -o bin/worktree . && WORKTREE_DB=$HOME/tmp/tasks-phase1-smoke.db ./bin/worktree tasks add "smoke" --global --priority high --star && WORKTREE_DB=$HOME/tmp/tasks-phase1-smoke.db ./bin/worktree tasks list --all`
Expected: one line beginning `T1 ☐ ★ !!! smoke`

- [ ] **Step 6: Commit**

```bash
git add cmd/tasks.go cmd/tasks_test.go .claude/CLAUDE.md
git commit --signoff -m "feat(cli): task links, subtasks and moves; document the tasks package" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HAFCNa6UnHnRzp1mmxFzto"
```

(Add `README.md` to the `git add` only if it was changed.)
