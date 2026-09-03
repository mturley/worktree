# Per-Resource Unread Cursor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every tracked non-Slack resource a read cursor, and surface unread activity as a divider in single-resource timelines, per-event dots in unified timelines, a mark-read action, and an unread dot wherever a resource is named.

**Architecture:** A worktree-owned `resource_read_cursor` table stores one `last_read_ts` per resource, compared against `watcher_events.ts`. A request-scoped `unreadIndex` loads all cursors and counts in two queries and stamps `unread_count` onto resource DTOs and `unread` onto timeline events. Slack threads are excluded from the cursor entirely and keep their existing `has_unread`; one frontend helper hides that split from every call site.

**Tech Stack:** Go 1.22 (`database/sql`, SQLite, stdlib `net/http` mux, cobra), React 19 + Mantine 7 + TanStack Query 5, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-02-per-resource-unread-cursor-design.md`

## Global Constraints

- **No watcher library change.** The cursor table is worktree-owned, has no `watcher_` prefix, and the count query's index (`idx_watcher_event_resources_resource`) already exists in the library schema. If a task appears to need a library change, stop and report it rather than patching locally.
- **The cursor compares against `watcher_events.ts`, never `external_ts`.** Both timeline queries `ORDER BY e.ts DESC`; `external_ts` is nullable and can run out of order.
- **Unread is `e.ts > last_read_ts`** — strictly greater.
- **Slack threads never get a cursor row.** Every seeding path skips `type == "slack"`; the write endpoint and CLI command reject a Slack resource.
- **`TimelineEvent.Unread` is always false for Slack-sourced events.**
- **Nothing marks a resource read implicitly.** Viewing a timeline must not move a cursor.
- **`through_ts` is client-supplied**, never a server-side `MAX(ts)`. The cursor only moves forward.
- **Never `git add -A` or `git add .`** — add named files only. Every commit uses `--signoff`.
- Run `go test ./...` for Go tasks and `npm test` (in `ui/`) for frontend tasks. Check `ui/package.json` for script names before running any tool directly.
- Existing CLI output must stay byte-identical for a fully read resource: ` (N unread)` is appended only when the count is non-zero, and `unread_count` uses `omitempty`.

---

### Task 1: Cursor storage and migration backfill

**Files:**
- Create: `internal/unread/unread.go`
- Create: `internal/unread/unread_test.go`
- Modify: `internal/db/migrate.go`

**Interfaces:**
- Consumes: `wdb.OpenAt(path string) (*sql.DB, error)` from `internal/db`; `internal/testgit`'s `Worktree(t)` for tests that need a real worktree path.
- Produces:
  - `unread.EnsureCursor(conn *sql.DB, resType, id string) error`
  - `unread.Counts(conn *sql.DB) (map[string]int, error)` — keyed by `unread.Key(resType, id)`
  - `unread.Cursors(conn *sql.DB) (map[string]string, error)` — same key, value `last_read_ts`
  - `unread.MarkRead(conn *sql.DB, resType, id, throughTS string) error`
  - `unread.Key(resType, id string) string`
  - `unread.ErrSlackNotSupported` (an `error`)

- [ ] **Step 1: Add the table and backfill to the worktree migration**

In `internal/db/migrate.go`, append to the `stmts` slice (after the `worktrees` table), keeping the existing comment style:

```go
		// Per-resource read cursor. Worktree-owned, not a watcher table:
		// agent-handler tracks unread per SUBSCRIBER, and must not inherit
		// this per-RESOURCE model. Compared against watcher_events.ts, which
		// is the column both timeline queries order by.
		`CREATE TABLE IF NOT EXISTS resource_read_cursor (
			resource_type TEXT NOT NULL,
			resource_id   TEXT NOT NULL,
			last_read_ts  TEXT NOT NULL,
			updated_at    TEXT NOT NULL,
			PRIMARY KEY (resource_type, resource_id)
		)`,
```

Then, after the `for _, s := range stmts` loop and before `return nil`, add the backfill:

```go
	// Backfill: every already-subscribed non-Slack resource starts fully
	// read, so the feature goes live silent instead of announcing a backlog
	// nobody will clear by hand.
	//
	// Runs on every migrate and is INSERT OR IGNORE, so after the first run
	// it inserts nothing — resources.Add seeds anything newer. It doubles as
	// a safety net for a row that went missing, at the cost of reading that
	// one resource's backlog as seen.
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := conn.Exec(`
		INSERT OR IGNORE INTO resource_read_cursor
			(resource_type, resource_id, last_read_ts, updated_at)
		SELECT s.resource_type, s.resource_id,
		       COALESCE((SELECT MAX(e.ts)
		                   FROM watcher_events e
		                   JOIN watcher_event_resources er ON er.event_id = e.id
		                  WHERE er.resource_type = s.resource_type
		                    AND er.resource_id   = s.resource_id), ?),
		       ?
		  FROM watcher_subscriptions s
		 WHERE s.resource_type <> 'slack'
		   AND s.deleted_at IS NULL
		 GROUP BY s.resource_type, s.resource_id`, now, now); err != nil {
		return err
	}
```

Add `"time"` to the file's imports.

This is safe to place here because `wdb.OpenAt` calls `watcherdb.Migrate(conn)` **before** `migrate(conn)` (see `internal/db/db.go:53-57`), so the watcher tables the backfill reads already exist.

- [ ] **Step 2: Write the failing tests for the unread package**

Create `internal/unread/unread_test.go`:

```go
package unread_test

import (
	"database/sql"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/unread"
)

func openDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// addEvent inserts one event linked to one resource, at the given ts.
func addEvent(t *testing.T, conn *sql.DB, id, ts, resType, resID string) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO watcher_events (id, ts, source, type, title) VALUES (?, ?, 'github', 'pr_comment', 'x')`,
		id, ts); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id) VALUES (?, ?, ?)`,
		id, resType, resID); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureCursorSeedsAtNewestEvent(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	addEvent(t, conn, "e2", "2026-01-02T00:00:00Z", "pr", "o/r#1")

	if err := unread.EnsureCursor(conn, "pr", "o/r#1"); err != nil {
		t.Fatal(err)
	}
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	if got := cursors[unread.Key("pr", "o/r#1")]; got != "2026-01-02T00:00:00Z" {
		t.Fatalf("cursor = %q, want the newest event's ts", got)
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#1")]; n != 0 {
		t.Fatalf("unread = %d, want 0 — a freshly seeded resource starts read", n)
	}
}

func TestEnsureCursorDoesNotResetAnExistingCursor(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	if err := unread.EnsureCursor(conn, "pr", "o/r#1"); err != nil {
		t.Fatal(err)
	}
	// New activity arrives, then a SECOND worktree subscribes to the same
	// resource. Its EnsureCursor must not swallow the unread event.
	addEvent(t, conn, "e2", "2026-01-02T00:00:00Z", "pr", "o/r#1")
	if err := unread.EnsureCursor(conn, "pr", "o/r#1"); err != nil {
		t.Fatal(err)
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#1")]; n != 1 {
		t.Fatalf("unread = %d, want 1 — a second subscriber inherits the cursor", n)
	}
}

func TestEnsureCursorSkipsSlack(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "slack", "C1:1.2")
	if err := unread.EnsureCursor(conn, "slack", "C1:1.2"); err != nil {
		t.Fatalf("EnsureCursor must be a silent no-op for slack, got %v", err)
	}
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := cursors[unread.Key("slack", "C1:1.2")]; ok {
		t.Fatal("a slack thread must never get a cursor row")
	}
}

func TestCountsIsStrictlyGreaterThanCursor(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	addEvent(t, conn, "e2", "2026-01-02T00:00:00Z", "pr", "o/r#1")
	addEvent(t, conn, "e3", "2026-01-03T00:00:00Z", "pr", "o/r#1")
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2026-01-02T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	// e2 is AT the cursor and counts as read; only e3 is newer.
	if n := counts[unread.Key("pr", "o/r#1")]; n != 1 {
		t.Fatalf("unread = %d, want 1", n)
	}
}

func TestCountsIgnoresResourcesWithNoCursor(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "pr", "o/r#9")
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#9")]; n != 0 {
		t.Fatalf("unread = %d, want 0 — a missing cursor row reads as nothing unread", n)
	}
}

func TestMarkReadOnlyMovesForward(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "pr", "o/r#1")
	addEvent(t, conn, "e2", "2026-01-05T00:00:00Z", "pr", "o/r#1")
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2026-01-05T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	// A stale client replays an older through_ts; the cursor must not rewind.
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	if got := cursors[unread.Key("pr", "o/r#1")]; got != "2026-01-05T00:00:00Z" {
		t.Fatalf("cursor = %q, want it to stay at the newer ts", got)
	}
}

func TestMarkReadRejectsSlack(t *testing.T) {
	conn := openDB(t)
	if err := unread.MarkRead(conn, "slack", "C1:1.2", "1.0"); err == nil {
		t.Fatal("MarkRead must reject a slack resource")
	}
}

func TestMarkReadCreatesACursorForAnUnseededResource(t *testing.T) {
	conn := openDB(t)
	addEvent(t, conn, "e1", "2026-01-01T00:00:00Z", "jira", "J-1")
	if err := unread.MarkRead(conn, "jira", "J-1", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	if got := cursors[unread.Key("jira", "J-1")]; got != "2026-01-01T00:00:00Z" {
		t.Fatalf("cursor = %q, want the marked ts", got)
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `go test ./internal/unread/...`
Expected: FAIL — the package `github.com/mturley/worktree/internal/unread` does not exist yet (build error: no Go files / cannot find package).

- [ ] **Step 4: Implement the unread package**

Create `internal/unread/unread.go`:

```go
// Package unread implements the per-resource read cursor.
//
// One cursor per resource, NOT per subscriber. agent-handler — the watcher
// library's other consumer — tracks unread per subscriber so each session has
// its own read state; this is deliberately different. If a PR is tracked by
// two worktrees, marking it read in one clears it in both: you read the PR,
// not the worktree.
//
// The cursor is compared against watcher_events.ts, never external_ts. Both
// timeline queries ORDER BY e.ts DESC, and external_ts is nullable and can run
// out of order relative to ts — a cursor on it would let read and unread
// events interleave in display order, making the unread divider a lie.
package unread

import (
	"database/sql"
	"errors"
	"time"
)

// ErrSlackNotSupported is returned for any write against a Slack thread.
//
// Slack owns a read cursor for the current user already, worktree reads it via
// the poller-cached has_unread, and two systems must not both claim authority
// over the same thread.
var ErrSlackNotSupported = errors.New("slack threads keep their own read state")

// Key is the map key used by Counts and Cursors. The separator is a NUL so it
// cannot collide with a resource id (Slack ids contain ':', Jira ids '-',
// PR ids '/' and '#').
func Key(resType, id string) string { return resType + "\x00" + id }

// EnsureCursor seeds a cursor for a resource that has none, at the newest ts
// among its events, or now if it has no events. It is INSERT OR IGNORE: a
// resource someone already reads keeps its cursor when a second worktree
// subscribes, rather than having its unread state reset.
//
// A Slack resource is a silent no-op, not an error — callers seed
// indiscriminately as resources are added, and the skip belongs here rather
// than at every call site.
func EnsureCursor(conn *sql.DB, resType, id string) error {
	if resType == "slack" {
		return nil
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := conn.Exec(`
		INSERT OR IGNORE INTO resource_read_cursor
			(resource_type, resource_id, last_read_ts, updated_at)
		VALUES (?, ?,
		        COALESCE((SELECT MAX(e.ts)
		                    FROM watcher_events e
		                    JOIN watcher_event_resources er ON er.event_id = e.id
		                   WHERE er.resource_type = ? AND er.resource_id = ?), ?),
		        ?)`, resType, id, resType, id, now, now)
	return err
}

// Counts returns the unread event count per resource, keyed by Key.
//
// The INNER join on resource_read_cursor does three jobs at once: it excludes
// Slack threads (never seeded), resources with no cursor row (read as nothing
// unread), and fully read resources (count zero yields no row). Resources
// absent from the map therefore have zero unread, which is what every caller
// wants from a missing key anyway.
func Counts(conn *sql.DB) (map[string]int, error) {
	rows, err := conn.Query(`
		SELECT er.resource_type, er.resource_id, COUNT(*)
		  FROM watcher_event_resources er
		  JOIN watcher_events e ON e.id = er.event_id
		  JOIN resource_read_cursor c
		    ON c.resource_type = er.resource_type
		   AND c.resource_id   = er.resource_id
		 WHERE e.ts > c.last_read_ts
		 GROUP BY er.resource_type, er.resource_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var rt, rid string
		var n int
		if err := rows.Scan(&rt, &rid, &n); err != nil {
			return nil, err
		}
		out[Key(rt, rid)] = n
	}
	return out, rows.Err()
}

// Cursors returns every stored cursor, keyed by Key. Used to decide whether an
// individual event is unread without a query per event.
func Cursors(conn *sql.DB) (map[string]string, error) {
	rows, err := conn.Query(
		`SELECT resource_type, resource_id, last_read_ts FROM resource_read_cursor`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var rt, rid, ts string
		if err := rows.Scan(&rt, &rid, &ts); err != nil {
			return nil, err
		}
		out[Key(rt, rid)] = ts
	}
	return out, rows.Err()
}

// MarkRead moves a resource's cursor to throughTS.
//
// throughTS is the newest event the CLIENT actually saw, never a server-side
// MAX(ts): events arriving between render and click must stay unread rather
// than being swallowed by a button that promised to clear a specific number.
//
// The cursor only ever moves forward. A stale client replaying an older
// throughTS is a no-op, not a rewind that resurrects read events.
func MarkRead(conn *sql.DB, resType, id, throughTS string) error {
	if resType == "slack" {
		return ErrSlackNotSupported
	}
	if throughTS == "" {
		return errors.New("through_ts is required")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := conn.Exec(`
		INSERT INTO resource_read_cursor
			(resource_type, resource_id, last_read_ts, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (resource_type, resource_id) DO UPDATE SET
			last_read_ts = MAX(excluded.last_read_ts, resource_read_cursor.last_read_ts),
			updated_at   = excluded.updated_at`,
		resType, id, throughTS, now)
	return err
}
```

Note on `MAX(...)` in the `DO UPDATE`: SQLite's two-argument `MAX` is the scalar function, which compares the two RFC3339 strings lexicographically. RFC3339 UTC timestamps sort lexicographically in chronological order, which is why the cursor may be compared as text throughout.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./internal/unread/... ./internal/db/...`
Expected: PASS.

- [ ] **Step 6: Run the full Go suite**

Run: `go test ./...`
Expected: PASS — the new table is additive and nothing reads it yet.

- [ ] **Step 7: Commit**

```bash
git add internal/unread/unread.go internal/unread/unread_test.go internal/db/migrate.go
git commit --signoff -m "feat(unread): per-resource read cursor storage and backfill"
```

---

### Task 2: Seed a cursor when a resource is tracked

**Files:**
- Modify: `internal/resources/resources.go:92-148` (the `Add` function)
- Test: `internal/resources/resources_test.go`

**Interfaces:**
- Consumes: `unread.EnsureCursor(conn *sql.DB, resType, id string) error`, `unread.Counts(conn *sql.DB) (map[string]int, error)`, `unread.Key(resType, id string) string` from Task 1.
- Produces: nothing new; `resources.Add`'s signature is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `internal/resources/resources_test.go` (the file already imports `testing`, `path/filepath`, `wdb "github.com/mturley/worktree/internal/db"`, `"github.com/mturley/worktree/internal/testgit"` and the `resources` package — reuse whatever helper it already has for opening a DB rather than adding a second one):

```go
func TestAddSeedsAReadCursorSoNewResourcesStartSilent(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wt := testgit.Worktree(t)

	// An event already exists for this resource before anyone tracks it.
	if _, err := conn.Exec(
		`INSERT INTO watcher_events (id, ts, source, type, title) VALUES ('e1', '2026-01-01T00:00:00Z', 'github', 'pr_comment', 'x')`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id) VALUES ('e1', 'pr', 'o/r#1')`); err != nil {
		t.Fatal(err)
	}

	if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	// Assert the cursor was CREATED, not merely that the count is zero: with
	// no cursor row at all the count is also zero, so a count-only assertion
	// would pass against an unimplemented Add.
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := cursors[unread.Key("pr", "o/r#1")]
	if !ok {
		t.Fatal("Add must seed a read cursor for the resource")
	}
	if got < "2026-01-01T00:00:00Z" {
		t.Fatalf("cursor = %q, want it at or after the existing event so the backlog reads as seen", got)
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#1")]; n != 0 {
		t.Fatalf("unread = %d, want 0 — tracking a resource must not announce its backlog", n)
	}
}

func TestAddDoesNotSeedACursorForSlack(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wt := testgit.Worktree(t)

	if err := resources.Add(conn, wt, resources.Resource{Type: "slack", ID: "C1:1.2", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := cursors[unread.Key("slack", "C1:1.2")]; ok {
		t.Fatal("a slack thread must never get a cursor row")
	}
}
```

Add `"github.com/mturley/worktree/internal/unread"` to the test file's imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/resources/ -run 'TestAdd(Seeds|DoesNotSeed)' -v`
Expected: FAIL with "Add must seed a read cursor for the resource".

- [ ] **Step 3: Seed the cursor in `Add`**

In `internal/resources/resources.go`, inside `Add`, after `tx.Commit()` succeeds. Replace the final `return tx.Commit()` with:

```go
	if err := tx.Commit(); err != nil {
		return err
	}

	// A newly tracked resource starts fully read: its history predates the
	// decision to follow it, so counting it as unread would announce a
	// backlog rather than news. INSERT OR IGNORE inside EnsureCursor means a
	// second worktree subscribing to a resource someone already reads
	// inherits that cursor instead of resetting it.
	//
	// Deliberately after the commit and NOT part of the transaction: failing
	// to seed a cursor must not undo a successful subscription. The migration
	// backfill re-seeds anything missed here on the next open.
	if err := unread.EnsureCursor(conn, r.Type, r.ID); err != nil {
		return fmt.Errorf("seed read cursor: %w", err)
	}
	return nil
```

Add `"github.com/mturley/worktree/internal/unread"` to the file's imports.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/resources/... ./internal/unread/...`
Expected: PASS.

- [ ] **Step 5: Run the full Go suite**

Run: `go test ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/resources/resources.go internal/resources/resources_test.go
git commit --signoff -m "feat(unread): seed a read cursor when a resource is tracked"
```

---

### Task 3: Expose unread counts and per-event unread on the read APIs

**Files:**
- Create: `internal/webui/unread.go`
- Create: `internal/webui/unread_test.go`
- Modify: `internal/webui/resources_api.go:11-38` (the `resourceDTO` struct), `internal/webui/resources_api.go:39-56` (`handleWorktreeResources`)
- Modify: `internal/webui/worktrees.go:33-78` (`handleWorktrees`)
- Modify: `internal/webui/timeline.go` (`TimelineEvent`, `newEventEnricher`, `fillResource`, `writeTimelineRows`, `handleWorktreeTimeline`)

**Interfaces:**
- Consumes: `unread.Counts`, `unread.Cursors`, `unread.Key` from Task 1.
- Produces:
  - `(*Server).newUnreadIndex() *unreadIndex`
  - `(*unreadIndex).Count(resType, id string) int`
  - `(*unreadIndex).IsUnread(resType, id, ts string) bool`
  - `resourceDTO.UnreadCount int` — JSON `unread_count,omitempty`
  - `TimelineEvent.Unread bool` — JSON `unread,omitempty`

- [ ] **Step 1: Write the failing tests**

Create `internal/webui/unread_test.go`:

```go
package webui

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
	"github.com/mturley/worktree/internal/unread"
)

func unreadTestDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func insertEvent(t *testing.T, conn *sql.DB, id, ts, source, resType, resID string) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO watcher_events (id, ts, source, type, title) VALUES (?, ?, ?, 'pr_comment', 'x')`,
		id, ts, source); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id) VALUES (?, ?, ?)`,
		id, resType, resID); err != nil {
		t.Fatal(err)
	}
}

func TestWorktreeResourcesCarriesUnreadCount(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	// Two events land AFTER the resource was tracked, so both are unread.
	insertEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	insertEvent(t, conn, "e2", "2099-01-02T00:00:00Z", "github", "pr", "o/r#1")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktree-resources?path=" + url.QueryEscape(wt))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []resourceDTO
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d resources, want 1", len(got))
	}
	if got[0].UnreadCount != 2 {
		t.Fatalf("unread_count = %d, want 2", got[0].UnreadCount)
	}
}

func TestWorktreesCarriesUnreadCountOnFocusResources(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := registerWorktreeForTest(t, conn, wt); err != nil {
		t.Fatal(err)
	}
	if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	insertEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktrees")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []worktreeSummary
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || len(got[0].FocusResources) != 1 {
		t.Fatalf("got %d worktrees, want 1 with 1 focus resource", len(got))
	}
	if got[0].FocusResources[0].UnreadCount != 1 {
		t.Fatalf("unread_count = %d, want 1", got[0].FocusResources[0].UnreadCount)
	}
}

func TestTimelineMarksEventsNewerThanTheCursorUnread(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	insertEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	insertEvent(t, conn, "e2", "2099-01-02T00:00:00Z", "github", "pr", "o/r#1")
	if err := unread.MarkRead(conn, "pr", "o/r#1", "2099-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktree-timeline?path=" + url.QueryEscape(wt))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got timelineResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	byID := map[string]bool{}
	for _, e := range got.Events {
		byID[e.ID] = e.Unread
	}
	if byID["e2"] != true {
		t.Fatal("e2 is newer than the cursor and must be unread")
	}
	if byID["e1"] != false {
		t.Fatal("e1 is AT the cursor and must be read")
	}
}

func TestTimelineNeverMarksSlackEventsUnread(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := resources.Add(conn, wt, resources.Resource{Type: "slack", ID: "C1:1.2", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	insertEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "slack", "slack", "C1:1.2")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktree-timeline?path=" + url.QueryEscape(wt))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got timelineResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	for _, e := range got.Events {
		if e.Unread {
			t.Fatal("a slack event must never carry unread; the thread owns that state")
		}
	}
}
```

`registerWorktreeForTest` is a helper the webui tests already need for `/api/worktrees` to return a row. Look for an existing one in `internal/webui/worktrees_test.go` and reuse it verbatim; if none exists, add this to `unread_test.go`:

```go
func registerWorktreeForTest(t *testing.T, conn *sql.DB, path string) error {
	t.Helper()
	_, err := conn.Exec(
		`INSERT INTO worktrees (path, repo, repo_root, branch, created_at)
		 VALUES (?, 'repo', ?, 'br', '2026-01-01T00:00:00Z')`, path, path)
	return err
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/webui/ -run TestWorktreeResourcesCarriesUnreadCount -v`
Expected: FAIL to compile — `got[0].UnreadCount` undefined (type `resourceDTO` has no field `UnreadCount`).

- [ ] **Step 3: Add the request-scoped unread index**

Create `internal/webui/unread.go`:

```go
package webui

import (
	"github.com/mturley/worktree/internal/unread"
)

// unreadIndex answers "how many unread?" and "is this event unread?" for ONE
// request, from two queries taken up front.
//
// Request-scoped for the same reason eventEnricher is (see timeline.go): its
// contents change whenever the poller writes events or anyone moves a cursor,
// including from OTHER PROCESSES writing this same SQLite file (`worktree
// resources mark-read`, agent-handler's shell-outs). Hanging it off Server
// would need invalidation this process cannot observe. At request scope there
// is nothing to invalidate — the next request builds a fresh one.
//
// A read failure yields an empty index, which degrades to "nothing unread".
// That is the same direction every other enrichment failure here degrades:
// a missing dot is a smaller lie than a wrong one.
type unreadIndex struct {
	counts  map[string]int
	cursors map[string]string
}

func (s *Server) newUnreadIndex() *unreadIndex {
	ix := &unreadIndex{counts: map[string]int{}, cursors: map[string]string{}}
	if c, err := unread.Counts(s.DB); err == nil {
		ix.counts = c
	} else if s.Logger != nil {
		s.Logger.Printf("unread.Counts: %v", err)
	}
	if c, err := unread.Cursors(s.DB); err == nil {
		ix.cursors = c
	} else if s.Logger != nil {
		s.Logger.Printf("unread.Cursors: %v", err)
	}
	return ix
}

// Count returns the unread event count for a resource, 0 when it has no
// cursor (Slack threads, and anything never seeded).
func (ix *unreadIndex) Count(resType, id string) int {
	if ix == nil {
		return 0
	}
	return ix.counts[unread.Key(resType, id)]
}

// IsUnread reports whether one event is newer than its resource's cursor.
//
// Always false for a Slack resource: Slack's read state is a message ts held
// in the thread, and the cached state carries only the derived has_unread
// boolean — there is no per-message cursor here to compare against. A Slack
// thread's unread state reaches the timeline through its resource chip
// instead.
func (ix *unreadIndex) IsUnread(resType, id, ts string) bool {
	if ix == nil || resType == "slack" {
		return false
	}
	cursor, ok := ix.cursors[unread.Key(resType, id)]
	if !ok {
		return false
	}
	return ts > cursor
}
```

- [ ] **Step 4: Add the DTO and event fields and wire them up**

In `internal/webui/resources_api.go`, add to `resourceDTO` immediately after the `HasUnread` line, keeping the aligned-comment style:

```go
	UnreadCount           int      `json:"unread_count,omitempty"`             // non-slack: events newer than the read cursor
```

In the same file, change `handleWorktreeResources`'s loop to stamp counts from one index:

```go
	ix := s.newUnreadIndex()
	out := make([]resourceDTO, 0, len(rs))
	for _, res := range rs {
		dto := s.newResourceDTO(res)
		dto.UnreadCount = ix.Count(dto.Type, dto.ID)
		out = append(out, dto)
	}
```

In `internal/webui/worktrees.go`, build one index before the `for _, e := range entries` loop:

```go
	// One index for the whole response: the alternative is a count query per
	// resource per worktree.
	ix := s.newUnreadIndex()
```

and stamp it where focus DTOs are built, replacing the existing `focus = append(focus, s.newResourceDTO(res))`:

```go
				dto := s.newResourceDTO(res)
				dto.UnreadCount = ix.Count(dto.Type, dto.ID)
				focus = append(focus, dto)
```

In `internal/webui/timeline.go`, add to the `TimelineEvent` struct, next to the other per-event fields:

```go
	// Unread is true when this event is newer than its resource's read
	// cursor. Always false for Slack — see unreadIndex.IsUnread.
	Unread bool `json:"unread,omitempty"`
```

Give `eventEnricher` an index. Add the field to the struct:

```go
	unread *unreadIndex
```

set it in `newEventEnricher`, alongside the other one-per-request maps:

```go
		unread:        s.newUnreadIndex(),
```

and stamp both the event flag and the chip's count in `fillResource`, replacing its opening block:

```go
	if dto := e.resource(te.ResourceType, te.ResourceID); dto != nil {
		te.Resource = dto
		// Kept alongside Resource: existing consumers read this directly, and
		// it is the plain-text fallback when no chip is shown.
		te.ResourceTitle = dto.Title
	}
	te.Unread = e.unread.IsUnread(te.ResourceType, te.ResourceID, te.TS)
```

`e.resource(...)` memoises one `*resourceDTO` per resource per request, so set its count where the DTO is created rather than per event. In `(*eventEnricher).resource`, after `e.s.enrichResourceDTO(dto)`:

```go
	dto.UnreadCount = e.unread.Count(rtype, rid)
```

`writeTimelineRows` already builds the enricher and calls `fillResource` for every row, so both timeline handlers pick this up with no further change.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./internal/webui/...`
Expected: PASS.

- [ ] **Step 6: Run the full Go suite**

Run: `go test ./...`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/webui/unread.go internal/webui/unread_test.go internal/webui/resources_api.go internal/webui/worktrees.go internal/webui/timeline.go
git commit --signoff -m "feat(unread): serve unread counts and per-event unread flags"
```

---

### Task 4: The mark-read endpoint

**Files:**
- Modify: `internal/webui/unread.go` (add the handler)
- Modify: `internal/webui/server.go` (register the route)
- Modify: `internal/webui/unread_test.go`

**Interfaces:**
- Consumes: `unread.MarkRead(conn *sql.DB, resType, id, throughTS string) error`, `unread.ErrSlackNotSupported` from Task 1.
- Produces: `POST /api/resource-read`, body `{"type":string,"id":string,"through_ts":string}`, 204 on success.

- [ ] **Step 1: Write the failing tests**

Append to `internal/webui/unread_test.go`:

```go
func postResourceRead(t *testing.T, base, body string) *http.Response {
	t.Helper()
	resp, err := http.Post(base+"/api/resource-read", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestResourceReadMarksThroughTheClientsTimestamp(t *testing.T) {
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	insertEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	insertEvent(t, conn, "e2", "2099-01-02T00:00:00Z", "github", "pr", "o/r#1")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// The client saw only e1. e2 arrived after render and must survive.
	resp := postResourceRead(t, ts.URL,
		`{"type":"pr","id":"o/r#1","through_ts":"2099-01-01T00:00:00Z"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.StatusCode)
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#1")]; n != 1 {
		t.Fatalf("unread = %d, want 1 — an event newer than through_ts must survive the mark", n)
	}
}

func TestResourceReadRejectsSlack(t *testing.T) {
	conn := unreadTestDB(t)
	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := postResourceRead(t, ts.URL, `{"type":"slack","id":"C1:1.2","through_ts":"1.0"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestResourceReadRequiresTypeIDAndThroughTS(t *testing.T) {
	conn := unreadTestDB(t)
	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	for _, body := range []string{
		`{"id":"o/r#1","through_ts":"2099-01-01T00:00:00Z"}`,
		`{"type":"pr","through_ts":"2099-01-01T00:00:00Z"}`,
		`{"type":"pr","id":"o/r#1"}`,
	} {
		resp := postResourceRead(t, ts.URL, body)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400", body, resp.StatusCode)
		}
		resp.Body.Close()
	}
}
```

Add `"strings"` to the test file's imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/webui/ -run TestResourceRead -v`
Expected: FAIL — all three report `status = 404, want 204/400`; the route does not exist.

- [ ] **Step 3: Implement the handler**

Append to `internal/webui/unread.go`:

```go
// handleResourceRead: POST /api/resource-read, body
// {"type":..., "id":..., "through_ts":...} -> 204.
//
// through_ts is the newest event the CLIENT rendered. The server deliberately
// does NOT substitute its own MAX(ts): events that arrived between render and
// click must stay unread rather than being swallowed by a button that promised
// to clear a specific number.
func (s *Server) handleResourceRead(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type      string `json:"type"`
		ID        string `json:"id"`
		ThroughTS string `json:"through_ts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Type == "" || req.ID == "" {
		writeError(w, http.StatusBadRequest, "type and id are required")
		return
	}
	if req.ThroughTS == "" {
		writeError(w, http.StatusBadRequest, "through_ts is required")
		return
	}
	if err := unread.MarkRead(s.DB, req.Type, req.ID, req.ThroughTS); err != nil {
		if errors.Is(err, unread.ErrSlackNotSupported) {
			// Bad input, not a server fault: Slack owns this thread's read
			// state and the thread view is where it is cleared.
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

Extend the file's imports to `"encoding/json"`, `"errors"`, `"net/http"`, and the existing `unread` import.

- [ ] **Step 4: Register the route**

In `internal/webui/server.go`, in `registerAPI`, next to the other `POST /api/resource-*` routes:

```go
	mux.HandleFunc("POST /api/resource-read", s.handleResourceRead)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./internal/webui/...`
Expected: PASS.

- [ ] **Step 6: Run the full Go suite**

Run: `go test ./...`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/webui/unread.go internal/webui/unread_test.go internal/webui/server.go
git commit --signoff -m "feat(unread): POST /api/resource-read to move a resource's cursor"
```

---

### Task 5: CLI — unread counts in `resources list`, and `resources mark-read`

**Files:**
- Modify: `cmd/resources.go`
- Test: `cmd/resources_test.go`

**Interfaces:**
- Consumes: `unread.Counts`, `unread.Key`, `unread.MarkRead`, `unread.ErrSlackNotSupported` from Task 1.
- Produces:
  - `worktree resources mark-read <type> <id> [--through <ts>]`
  - `resourcesJSON(rs []resources.Resource, counts map[string]int) ([]byte, error)` — widened signature
  - `writeResourceLines(out io.Writer, rs []resources.Resource, counts map[string]int)`
  - `markResourceRead(conn *sql.DB, out io.Writer, resType, id, through string) error`

**Note on testability.** `cmd/resources_test.go` today tests `resourcesJSON` as a
pure function and has **no** harness for executing cobra commands against a
temp DB — `wdb.Open()` resolves the user's real database, which a test must
never touch. So the two new behaviours are implemented as functions taking an
explicit `io.Writer` and `*sql.DB`, with the cobra `RunE` reduced to opening the
DB and calling them. Do not add a cobra-execution harness for this.

- [ ] **Step 1: Write the failing tests**

Append to `cmd/resources_test.go`:

```go
func TestResourcesJSONCarriesUnreadCount(t *testing.T) {
	rs := []resources.Resource{
		{Type: "pr", ID: "o/r#1", URL: "http://x/1"},
		{Type: "jira", ID: "RH-2", URL: "http://x/2"},
	}
	counts := map[string]int{unread.Key("pr", "o/r#1"): 3}
	b, err := resourcesJSON(rs, counts)
	if err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got[0]["unread_count"] != float64(3) {
		t.Fatalf("unread_count = %v, want 3", got[0]["unread_count"])
	}
	// omitempty: a fully read resource's object must stay byte-identical to
	// what this command emitted before the field existed, because
	// agent-handler parses it.
	if _, present := got[1]["unread_count"]; present {
		t.Fatalf("a read resource must omit unread_count entirely: %+v", got[1])
	}
}

func TestWriteResourceLinesAppendsUnreadOnlyWhenNonZero(t *testing.T) {
	rs := []resources.Resource{
		{Type: "pr", ID: "o/r#1", URL: "http://x/1"},
		{Type: "jira", ID: "RH-2", URL: "http://x/2", Related: true},
	}
	var buf bytes.Buffer
	writeResourceLines(&buf, rs, map[string]int{unread.Key("pr", "o/r#1"): 2})
	out := buf.String()

	if !strings.Contains(out, "  pr:o/r#1 http://x/1 (2 unread)\n") {
		t.Fatalf("unread resource line wrong: %q", out)
	}
	// The read resource keeps the exact pre-existing shape.
	if !strings.Contains(out, "~ jira:RH-2 http://x/2\n") {
		t.Fatalf("read resource line must be unchanged: %q", out)
	}
}

func TestMarkResourceReadDefaultsToTheNewestEvent(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	seedEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "pr", "o/r#1")
	seedEvent(t, conn, "e2", "2099-01-02T00:00:00Z", "pr", "o/r#1")

	var buf bytes.Buffer
	if err := markResourceRead(conn, &buf, "pr", "o/r#1", ""); err != nil {
		t.Fatal(err)
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#1")]; n != 0 {
		t.Fatalf("unread = %d, want 0 — a bare mark-read clears through the newest event", n)
	}
}

func TestMarkResourceReadHonoursAnExplicitThrough(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	seedEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "pr", "o/r#1")
	seedEvent(t, conn, "e2", "2099-01-02T00:00:00Z", "pr", "o/r#1")

	var buf bytes.Buffer
	if err := markResourceRead(conn, &buf, "pr", "o/r#1", "2099-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#1")]; n != 1 {
		t.Fatalf("unread = %d, want 1", n)
	}
}

func TestMarkResourceReadRejectsSlackWithAPointerToTheThreadView(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	var buf bytes.Buffer
	err = markResourceRead(conn, &buf, "slack", "C1:1.2", "")
	if err == nil {
		t.Fatal("mark-read must reject a slack resource")
	}
	if !strings.Contains(err.Error(), "thread view") {
		t.Fatalf("error %q must point the user at the thread view", err)
	}
}

func TestMarkResourceReadSaysSoWhenThereAreNoEvents(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	var buf bytes.Buffer
	if err := markResourceRead(conn, &buf, "pr", "o/r#9", ""); err != nil {
		t.Fatalf("a resource with no events is not an error: %v", err)
	}
	if !strings.Contains(buf.String(), "no events") {
		t.Fatalf("output %q must say there was nothing to mark", buf.String())
	}
}

// seedEvent inserts one event linked to one resource.
func seedEvent(t *testing.T, conn *sql.DB, id, ts, resType, resID string) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO watcher_events (id, ts, source, type, title) VALUES (?, ?, 'github', 'pr_comment', 'x')`,
		id, ts); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id) VALUES (?, ?, ?)`,
		id, resType, resID); err != nil {
		t.Fatal(err)
	}
}
```

Add to the test file's imports: `"bytes"`, `"database/sql"`, `"path/filepath"`, `"strings"`, `wdb "github.com/mturley/worktree/internal/db"`, and `"github.com/mturley/worktree/internal/unread"`.

The existing `TestResourcesJSONContract` and `TestResourcesJSONIncludesMetaFields` call `resourcesJSON(rs)` and will stop compiling once the signature widens. Update both call sites to `resourcesJSON(rs, nil)` — a nil map reads as all-zero, which is exactly "nothing unread" and keeps those tests asserting what they always did.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./cmd/ -run 'TestResourcesJSONCarries|TestWriteResourceLines|TestMarkResourceRead' -v`
Expected: FAIL to compile — `writeResourceLines` and `markResourceRead` are undefined, and `resourcesJSON` takes 1 argument.

- [ ] **Step 3: Widen `resourcesJSON` and extract the line writer**

In `cmd/resources.go`, add the field to `resourceJSON`:

```go
	UnreadCount       int    `json:"unread_count,omitempty"`
```

`omitempty` is load-bearing: a fully read resource's JSON object stays
byte-identical to today's, so anything already parsing this output — agent-handler
shells out to this binary — keeps working untouched.

Widen the builder:

```go
func resourcesJSON(rs []resources.Resource, counts map[string]int) ([]byte, error) {
	out := make([]resourceJSON, 0, len(rs)) // ensures [] not null when empty
	for _, r := range rs {
		out = append(out, resourceJSON{
			Type: r.Type, ID: r.ID, URL: r.URL, Primary: !r.Related,
			CustomName: r.CustomName, CustomDescription: r.CustomDescription,
			UpdatedAt: r.UpdatedAt,
			// A nil map reads as zero, which is what "no cursor" means.
			UnreadCount: counts[unread.Key(r.Type, r.ID)],
		})
	}
	return json.Marshal(out)
}
```

Add the plain-text writer next to it:

```go
// writeResourceLines renders the human-readable listing. Split out from
// runResourcesList so it can be tested without a DB or a cobra command.
//
// The unread suffix appears ONLY for a non-zero count, so a fully read
// resource prints exactly the line this command has always printed.
func writeResourceLines(out io.Writer, rs []resources.Resource, counts map[string]int) {
	for _, r := range rs {
		marker := " "
		if r.Related {
			marker = "~"
		}
		suffix := ""
		if n := counts[unread.Key(r.Type, r.ID)]; n > 0 {
			suffix = fmt.Sprintf(" (%d unread)", n)
		}
		fmt.Fprintf(out, "%s %s:%s %s%s\n", marker, r.Type, r.ID, r.URL, suffix)
	}
}
```

Rewrite `runResourcesList`'s tail to use both:

```go
	counts, err := unread.Counts(conn)
	if err != nil {
		return err
	}
	if resJSON {
		b, err := resourcesJSON(rs, counts)
		if err != nil {
			return err
		}
		fmt.Fprintln(cmd.OutOrStdout(), string(b))
		return nil
	}
	writeResourceLines(cmd.OutOrStdout(), rs, counts)
	return nil
```

- [ ] **Step 4: Add the `mark-read` command**

In `cmd/resources.go`, declare the flag variable next to the other `res*` flag vars:

```go
var resThrough string
```

Add the command definition next to `resourcesSetNameCmd`:

```go
var resourcesMarkReadCmd = &cobra.Command{
	Use:   "mark-read <type> <id>",
	Short: "Mark a resource's events read up to a timestamp",
	Long: "Moves the resource's read cursor. With no --through, marks read through " +
		"the resource's newest event.\n\n" +
		"The cursor is per RESOURCE, not per worktree: marking a PR read clears it " +
		"for every worktree tracking it.",
	Args: cobra.ExactArgs(2),
	RunE: runResourcesMarkRead,
}
```

Register it by adding `resourcesMarkReadCmd` to the existing `resourcesCmd.AddCommand(...)` call in `init`, and add its flag there too:

```go
	resourcesMarkReadCmd.Flags().StringVar(&resThrough, "through", "", "RFC3339 timestamp to mark read through (default: the resource's newest event)")
```

Implement the thin wrapper and the testable core:

```go
func runResourcesMarkRead(cmd *cobra.Command, args []string) error {
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	return markResourceRead(conn, cmd.OutOrStdout(), args[0], args[1], resThrough)
}

// markResourceRead moves a resource's read cursor, defaulting `through` to the
// resource's newest event.
//
// Unlike the web UI — where the client sends the newest timestamp it actually
// RENDERED, so later arrivals survive the mark — the CLI has no rendered view
// to be stale against, so "everything I could have seen" is the honest default.
func markResourceRead(conn *sql.DB, out io.Writer, resType, id, through string) error {
	if resType == "slack" {
		return fmt.Errorf(
			"%w; clear it from the thread view in `worktree ui`", unread.ErrSlackNotSupported)
	}
	if through == "" {
		if err := conn.QueryRow(`
			SELECT COALESCE(MAX(e.ts), '')
			  FROM watcher_events e
			  JOIN watcher_event_resources er ON er.event_id = e.id
			 WHERE er.resource_type = ? AND er.resource_id = ?`,
			resType, id).Scan(&through); err != nil {
			return err
		}
		if through == "" {
			// No events at all: nothing to mark, and MarkRead would reject an
			// empty timestamp. Not an error — the user asked for a state that
			// already holds.
			fmt.Fprintf(out, "no events for %s:%s\n", resType, id)
			return nil
		}
	}
	if err := unread.MarkRead(conn, resType, id, through); err != nil {
		return err
	}
	fmt.Fprintf(out, "marked %s:%s read through %s\n", resType, id, through)
	return nil
}
```

Add `"database/sql"`, `"io"`, and `"github.com/mturley/worktree/internal/unread"` to the file's imports.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./cmd/...`
Expected: PASS.

- [ ] **Step 6: Run the full Go suite**

Run: `go test ./...`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cmd/resources.go cmd/resources_test.go
git commit --signoff -m "feat(unread): CLI unread counts and a mark-read command"
```

---

### Task 6: Frontend shared primitives

**Files:**
- Create: `ui/src/lib/unread.ts`
- Create: `ui/src/lib/unread.test.ts`
- Create: `ui/src/components/UnreadDivider.tsx`
- Modify: `ui/src/api/types.ts:40-64` (`ResourceDTO`), `ui/src/api/types.ts:22-38` (`TimelineEvent`)
- Modify: `ui/src/api/client.ts` (add `markResourceRead`)
- Modify: `ui/src/components/ResourceStatusIcon.tsx` (export `UnreadDot`, drive it from the helper)
- Modify: `ui/src/components/slack/ThreadView.tsx:316-318` (use the shared divider)
- Test: `ui/src/components/ResourceStatusIcon.test.tsx`

**Interfaces:**
- Consumes: `resourceDTO.unread_count` and `TimelineEvent.unread` from Task 3; `POST /api/resource-read` from Task 4.
- Produces:
  - `hasUnread(r: ResourceDTO): boolean` from `ui/src/lib/unread.ts`
  - `<UnreadDot r={resource} />` exported from `ui/src/components/ResourceStatusIcon.tsx`
  - `<UnreadDivider />` from `ui/src/components/UnreadDivider.tsx`
  - `api.markResourceRead({ type, id, through_ts }): Promise<null>`

- [ ] **Step 1: Write the failing test for the helper**

Create `ui/src/lib/unread.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { hasUnread } from "./unread"
import type { ResourceDTO } from "../api/types"

const base = (over: Partial<ResourceDTO>): ResourceDTO =>
  ({ type: "pr", id: "o/r#1", url: "u", primary: true, ...over })

describe("hasUnread", () => {
  it("reads unread_count for a PR", () => {
    expect(hasUnread(base({ unread_count: 2 }))).toBe(true)
    expect(hasUnread(base({ unread_count: 0 }))).toBe(false)
    expect(hasUnread(base({}))).toBe(false)
  })

  it("reads unread_count for a Jira issue", () => {
    expect(hasUnread(base({ type: "jira", id: "J-1", unread_count: 1 }))).toBe(true)
  })

  it("reads has_unread for a Slack thread, ignoring unread_count", () => {
    expect(hasUnread(base({ type: "slack", id: "C1:1.2", has_unread: true }))).toBe(true)
    // Slack never gets a cursor, so a count here would be meaningless — the
    // thread's own read state is the only authority.
    expect(hasUnread(base({ type: "slack", id: "C1:1.2", has_unread: false, unread_count: 5 }))).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `ui/`): `npm test -- unread`
Expected: FAIL — cannot resolve `./unread`.

- [ ] **Step 3: Add the types, the helper, and the API client method**

In `ui/src/api/types.ts`, add to `ResourceDTO` immediately after `has_unread`:

```ts
  /** non-slack: events newer than the read cursor. Absent means zero. */
  unread_count?: number
```

and to `TimelineEvent`:

```ts
  /**
   * Newer than this event's resource read cursor. Always false for Slack —
   * the thread owns that state, and it shows on the resource chip instead.
   */
  unread?: boolean
```

Create `ui/src/lib/unread.ts`:

```ts
import type { ResourceDTO } from "../api/types"

/**
 * Whether a resource has activity the user has not seen.
 *
 * Two sources, one question. A Slack thread's read state belongs to Slack and
 * arrives as the poller-cached `has_unread`; everything else is counted
 * against worktree's own per-resource cursor. Every surface calls this rather
 * than branching on type itself, so the split stays in one place — and so
 * adding a third source later touches one file.
 */
export function hasUnread(r: ResourceDTO): boolean {
  if (r.type === "slack") return !!r.has_unread
  return (r.unread_count ?? 0) > 0
}
```

In `ui/src/api/client.ts`, add to the `api` object:

```ts
  markResourceRead: (args: { type: string; id: string; through_ts: string }) =>
    fetchJSON<null>("/api/resource-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
```

`fetchJSON` parses the body with `.catch(() => null)`, so a 204 with no body resolves to `null` rather than throwing.

- [ ] **Step 4: Export `UnreadDot` and drive it from the helper**

In `ui/src/components/ResourceStatusIcon.tsx`, replace the existing private `UnreadDot` with an exported, self-deciding one:

```tsx
/**
 * Unread marker for a resource.
 *
 * Renders nothing unless the resource has unread activity, so callers can
 * place it unconditionally. It decides via hasUnread, which is the single
 * place that knows Slack answers from its own read state and everything else
 * from the per-resource cursor.
 *
 * Exported because the dot has to appear wherever a resource is NAMED, not
 * just where ResourceTitle is used: the worktree card's focus lines and the
 * timeline's resource chips both render a bare icon.
 */
export function UnreadDot({ r }: { r: ResourceDTO }) {
  if (!hasUnread(r)) return null
  return (
    <span
      role="img"
      aria-label="unread"
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: "var(--mantine-color-blue-5)",
        flexShrink: 0,
      }}
    />
  )
}
```

Add `import { hasUnread } from "../lib/unread"` to the file, and simplify `ResourceTitle`'s use of it — the guard now lives in the component:

```tsx
      <UnreadDot r={r} />
```

- [ ] **Step 5: Extract the shared unread divider**

Create `ui/src/components/UnreadDivider.tsx`:

```tsx
import { Divider } from "@mantine/core"

/**
 * The line separating unread from read.
 *
 * Shared by the Slack thread view and the single-resource activity feed so
 * the two cannot drift: "new below this line" must look like one idea, not
 * two features that happen to both draw a rule.
 */
export function UnreadDivider() {
  return <Divider label="New" labelPosition="center" color="blue" my="sm" />
}
```

In `ui/src/components/slack/ThreadView.tsx`, replace the inline divider at the `hasUnread && index === data.unreadIndex` branch with `<UnreadDivider />` and import it from `"../UnreadDivider"`. Drop the now-unused `Divider` import only if nothing else in that file uses it — check before removing.

- [ ] **Step 6: Update the existing icon test for the widened behaviour**

In `ui/src/components/ResourceStatusIcon.test.tsx`, the `describe("unread dot")` block currently covers only Slack. Add a case proving a PR gets one:

```tsx
  it("marks a PR with unread events", () => {
    render(
      <MantineProvider>
        <ResourceTitle r={base({ type: "pr", title: "Fix the thing", unread_count: 3 })} />
      </MantineProvider>,
    )
    expect(screen.getByLabelText("unread")).toBeInTheDocument()
  })
```

Match the existing file's render helper and `base(...)` signature rather than copying this verbatim if they differ.

- [ ] **Step 7: Run the frontend tests**

Run (from `ui/`): `npm test`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run (from `ui/`): `NODE_OPTIONS= npx tsc -b`
Expected: no output. (Do **not** pass `--noEmit` here — it is invalid in build mode and fails with TS6310.)

- [ ] **Step 9: Commit**

```bash
git add ui/src/lib/unread.ts ui/src/lib/unread.test.ts ui/src/components/UnreadDivider.tsx ui/src/api/types.ts ui/src/api/client.ts ui/src/components/ResourceStatusIcon.tsx ui/src/components/ResourceStatusIcon.test.tsx ui/src/components/slack/ThreadView.tsx
git commit --signoff -m "feat(ui): shared unread helper, dot, and divider"
```

---

### Task 7: Unread dots on every resource surface and on timeline events

**Files:**
- Modify: `ui/src/components/WorktreeCard.tsx:62-88` (`FocusResourceLine`)
- Modify: `ui/src/components/EventResourceChip.tsx:45-49`
- Modify: `ui/src/components/EventRow.tsx:42-58`
- Test: `ui/src/components/WorktreeCard.test.tsx`, `ui/src/components/EventResourceChip.test.tsx`, `ui/src/components/EventRow.test.tsx`

**Interfaces:**
- Consumes: `<UnreadDot r={r} />` from `ui/src/components/ResourceStatusIcon.tsx` (Task 6); `TimelineEvent.unread` (Task 6 types).
- Produces: nothing later tasks consume.

- [ ] **Step 1: Write the failing tests**

Each of these three files already defines its own fixtures and render helper —
use them exactly as written below rather than adding new ones.

Add to `ui/src/components/WorktreeCard.test.tsx` (it defines `summary` and a
`wrap` that supplies both `MantineProvider` and a `QueryClientProvider`):

```tsx
it("shows an unread dot on a focus resource with unread events", () => {
  wrap(<WorktreeCard w={{
    ...summary,
    focus_resources: [
      { type: "pr", id: "o/r#1", url: "u", primary: true, title: "Fix the widget", state: "OPEN", unread_count: 2 } as ResourceDTO,
    ],
  }} />)
  expect(screen.getByLabelText("unread")).toBeInTheDocument()
})

it("shows no unread dot when every focus resource is read", () => {
  wrap(<WorktreeCard w={{
    ...summary,
    focus_resources: [
      { type: "pr", id: "o/r#1", url: "u", primary: true, title: "Fix the widget", state: "OPEN" } as ResourceDTO,
    ],
  }} />)
  expect(screen.queryByLabelText("unread")).not.toBeInTheDocument()
})
```

Add to `ui/src/components/EventResourceChip.test.tsx` (it defines `ev(overrides)`
and a `wrap`):

```tsx
it("shows an unread dot when the event's resource has unread activity", () => {
  const e = ev({
    resource: { type: "pr", id: "o/r#42", url: "u", primary: true, state: "OPEN", unread_count: 1 } as ResourceDTO,
  })
  wrap(<EventResourceChip e={e} onSelect={vi.fn()} />)
  expect(screen.getByLabelText("unread")).toBeInTheDocument()
})

it("shows no unread dot for a read resource", () => {
  const e = ev({
    resource: { type: "pr", id: "o/r#42", url: "u", primary: true, state: "OPEN" } as ResourceDTO,
  })
  wrap(<EventResourceChip e={e} onSelect={vi.fn()} />)
  expect(screen.queryByLabelText("unread")).not.toBeInTheDocument()
})
```

Add to `ui/src/components/EventRow.test.tsx` (it defines `makeEvent(overrides)`
and `renderWithProvider`):

```tsx
it("marks an unread event", () => {
  renderWithProvider(<EventRow e={makeEvent({ unread: true })} />)
  expect(screen.getByLabelText("unread event")).toBeInTheDocument()
})

it("does not mark a read event", () => {
  renderWithProvider(<EventRow e={makeEvent({ unread: false })} />)
  expect(screen.queryByLabelText("unread event")).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `ui/`): `npm test -- WorktreeCard EventResourceChip EventRow`
Expected: FAIL — `getByLabelText("unread")` and `getByLabelText("unread event")` find nothing.

- [ ] **Step 3: Add the dot to the worktree card's focus lines**

In `ui/src/components/WorktreeCard.tsx`, in `FocusResourceLine`'s `<Group>`, before the status icon:

```tsx
        <UnreadDot r={r} />
        {/* Same mapping as the resource cards' titles: both read
            resourceStatusMeta, so an icon change lands in both places. */}
        <ResourceStatusIcon r={r} />
```

Extend the existing import to `import { ResourceStatusIcon, UnreadDot } from "./ResourceStatusIcon"`.

- [ ] **Step 4: Add the dot to the timeline's resource chip**

In `ui/src/components/EventResourceChip.tsx`, in the `<Group>`, before the icon:

```tsx
        <UnreadDot r={forIcon} />
        <ResourceStatusIcon r={forIcon} />
```

Extend the import to `import { ResourceStatusIcon, UnreadDot } from "./ResourceStatusIcon"`. `forIcon` is already the resolved resource with the bare-shape fallback, so an event whose resource is not in the worktree's list simply shows no dot.

- [ ] **Step 5: Add the per-event dot to the timeline row**

In `ui/src/components/EventRow.tsx`, inside the title `<Group>`, before the title `<Text>`:

```tsx
              {e.unread && (
                // A mark on the ROW, not on the rail dot: the rail dot already
                // encodes event type, and loading a second, unrelated signal
                // onto it makes both harder to read. Unified timelines
                // interleave resources, so unread events are not contiguous
                // and a divider cannot be drawn here — each one is marked
                // individually instead.
                <span
                  role="img"
                  aria-label="unread event"
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: "var(--mantine-color-blue-5)",
                    flexShrink: 0,
                  }}
                />
              )}
              <Text size="sm" fw={600} style={{ overflowWrap: "anywhere", minWidth: 0 }}>{e.title}</Text>
```

This deliberately does **not** reuse `UnreadDot`: that component takes a `ResourceDTO` and answers a question about a resource, while this marks a single event. Same visual, different subject — and `aria-label="unread event"` keeps the two distinguishable in tests and to a screen reader.

- [ ] **Step 6: Run the frontend tests**

Run (from `ui/`): `npm test`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run (from `ui/`): `NODE_OPTIONS= npx tsc -b`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/WorktreeCard.tsx ui/src/components/WorktreeCard.test.tsx ui/src/components/EventResourceChip.tsx ui/src/components/EventResourceChip.test.tsx ui/src/components/EventRow.tsx ui/src/components/EventRow.test.tsx
git commit --signoff -m "feat(ui): unread dots on resource surfaces and timeline events"
```

---

### Task 8: The divider and mark-read button in the single-resource feed

**Files:**
- Modify: `ui/src/components/TimelineFeed.tsx:8-33` (accept a divider index), `ui/src/components/TimelineFeed.tsx:59-69` (render it)
- Modify: `ui/src/components/ResourceDetailPane.tsx:27-77` (`TimelineBody`)
- Test: `ui/src/components/TimelineFeed.test.tsx`, `ui/src/components/ResourceDetailPane.test.tsx`

**Interfaces:**
- Consumes: `<UnreadDivider />` (Task 6), `api.markResourceRead` (Task 6), `TimelineEvent.unread` (Task 6), `resourceDTO.unread_count` (Task 6 types).
- Produces: nothing later tasks consume.

- [ ] **Step 1: Write the failing tests**

`ui/src/components/TimelineFeed.test.tsx` defines `ev(id)` — which takes an id
only — and a `wrap`. Widen `ev` to accept overrides, keeping every existing
call working:

```tsx
const ev = (id: string, o: Partial<TimelineEvent> = {}): TimelineEvent =>
  ({ id, ts: "2026-08-25T00:00:00Z", type: "pr_comment", type_label: "PR comments",
     title: `event ${id}`, body: "", author: "", source: "github", external_ts: "",
     resource_type: "pr", resource_id: "o/r#1", resource_url: "u", resource_title: "",
     worktrees: [], ...o }) as TimelineEvent
```

Then add:

```tsx
describe("TimelineFeed unread divider", () => {
  it("draws the divider above the oldest unread event", () => {
    wrap(
      <TimelineFeed
        events={[
          ev("e3", { title: "newest", unread: true }),
          ev("e2", { title: "middle", unread: true }),
          ev("e1", { title: "oldest", unread: false }),
        ]}
        loading={false}
        error={null}
        showUnreadDivider
      />,
    )
    const divider = screen.getByText("New")
    const middle = screen.getByText("middle")
    const oldest = screen.getByText("oldest")
    // The feed is newest-first, so the divider sits after the last unread
    // event and before the first read one.
    expect(middle.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(divider.compareDocumentPosition(oldest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("draws no divider when nothing is unread", () => {
    wrap(<TimelineFeed events={[ev("e1", { unread: false })]} loading={false} error={null} showUnreadDivider />)
    expect(screen.queryByText("New")).not.toBeInTheDocument()
  })

  it("draws no divider on a feed that did not ask for one", () => {
    // A unified feed interleaves resources, so a single line would be a lie.
    wrap(<TimelineFeed events={[ev("e1", { unread: true })]} loading={false} error={null} />)
    expect(screen.queryByText("New")).not.toBeInTheDocument()
  })
})
```

`ui/src/components/ResourceDetailPane.test.tsx` needs two changes before its new
tests can pass, and **both also affect every existing test in the file** — make
them first, and re-run the whole file after:

1. `TimelineBody` gains `useMutation`/`useQueryClient`, which throw without a
   `QueryClientProvider`. The file's `wrap` supplies only `MantineProvider`.
   Widen it (copy the pattern from `WorktreeCard.test.tsx`, which already does
   this):

```tsx
const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MantineProvider>,
  )
}
```

   importing `QueryClient, QueryClientProvider` from `@tanstack/react-query`.

2. The file mocks `../api/client` with an explicit object. Add
   `markResourceRead` to that mock alongside `removeResource`, or the mutation
   calls `undefined`:

```tsx
const markResourceRead = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { api: {
    ...actual.api,
    removeResource: (...args: unknown[]) => removeResource(...args),
    markResourceRead: (...args: unknown[]) => markResourceRead(...args),
  } }
})
```

   and reset it in the existing `afterEach`.

Then add the tests. The file's `useWorktreeTimeline` mock must return events, so
the button has a `through_ts` to send:

```tsx
const withEvents = () =>
  useWorktreeTimeline.mockReturnValue({
    events: [{ id: "e1", ts: "2099-01-02T00:00:00Z", unread: true } as TimelineEvent],
    isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false,
  })

it("offers to mark the resource's unread events read", () => {
  withEvents()
  wrap(<ResourceDetailPane path="/wt/foo" resource={{ ...jira, unread_count: 3 } as ResourceDTO} />)
  expect(screen.getByRole("button", { name: "Mark 3 events as read" })).toBeInTheDocument()
})

it("sends the newest RENDERED event as through_ts, so later arrivals survive", async () => {
  withEvents()
  wrap(<ResourceDetailPane path="/wt/foo" resource={{ ...jira, unread_count: 1 } as ResourceDTO} />)
  await userEvent.click(screen.getByRole("button", { name: "Mark 1 event as read" }))
  expect(markResourceRead).toHaveBeenCalledWith({
    type: "jira", id: "J-1", through_ts: "2099-01-02T00:00:00Z",
  })
})

it("hides the mark-read button when nothing is unread", () => {
  withEvents()
  wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
  expect(screen.queryByRole("button", { name: /Mark .* as read/ })).not.toBeInTheDocument()
})
```

Import `TimelineEvent` alongside `ResourceDTO` in that file's type import.

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `ui/`): `npm test -- TimelineFeed ResourceDetailPane`
Expected: FAIL — `showUnreadDivider` is not a valid prop on `TimelineFeed`, and
`getByRole("button", { name: "Mark 3 events as read" })` finds nothing.

- [ ] **Step 3: Teach `TimelineFeed` to draw the divider**

In `ui/src/components/TimelineFeed.tsx`, add the prop to the signature and its type:

```tsx
  /**
   * Draws the unread divider above the oldest unread event.
   *
   * Only meaningful on a SINGLE-RESOURCE feed: there, events share one cursor
   * and every unread one is contiguous at the top, so a single line splits the
   * list honestly. In a unified feed, events from different resources
   * interleave and unread ones are not contiguous — those mark each event
   * individually instead (see EventRow).
   */
  showUnreadDivider?: boolean
```

Compute the index just before the `return`:

```tsx
  // The oldest unread event, i.e. the last one in this newest-first list. The
  // divider goes immediately before it. -1 when nothing is unread.
  const dividerIndex = showUnreadDivider
    ? events.reduce((acc, e, i) => (e.unread ? i : acc), -1)
    : -1
```

and render it inside the `events.map`, replacing the bare `<EventRow .../>` with:

```tsx
          {events.map((e, i) => (
            <div key={e.id}>
              {i === dividerIndex && <UnreadDivider />}
              <EventRow
                e={e}
                showWorktrees={showWorktrees}
                onOpen={setDetail}
                onSelectResource={onSelectResource}
                resolveResource={resolveResource}
                onSelectWorktree={onSelectWorktree}
                canSelectResource={canSelectResource}
              />
            </div>
          ))}
```

Import `UnreadDivider` from `"./UnreadDivider"`.

- [ ] **Step 4: Add the divider and the button to `TimelineBody`**

In `ui/src/components/ResourceDetailPane.tsx`, `TimelineBody` gains the mutation and the header row. Replace its `<Title order={5}>Activity</Title>` and the `TimelineFeed` call with:

```tsx
      <Group justify="space-between" align="center">
        <Title order={5}>Activity</Title>
        {unreadCount > 0 && (
          <Button
            size="compact-xs"
            variant="subtle"
            loading={markRead.isPending}
            disabled={!newestTS}
            onClick={() => markRead.mutate()}
          >
            {`Mark ${unreadCount} ${unreadCount === 1 ? "event" : "events"} as read`}
          </Button>
        )}
      </Group>
      <TimelineFeed
        events={timeline.events}
        loading={timeline.isLoading}
        error={timeline.error}
        hasMore={timeline.hasMore}
        onLoadMore={timeline.loadMore}
        loadingMore={timeline.loadingMore}
        showUnreadDivider
      />
```

and add above the `return`:

```tsx
  const qc = useQueryClient()
  const unreadCount = resource.unread_count ?? 0
  // The newest event the user can actually see. Sent as through_ts so events
  // arriving between render and click stay unread rather than being swallowed
  // by a button that promised to clear a specific number. The feed is
  // newest-first, so this is the first entry.
  const newestTS = timeline.events[0]?.ts

  const markRead = useMutation({
    mutationFn: () =>
      api.markResourceRead({ type: resource.type, id: resource.id, through_ts: newestTS! }),
    onSuccess: () => {
      // Three surfaces show this resource's unread state: the home cards'
      // focus lines, this worktree's resource list, and every timeline's dots
      // and divider.
      void qc.invalidateQueries({ queryKey: ["worktrees"] })
      void qc.invalidateQueries({ queryKey: ["worktree-resources", path] })
      void qc.invalidateQueries({ queryKey: ["timeline"] })
      void qc.invalidateQueries({ queryKey: ["worktree-timeline"] })
    },
  })
```

Extend the Mantine import to include `Button` and `Group` (`Button` is already imported; add `Group`), add `import { useMutation, useQueryClient } from "@tanstack/react-query"` and `import { api } from "../api/client"`.

**Verify the query keys before writing them.** Open `ui/src/hooks/useTimeline.ts`, `ui/src/hooks/useWorktrees.ts`, and `ui/src/hooks/useWorktreeDetail.ts` and copy the actual `queryKey` prefixes those hooks use. The four above are the intended targets; if a hook keys differently, match the hook — an invalidation that names a key nobody registered silently does nothing, and the dots would go stale until the next SSE tick.

- [ ] **Step 5: Run the frontend tests**

Run (from `ui/`): `npm test`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run (from `ui/`): `NODE_OPTIONS= npx tsc -b`
Expected: no output.

- [ ] **Step 7: Build the whole thing**

Run: `make build`
Expected: the frontend builds and the Go binary compiles with the fresh assets embedded.

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/TimelineFeed.tsx ui/src/components/TimelineFeed.test.tsx ui/src/components/ResourceDetailPane.tsx ui/src/components/ResourceDetailPane.test.tsx
git commit --signoff -m "feat(ui): unread divider and mark-read button on the resource feed"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/web-ui-architecture.md` (HTTP API table, `worktreeSummary`/`TimelineEvent`/`resourceDTO` field lists, a new "Unread" section)
- Modify: `.claude/CLAUDE.md` (the `internal/` package list)
- Modify: `docs/ui-feature-roadmap.md` (remove the "In design" entry)

**Interfaces:**
- Consumes: everything built in Tasks 1-8.
- Produces: nothing.

- [ ] **Step 1: Document the endpoint and the fields**

In `docs/web-ui-architecture.md`, add a row to the HTTP API surface table next to the other `POST /api/resource-*` rows:

```
| POST | `/api/resource-read` | body: `{type, id, through_ts}` | 204 No Content |
```

Add `unread_count` to the `resourceDTO` field list and `unread` to the `TimelineEvent` field list, each with a one-line description matching the Go comments.

- [ ] **Step 2: Add an "Unread" section**

Add to `docs/web-ui-architecture.md`, after the "Delete worktree" section:

```markdown
### Unread (`internal/unread`, `internal/webui/unread.go`)

One read cursor per RESOURCE in `resource_read_cursor` (a worktree-owned
table), compared against `watcher_events.ts`. Unread is `ts > last_read_ts`,
strictly greater.

**Not the same model as agent-handler's.** Handler tracks unread per
*subscriber*, so each session has its own read state. This is per *resource*
and shared: marking a PR read in one worktree clears its dot in every worktree
tracking it.

**Slack threads have no cursor row.** Slack owns a read cursor for the current
user, worktree reads it via the poller-cached `has_unread`, and two systems
must not both claim authority over one thread. Every seeding path skips
`slack`; the endpoint and the CLI command reject it. `TimelineEvent.unread` is
therefore always false for Slack events — the thread's unread state reaches the
timeline through its resource chip instead.

**Seeding.** A resource with no cursor row reads as zero unread, so rows must
actually get written or a resource would never earn its first dot:
`resources.Add` seeds new subscriptions, and `internal/db`'s migration
backfills existing ones at their newest event. Both are INSERT OR IGNORE, so a
second worktree subscribing to a resource someone already reads inherits that
cursor rather than resetting it.

**`unreadIndex` is request-scoped**, for the same reason `eventEnricher` is:
cursors move from other processes (`worktree resources mark-read`,
agent-handler's shell-outs) writing this same SQLite file, which this server
cannot observe. Build one per request; never hang it off `Server`.

**`through_ts` is client-supplied.** The endpoint never substitutes a
server-side `MAX(ts)` — events arriving between render and click must stay
unread rather than being swallowed by a button that promised to clear a
specific number. The cursor only moves forward, so a stale replay is a no-op.
```

- [ ] **Step 3: Add the package to the repo CLAUDE.md**

In `.claude/CLAUDE.md`, add to the `internal/` package list, in the same style as its neighbours:

```markdown
  - `unread` — per-resource read cursor (`resource_read_cursor`). One cursor
    per RESOURCE, not per subscriber — deliberately unlike agent-handler's
    model, and shared across every worktree tracking the resource. Slack
    threads are excluded: they keep their own read state from the Slack API.
    See `docs/web-ui-architecture.md` "Unread".
```

- [ ] **Step 4: Clear the roadmap entry**

In `docs/ui-feature-roadmap.md`, delete the "In design" section's per-resource unread bullet (and the section heading if it leaves it empty), since the feature has shipped.

- [ ] **Step 5: Verify the docs match the code**

Re-read each claim against the implementation: the endpoint path and body, the two field names, the table name, and the package path. A doc that names a field the code does not have is worse than no doc.

- [ ] **Step 6: Commit**

```bash
git add docs/web-ui-architecture.md .claude/CLAUDE.md docs/ui-feature-roadmap.md
git commit --signoff -m "docs: per-resource unread cursor"
```
