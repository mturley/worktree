# Resource Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-worktree and per-resource "notify on new events" toggles that fire `cmux notify` notifications (under cmux) or browser notifications from exactly one tab per login session (without cmux).

**Architecture:** A worktree-owned table (`worktree_notify`, package `internal/notifyprefs`) stores the toggles. A notifier goroutine in `worktree ui` keeps a `(ts, seen-IDs)` cursor over `watcher_events`, turns new events for notifying resources into one batch per (worktree, resource), and hands each batch to the server's single delivery transport: `cmux notify` when `cmux.IsAvailable()`, otherwise an in-memory tab registry that sends a `notification` SSE message to one chosen tab per session and falls through on a negative ack or a 5s timeout. The UI adds two switches, bell indicators, and a stream handler that shows the notification and acks.

**Tech Stack:** Go 1.x (`net/http`, `database/sql` + SQLite), React + Mantine 7 + TanStack Query + wouter 3, Vitest + Testing Library, `@tabler/icons-react` 3.

**Spec:** `docs/superpowers/specs/2026-10-06-resource-notifications-design.md`

**Deviations from the spec, decided while planning (the spec is updated in Task 11):**
- `POST /api/notify`, not `PUT`. Every mutating route here is POST, and `guardMutations` and the route-auth test assume that shape.
- The tab routes are `POST /api/tabs/presence` and `POST /api/tabs/ack`, with the tab ID in the body. `TestEveryAPIRouteRequiresASession` refuses wildcard routes (`/api/tabs/{id}`).
- Initial presence travels on the stream URL (`/api/stream?tab=…&route=…&visible=…`). A presence POST sent before the stream registers would get a 404.
- Cleanup is hooked into `resources.Remove` / `resources.RemoveAll` only. Every `registry.Unregister` caller (`cmd/cleanup.go`, `internal/worktreedel`) already pairs it with `resources.RemoveAll`.
- Link resources get no switch and no bell, and the API rejects them: links are never polled, so they never have events.

## Global Constraints

- UI copy, verbatim:
  - unread switch label: `Unreads only`
  - worktree-wide switch label: `Notify on all`; its tooltip: `Notify on new events for all resources in this worktree`
  - per-resource switch label: `Notify on new events`; its disabled tooltip: `Notifications are enabled for all resources in the worktree`
  - explicit bell tooltip: `Notifications are on for this resource`
  - implicit bell tooltip: `Notifications are on for all resources in this worktree. Turn off 'Notify on all' at the top of this page to change it`
  - home-page worktree bell tooltip: `Notifications are on for all resources in this worktree`
  - blocked warning: `This browser is blocking notifications. Allow them in the site settings to receive them here.`
  - no-API warning: `This browser can't show notifications.`
  - not-yet-allowed warning: `Notifications aren't enabled in this browser`, with an `Allow` button
- Test notification: title `Notifications on`; body `You'll be notified about new events for <resource label>` or `You'll be notified about new events for all resources in <worktree name>`.
- Event types that never notify: `watch_started`, `watcher_error`, `ci_pending`, `ci_workflows_pending`.
- Notifier cadence is 5 seconds. The ack timeout is 5 seconds. The cursor starts at `MAX(ts)` at boot, so there is never a backlog.
- Delivery mode is `"cmux"` when `cmux.IsAvailable()`, else `"browser"`. It is chosen once per server process and exposed as `notify_mode` on `GET /api/session`.
- Notification `tag` = `worktree:<path>|<type>:<id>`, or `worktree:<path>|all` for a worktree-wide test.
- `watcher_subscriptions` joins always go through `wdb.Subscriber(path)` (CLAUDE.md gotcha).
- Commits use `git commit --signoff` and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `git add` names files explicitly.
- Go tests: `go test ./...` (or `make test`). UI tests: `cd ui && npm test`. UI typecheck: `cd ui && npx tsc --noEmit -p .`.

## Review Focus

1. **Several events in one second.** `watcher_events.ts` has 1-second resolution (e.g. `2026-10-06T20:33:54Z`). An event written in the same second as the cursor, after a pass has read that second, must still notify exactly once. Test in Task 3.
2. **A resource tracked by two worktrees with only one notifying.** Only that worktree is notified, and an event on a resource no worktree tracks notifies nobody. Test in Task 3.
3. **A stream reconnect reusing its tab ID.** The old connection's deferred unregister must not remove the new connection's registration. Test in Task 4.
4. **A tab ID used from another login session.** Presence or ack for it is refused (404) and doesn't change the tab. Test in Task 4.
5. **Link resources.** No switch, no bell, and `POST /api/notify` for a link returns 400. Tests in Tasks 6 and 9.

---

## File Structure

Go:
- Create `internal/notifyprefs/notifyprefs.go` (+ `_test.go`): the toggle table's CRUD.
- Modify `internal/db/migrate.go`: create `worktree_notify`.
- Modify `internal/resources/resources.go` (+ test): drop rows on Remove / RemoveAll.
- Modify `internal/cmux/cmux.go` (+ test): `Notify`.
- Create `internal/webui/notify_scan.go` (+ test): cursor, event read, batch building, label text.
- Create `internal/webui/tabs.go` (+ test): tab registry, candidate ordering, browser transport, presence/ack handlers.
- Modify `internal/webui/stream.go`: register tabs, forward `notification` messages.
- Create `internal/webui/notifier.go` (+ test): transport selection, cmux transport, loop, `deliver`.
- Create `internal/webui/notify_api.go` (+ test): `POST /api/notify` + test notifications.
- Modify `internal/webui/server.go`: fields, routes.
- Modify `internal/webui/auth.go`: `notify_mode` on the session DTO.
- Modify `internal/webui/worktrees.go`, `internal/webui/resources_api.go`: `notify_all` / `notify`.
- Modify `cmd/ui.go`: start the notifier.

UI (`ui/src/`):
- Modify `api/types.ts`, `api/client.ts`.
- Modify `components/UnreadOnlyToggle.tsx` (+ the tests that query its label).
- Create `lib/tabId.ts`, `lib/browserNotify.ts` (+ test).
- Modify `hooks/useSSE.ts` (+ test). Create `hooks/useTabPresence.ts` (+ test). Modify `App.tsx`.
- Create `hooks/useNotifyMode.ts`, `components/NotifySwitch.tsx` (+ test).
- Create `components/NotifyBell.tsx` (+ test).
- Modify `components/ResourceCard.tsx`, `SortableResourceCard.tsx`, `ResourceList.tsx`, `ResourceDetailPane.tsx`, `SlackThreadPane.tsx`, `LinkPane.tsx`, `ResourceTypeLine.tsx`, `WorktreeCard.tsx`, `pages/WorktreeDetailPage.tsx`.

Docs: `docs/web-ui-architecture.md`, `.claude/CLAUDE.md`, the spec.

---

### Task 1: `notifyprefs` package, table, and cleanup

**Files:**
- Create: `internal/notifyprefs/notifyprefs.go`
- Create: `internal/notifyprefs/notifyprefs_test.go`
- Modify: `internal/db/migrate.go` (append to the `stmts` slice, after the `worktree_notes` statement around line 63)
- Modify: `internal/resources/resources.go` (`Remove` ~line 199, `RemoveAll` ~line 215)
- Test: `internal/resources/resources_test.go`

**Interfaces:**
- Produces:
  - `notifyprefs.Key{Type, ID string}`
  - `notifyprefs.Prefs{All bool; Resources map[Key]bool}` with `func (p Prefs) Notifies(k Key) bool` (effective: `All || Resources[k]`)
  - `Get(conn *sql.DB, path string) (Prefs, error)`
  - `ListAll(conn *sql.DB) (map[string]Prefs, error)`, keyed by subscriber (`wdb.Subscriber(path)`)
  - `SetAll(conn, path string, on bool) error`
  - `SetResource(conn, path, typ, id string, on bool) error`
  - `RemoveResource(conn, path, typ, id string) error`
  - `RemoveAll(conn, path string) error`

- [ ] **Step 1: Add the table to the migration**

In `internal/db/migrate.go`, append to `stmts` right after the `worktree_notes` statement:

```go
		// Notification toggles (internal/notifyprefs). A row means "on"; a
		// row with an empty resource_type/resource_id is the worktree-wide
		// toggle. Unlike worktree_notes these are removed with the
		// worktree's resources (resources.Remove/RemoveAll): they are
		// settings about subscriptions, and outlive nothing.
		`CREATE TABLE IF NOT EXISTS worktree_notify (
			subscriber    TEXT NOT NULL,
			resource_type TEXT NOT NULL,
			resource_id   TEXT NOT NULL,
			created_at    TEXT NOT NULL,
			PRIMARY KEY (subscriber, resource_type, resource_id)
		)`,
```

- [ ] **Step 2: Write the failing tests**

`internal/notifyprefs/notifyprefs_test.go`:

```go
package notifyprefs

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func TestGetOnNothingIsAllOff(t *testing.T) {
	conn := testDB(t)
	p, err := Get(conn, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if p.All || len(p.Resources) != 0 || p.Notifies(Key{"pr", "o/r#1"}) {
		t.Fatalf("got %+v, want everything off", p)
	}
}

func TestWorktreeWideAndPerResourceAreIndependent(t *testing.T) {
	conn := testDB(t)
	wt := t.TempDir()
	k := Key{"pr", "o/r#1"}
	if err := SetResource(conn, wt, k.Type, k.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := SetAll(conn, wt, true); err != nil {
		t.Fatal(err)
	}
	if err := SetAll(conn, wt, false); err != nil {
		t.Fatal(err)
	}
	p, _ := Get(conn, wt)
	if p.All {
		t.Fatal("All still on after SetAll(false)")
	}
	if !p.Resources[k] {
		t.Fatal("turning the worktree-wide toggle off must keep the per-resource choice")
	}
}

func TestNotifiesIsEffectiveState(t *testing.T) {
	p := Prefs{All: true}
	if !p.Notifies(Key{"jira", "X-1"}) {
		t.Fatal("All must cover every resource")
	}
	p = Prefs{Resources: map[Key]bool{{"jira", "X-1"}: true}}
	if !p.Notifies(Key{"jira", "X-1"}) || p.Notifies(Key{"jira", "X-2"}) {
		t.Fatalf("per-resource match wrong: %+v", p)
	}
}

func TestSetIsIdempotentAndOffDeletes(t *testing.T) {
	conn := testDB(t)
	wt := t.TempDir()
	for i := 0; i < 2; i++ {
		if err := SetResource(conn, wt, "pr", "o/r#1", true); err != nil {
			t.Fatalf("second enable must not fail: %v", err)
		}
	}
	if err := SetResource(conn, wt, "pr", "o/r#1", false); err != nil {
		t.Fatal(err)
	}
	var n int
	conn.QueryRow(`SELECT COUNT(*) FROM worktree_notify`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d rows left after turning off", n)
	}
}

func TestSetResourceRejectsEmptyKey(t *testing.T) {
	conn := testDB(t)
	if err := SetResource(conn, t.TempDir(), "", "", true); err == nil {
		t.Fatal("an empty type/id would collide with the worktree-wide row")
	}
}

func TestSymlinkedPathIsTheSameWorktree(t *testing.T) {
	conn := testDB(t)
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if err := SetAll(conn, link, true); err != nil {
		t.Fatal(err)
	}
	p, _ := Get(conn, real)
	if !p.All {
		t.Fatal("rows must be keyed by wdb.Subscriber, which resolves symlinks")
	}
}

func TestListAllAndRemove(t *testing.T) {
	conn := testDB(t)
	a, b := t.TempDir(), t.TempDir()
	SetAll(conn, a, true)
	SetResource(conn, b, "pr", "o/r#1", true)
	SetResource(conn, b, "pr", "o/r#2", true)

	all, err := ListAll(conn)
	if err != nil {
		t.Fatal(err)
	}
	if !all[wdb.Subscriber(a)].All || len(all[wdb.Subscriber(b)].Resources) != 2 {
		t.Fatalf("ListAll = %+v", all)
	}

	if err := RemoveResource(conn, b, "pr", "o/r#1"); err != nil {
		t.Fatal(err)
	}
	if err := RemoveAll(conn, a); err != nil {
		t.Fatal(err)
	}
	all, _ = ListAll(conn)
	if _, ok := all[wdb.Subscriber(a)]; ok {
		t.Fatal("RemoveAll left rows for a")
	}
	if got := all[wdb.Subscriber(b)].Resources; len(got) != 1 || !got[Key{"pr", "o/r#2"}] {
		t.Fatalf("b after RemoveResource = %+v", got)
	}
}
```

- [ ] **Step 3: Run the tests to make sure they fail**

Run: `go test ./internal/notifyprefs/`
Expected: FAIL (compile errors: undefined `Get`, `SetAll`, …).

- [ ] **Step 4: Implement the package**

`internal/notifyprefs/notifyprefs.go`:

```go
// Package notifyprefs stores which worktrees and resources the user wants
// notifications for. A row means "on"; the row with an empty resource is the
// worktree-wide toggle. Rows are keyed by wdb.Subscriber(path) so they join
// to watcher_subscriptions the same way every other per-worktree table does.
package notifyprefs

import (
	"database/sql"
	"errors"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
)

// Key names one resource.
type Key struct{ Type, ID string }

// Prefs is one worktree's toggles. Resources holds the explicit per-resource
// choices, which are kept while All is on so turning All off restores them.
type Prefs struct {
	All       bool
	Resources map[Key]bool
}

// Notifies is the effective state for k: the worktree-wide toggle covers
// every resource, including ones added after it was turned on.
func (p Prefs) Notifies(k Key) bool { return p.All || p.Resources[k] }

// Get returns path's toggles; a worktree with no rows reads as all off.
func Get(conn *sql.DB, path string) (Prefs, error) {
	all, err := list(conn, `WHERE subscriber = ?`, wdb.Subscriber(path))
	if err != nil {
		return Prefs{}, err
	}
	return all[wdb.Subscriber(path)], nil
}

// ListAll returns every worktree's toggles, keyed by subscriber. Worktrees
// with no rows are absent.
func ListAll(conn *sql.DB) (map[string]Prefs, error) {
	return list(conn, ``)
}

func list(conn *sql.DB, where string, args ...any) (map[string]Prefs, error) {
	rows, err := conn.Query(`SELECT subscriber, resource_type, resource_id FROM worktree_notify `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Prefs{}
	for rows.Next() {
		var sub, typ, id string
		if err := rows.Scan(&sub, &typ, &id); err != nil {
			return nil, err
		}
		p := out[sub]
		if typ == "" && id == "" {
			p.All = true
		} else {
			if p.Resources == nil {
				p.Resources = map[Key]bool{}
			}
			p.Resources[Key{typ, id}] = true
		}
		out[sub] = p
	}
	return out, rows.Err()
}

// SetAll turns the worktree-wide toggle on or off.
func SetAll(conn *sql.DB, path string, on bool) error {
	return set(conn, path, "", "", on)
}

// SetResource turns one resource's toggle on or off.
func SetResource(conn *sql.DB, path, typ, id string, on bool) error {
	if typ == "" || id == "" {
		return errors.New("notifyprefs: resource type and id are required")
	}
	return set(conn, path, typ, id, on)
}

func set(conn *sql.DB, path, typ, id string, on bool) error {
	sub := wdb.Subscriber(path)
	if !on {
		_, err := conn.Exec(
			`DELETE FROM worktree_notify WHERE subscriber = ? AND resource_type = ? AND resource_id = ?`,
			sub, typ, id)
		return err
	}
	_, err := conn.Exec(
		`INSERT INTO worktree_notify (subscriber, resource_type, resource_id, created_at)
		 VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
		sub, typ, id, time.Now().UTC().Format(time.RFC3339))
	return err
}

// RemoveResource deletes one resource's toggle (resources.Remove calls it).
func RemoveResource(conn *sql.DB, path, typ, id string) error {
	return set(conn, path, typ, id, false)
}

// RemoveAll deletes every toggle for the worktree, the worktree-wide one
// included (resources.RemoveAll calls it).
func RemoveAll(conn *sql.DB, path string) error {
	_, err := conn.Exec(`DELETE FROM worktree_notify WHERE subscriber = ?`, wdb.Subscriber(path))
	return err
}
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `go test ./internal/notifyprefs/`
Expected: PASS

- [ ] **Step 6: Write the failing cleanup test in resources**

Append to `internal/resources/resources_test.go`. Add imports `"github.com/mturley/worktree/internal/notifyprefs"` and `"github.com/mturley/worktree/internal/testgit"` if not already present; reuse the file's existing DB-opening helper if there is one, otherwise open with `wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))` as below:

```go
func TestRemoveDropsNotifyPrefs(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wt := testgit.Worktree(t)
	for _, id := range []string{"o/r#1", "o/r#2"} {
		if err := Add(conn, wt, Resource{Type: "pr", ID: id, URL: "u"}); err != nil {
			t.Fatal(err)
		}
		notifyprefs.SetResource(conn, wt, "pr", id, true)
	}
	notifyprefs.SetAll(conn, wt, true)

	if err := Remove(conn, wt, "pr", "o/r#1"); err != nil {
		t.Fatal(err)
	}
	p, _ := notifyprefs.Get(conn, wt)
	if p.Resources[notifyprefs.Key{Type: "pr", ID: "o/r#1"}] {
		t.Fatal("Remove left the removed resource's toggle")
	}
	if !p.All || !p.Resources[notifyprefs.Key{Type: "pr", ID: "o/r#2"}] {
		t.Fatal("Remove touched other toggles")
	}

	if err := RemoveAll(conn, wt); err != nil {
		t.Fatal(err)
	}
	p, _ = notifyprefs.Get(conn, wt)
	if p.All || len(p.Resources) != 0 {
		t.Fatalf("RemoveAll left toggles: %+v", p)
	}
}
```

- [ ] **Step 7: Run it to make sure it fails**

Run: `go test ./internal/resources/ -run TestRemoveDropsNotifyPrefs`
Expected: FAIL with "Remove left the removed resource's toggle".

- [ ] **Step 8: Hook cleanup into Remove / RemoveAll**

In `internal/resources/resources.go` add the import `"github.com/mturley/worktree/internal/notifyprefs"`. In `Remove`, replace the final `_, err := conn.Exec(...)` / `return err` with:

```go
	if _, err := conn.Exec(
		`DELETE FROM worktree_primary WHERE subscriber = ? AND resource_type = ? AND resource_id = ?`,
		sub, resType, id); err != nil {
		return err
	}
	return notifyprefs.RemoveResource(conn, worktreePath, resType, id)
```

In `RemoveAll`, replace the final `_, err = conn.Exec(...)` / `return err` with:

```go
	if _, err := conn.Exec(`DELETE FROM worktree_primary WHERE subscriber = ?`, sub); err != nil {
		return err
	}
	// The toggles go with the subscriptions: nothing could match them now.
	return notifyprefs.RemoveAll(conn, worktreePath)
```

- [ ] **Step 9: Run the package tests**

Run: `go test ./internal/resources/ ./internal/notifyprefs/ ./internal/db/`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add internal/notifyprefs/notifyprefs.go internal/notifyprefs/notifyprefs_test.go internal/db/migrate.go internal/resources/resources.go internal/resources/resources_test.go
git commit --signoff -m "feat(notify): store per-worktree notification toggles" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `cmux.Notify`

**Files:**
- Modify: `internal/cmux/cmux.go` (after `SelectWorkspace`, ~line 160)
- Test: `internal/cmux/cmux_test.go` (create it if it doesn't exist; it is `package cmux`)

**Interfaces:**
- Produces: `cmux.NotifyOptions{Title, Subtitle, Body, Workspace string}` and `cmux.Notify(o NotifyOptions) error`

- [ ] **Step 1: Write the failing tests**

```go
func TestNotifyArgs(t *testing.T) {
	orig := cmuxCmd
	t.Cleanup(func() { cmuxCmd = orig })
	var got []string
	cmuxCmd = func(args ...string) *exec.Cmd { got = args; return exec.Command("true") }

	if err := Notify(NotifyOptions{Title: "T", Subtitle: "S", Body: "B", Workspace: "WS-1"}); err != nil {
		t.Fatal(err)
	}
	want := []string{"notify", "--title", "T", "--subtitle", "S", "--body", "B", "--workspace", "WS-1"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("args = %q, want %q", got, want)
	}

	if err := Notify(NotifyOptions{Title: "T"}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, "|") != "notify|--title|T" {
		t.Fatalf("empty fields must be omitted, got %q", got)
	}
}

func TestNotifyError(t *testing.T) {
	orig := cmuxCmd
	t.Cleanup(func() { cmuxCmd = orig })
	cmuxCmd = func(args ...string) *exec.Cmd { return exec.Command("sh", "-c", "echo boom >&2; exit 1") }
	err := Notify(NotifyOptions{Title: "T"})
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v, want it to carry cmux's output", err)
	}
}
```

(Imports: `os/exec`, `strings`, `testing`.)

- [ ] **Step 2: Run them to make sure they fail**

Run: `go test ./internal/cmux/ -run TestNotify`
Expected: FAIL: undefined `Notify`.

- [ ] **Step 3: Implement**

```go
// NotifyOptions is one `cmux notify` call. Workspace is a workspace ID or
// ref; empty sends it to the caller's own workspace (for `worktree ui`, the
// pane it runs in). Clicking the macOS banner selects that workspace.
type NotifyOptions struct {
	Title, Subtitle, Body, Workspace string
}

// Notify posts a cmux notification, omitting empty fields.
func Notify(o NotifyOptions) error {
	args := []string{"notify", "--title", o.Title}
	if o.Subtitle != "" {
		args = append(args, "--subtitle", o.Subtitle)
	}
	if o.Body != "" {
		args = append(args, "--body", o.Body)
	}
	if o.Workspace != "" {
		args = append(args, "--workspace", o.Workspace)
	}
	if out, err := cmuxCmd(args...).CombinedOutput(); err != nil {
		return fmt.Errorf("cmux notify: %s", strings.TrimSpace(string(out)))
	}
	return nil
}
```

- [ ] **Step 4: Run them to make sure they pass**

Run: `go test ./internal/cmux/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/cmux/cmux.go internal/cmux/cmux_test.go
git commit --signoff -m "feat(cmux): add Notify wrapper for cmux notify" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Event cursor and batch building

**Files:**
- Create: `internal/webui/notify_scan.go`
- Test: `internal/webui/notify_scan_test.go`

**Interfaces:**
- Consumes: `notifyprefs.ListAll`, `notifyprefs.Key`, `registry.List`, `resources.Load`, `(*Server).newResourceDTO` (resources_api.go), `wdb.Subscriber`.
- Produces:
  - `type notifyCursor struct{ ts string; seen map[string]bool }`
  - `func initNotifyCursor(conn *sql.DB) (notifyCursor, error)`
  - `type newEvent struct{ id, ts, title, resType, resID string }`
  - `func readNewEvents(conn *sql.DB, c notifyCursor) ([]newEvent, notifyCursor, error)`
  - `type notifyBatch struct{ WorktreePath, ResourceType, ResourceID, Title, Subtitle, Body, Tag string }`
  - `func (s *Server) notifyBatches(events []newEvent) ([]notifyBatch, error)`
  - `func notifyResourceLabel(d resourceDTO) string`
  - `func notifyTag(path, typ, id string) string`

- [ ] **Step 1: Write the failing tests**

`internal/webui/notify_scan_test.go` reuses `unreadTestDB` from `unread_test.go` (same package). Events are inserted with an explicit type:

```go
package webui

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/mturley/worktree/internal/notifyprefs"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
)

func insertTypedEvent(t *testing.T, conn *sql.DB, id, ts, typ, title, resType, resID string) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO watcher_events (id, ts, source, type, title) VALUES (?, ?, 'github', ?, ?)`,
		id, ts, typ, title); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id) VALUES (?, ?, ?)`,
		id, resType, resID); err != nil {
		t.Fatal(err)
	}
}

func eventIDs(evs []newEvent) []string {
	var out []string
	for _, e := range evs {
		out = append(out, e.id)
	}
	return out
}

func TestCursorStartsAtNewestSoNoBacklog(t *testing.T) {
	conn := unreadTestDB(t)
	insertTypedEvent(t, conn, "old", "2026-01-01T00:00:00Z", "pr_comment", "x", "pr", "o/r#1")
	c, err := initNotifyCursor(conn)
	if err != nil {
		t.Fatal(err)
	}
	evs, _, err := readNewEvents(conn, c)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 0 {
		t.Fatalf("boot must not replay history, got %v", eventIDs(evs))
	}
}

func TestCursorCatchesSameSecondEventsExactlyOnce(t *testing.T) {
	conn := unreadTestDB(t)
	c, _ := initNotifyCursor(conn) // empty DB
	insertTypedEvent(t, conn, "a", "2026-01-01T00:00:05Z", "pr_comment", "x", "pr", "o/r#1")
	evs, c, _ := readNewEvents(conn, c)
	if got := eventIDs(evs); len(got) != 1 || got[0] != "a" {
		t.Fatalf("first pass = %v", got)
	}
	// Written later, in the SAME second the cursor now sits on.
	insertTypedEvent(t, conn, "b", "2026-01-01T00:00:05Z", "pr_comment", "x", "pr", "o/r#1")
	evs, c, _ = readNewEvents(conn, c)
	if got := eventIDs(evs); len(got) != 1 || got[0] != "b" {
		t.Fatalf("second pass = %v, want only b", got)
	}
	evs, _, _ = readNewEvents(conn, c)
	if len(evs) != 0 {
		t.Fatalf("third pass re-read %v", eventIDs(evs))
	}
}

func TestReadNewEventsSkipsNoiseTypes(t *testing.T) {
	conn := unreadTestDB(t)
	c, _ := initNotifyCursor(conn)
	for i, typ := range []string{"watch_started", "watcher_error", "ci_pending", "ci_workflows_pending", "ci_failed"} {
		insertTypedEvent(t, conn, typ, "2026-01-01T00:00:0"+string(rune('1'+i))+"Z", typ, "x", "pr", "o/r#1")
	}
	evs, _, _ := readNewEvents(conn, c)
	if got := eventIDs(evs); len(got) != 1 || got[0] != "ci_failed" {
		t.Fatalf("got %v, want only ci_failed", got)
	}
}

// twoWorktrees tracks the same PR in two worktrees and returns them.
func twoWorktrees(t *testing.T, conn *sql.DB) (string, string) {
	t.Helper()
	a, b := testgit.Worktree(t), testgit.Worktree(t)
	for _, wt := range []string{a, b} {
		if err := registry.Register(conn, registry.Entry{Path: wt, Repo: "r", RepoRoot: "/r", Branch: filepath.Base(wt), CreatedAt: "now"}); err != nil {
			t.Fatal(err)
		}
		if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#7", URL: "https://github.com/o/r/pull/7"}); err != nil {
			t.Fatal(err)
		}
	}
	return a, b
}

func TestBatchesOnlyForNotifyingWorktree(t *testing.T) {
	conn := unreadTestDB(t)
	a, _ := twoWorktrees(t, conn)
	notifyprefs.SetResource(conn, a, "pr", "o/r#7", true)
	s := &Server{DB: conn}
	evs := []newEvent{
		{id: "e1", ts: "1", title: "first", resType: "pr", resID: "o/r#7"},
		{id: "e2", ts: "2", title: "newest", resType: "pr", resID: "o/r#7"},
		{id: "e3", ts: "2", title: "untracked", resType: "pr", resID: "o/r#99"},
	}
	got, err := s.notifyBatches(evs)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d batches, want 1 (only a notifies; #99 is tracked nowhere): %+v", len(got), got)
	}
	b := got[0]
	if b.WorktreePath != a || b.ResourceID != "o/r#7" {
		t.Fatalf("batch for wrong target: %+v", b)
	}
	if b.Title != "PR #7" || b.Subtitle != filepath.Base(a) || b.Body != "newest (+1 more)" {
		t.Fatalf("text = %q / %q / %q", b.Title, b.Subtitle, b.Body)
	}
	if b.Tag != notifyTag(a, "pr", "o/r#7") {
		t.Fatalf("tag = %q", b.Tag)
	}
}

func TestWorktreeWideToggleCoversEveryTrackedResource(t *testing.T) {
	conn := unreadTestDB(t)
	_, b := twoWorktrees(t, conn)
	notifyprefs.SetAll(conn, b, true)
	s := &Server{DB: conn}
	got, _ := s.notifyBatches([]newEvent{{id: "e1", ts: "1", title: "hi", resType: "pr", resID: "o/r#7"}})
	if len(got) != 1 || got[0].WorktreePath != b || got[0].Body != "hi" {
		t.Fatalf("got %+v", got)
	}
}

func TestNotifyResourceLabel(t *testing.T) {
	cases := []struct {
		d    resourceDTO
		want string
	}{
		{resourceDTO{Type: "pr", ID: "o/r#12", Title: "Fix foo"}, "PR #12: Fix foo"},
		{resourceDTO{Type: "pr", ID: "o/r#12", Title: "Fix foo", CustomName: "Mine"}, "PR #12: Mine"},
		{resourceDTO{Type: "jira", ID: "X-1", Title: "Bug"}, "X-1: Bug"},
		{resourceDTO{Type: "jira", ID: "X-1"}, "X-1"},
		{resourceDTO{Type: "slack", ID: "C1:1.2", ChannelName: "dev"}, "Thread in #dev"},
		{resourceDTO{Type: "slack", ID: "C1:1.2", CustomName: "Rollout"}, "Slack thread: Rollout"},
	}
	for _, c := range cases {
		if got := notifyResourceLabel(c.d); got != c.want {
			t.Errorf("%+v -> %q, want %q", c.d, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `go test ./internal/webui/ -run 'Cursor|ReadNewEvents|Batches|WorktreeWideToggle|NotifyResourceLabel'`
Expected: FAIL (undefined identifiers).

- [ ] **Step 3: Implement `notify_scan.go`**

```go
package webui

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/notifyprefs"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

// notifySkipTypes never notify: the two the unread/timeline filter already
// drops, plus CI's "pending" churn, which says nothing worth interrupting for.
var notifySkipTypes = []string{"watch_started", "watcher_error", "ci_pending", "ci_workflows_pending"}

// notifyCursor is how far the notifier has read. watcher_events.ts has
// one-second resolution, so a ts alone would miss an event written later in
// the same second it last read; seen holds the IDs already handled AT ts.
type notifyCursor struct {
	ts   string
	seen map[string]bool
}

// initNotifyCursor starts at the newest event, so a restart never replays a
// backlog as a burst of notifications.
func initNotifyCursor(conn *sql.DB) (notifyCursor, error) {
	c := notifyCursor{seen: map[string]bool{}}
	if err := conn.QueryRow(`SELECT COALESCE(MAX(ts),'') FROM watcher_events`).Scan(&c.ts); err != nil {
		return c, err
	}
	rows, err := conn.Query(`SELECT id FROM watcher_events WHERE ts = ?`, c.ts)
	if err != nil {
		return c, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return c, err
		}
		c.seen[id] = true
	}
	return c, rows.Err()
}

// newEvent is one (event, resource) pair past the cursor.
type newEvent struct{ id, ts, title, resType, resID string }

// readNewEvents returns the notify-worthy events past c, oldest first, and
// the advanced cursor. The cursor advances whatever the caller then does with
// the events: delivery is fire-and-forget, never retried.
func readNewEvents(conn *sql.DB, c notifyCursor) ([]newEvent, notifyCursor, error) {
	q := `SELECT e.id, e.ts, e.title, er.resource_type, er.resource_id
	      FROM watcher_events e JOIN watcher_event_resources er ON er.event_id = e.id
	      WHERE e.ts >= ? AND e.type NOT IN (?` + strings.Repeat(",?", len(notifySkipTypes)-1) + `)
	      ORDER BY e.ts, e.id`
	args := []any{c.ts}
	for _, t := range notifySkipTypes {
		args = append(args, t)
	}
	rows, err := conn.Query(q, args...)
	if err != nil {
		return nil, c, err
	}
	defer rows.Close()
	next := notifyCursor{ts: c.ts, seen: map[string]bool{}}
	for id := range c.seen {
		next.seen[id] = true
	}
	var out []newEvent
	for rows.Next() {
		var e newEvent
		if err := rows.Scan(&e.id, &e.ts, &e.title, &e.resType, &e.resID); err != nil {
			return nil, c, err
		}
		if e.ts > next.ts {
			next.ts, next.seen = e.ts, map[string]bool{}
		}
		if e.ts == c.ts && c.seen[e.id] {
			continue
		}
		next.seen[e.id] = true
		out = append(out, e)
	}
	return out, next, rows.Err()
}

// notifyBatch is one notification: every new event for one resource in one
// worktree since the last pass.
type notifyBatch struct {
	WorktreePath string
	ResourceType string // empty for a worktree-wide test notification
	ResourceID   string
	Title        string
	Subtitle     string
	Body         string
	Tag          string
}

// notifyTag identifies a notification's target, so a browser replaces rather
// than stacks a duplicate that slips through a fallback race.
func notifyTag(path, typ, id string) string {
	if typ == "" {
		return "worktree:" + path + "|all"
	}
	return "worktree:" + path + "|" + typ + ":" + id
}

// notifyResourceLabel names a resource the way its card does: its key, then
// the user's custom name or the fetched title.
func notifyResourceLabel(d resourceDTO) string {
	key := d.ID
	switch d.Type {
	case "pr":
		if i := strings.LastIndex(d.ID, "#"); i >= 0 {
			key = "PR " + d.ID[i:]
		}
	case "slack":
		key = "Slack thread"
		if d.ChannelName != "" {
			key = "Thread in #" + d.ChannelName
		}
	}
	name := d.CustomName
	if name == "" {
		name = d.Title
	}
	if name == "" {
		return key
	}
	return key + ": " + name
}

// notifyBatches matches events to worktrees with notifications on, one batch
// per (worktree, resource). Only resources the worktree actively tracks
// match, so stale toggles and untracked resources never notify.
func (s *Server) notifyBatches(events []newEvent) ([]notifyBatch, error) {
	if len(events) == 0 {
		return nil, nil
	}
	prefs, err := notifyprefs.ListAll(s.DB)
	if err != nil || len(prefs) == 0 {
		return nil, err
	}
	entries, err := registry.List(s.DB)
	if err != nil {
		return nil, err
	}
	var out []notifyBatch
	for _, e := range entries {
		p, ok := prefs[wdb.Subscriber(e.Path)]
		if !ok {
			continue
		}
		rs, err := resources.Load(s.DB, e.Path)
		if err != nil {
			s.logger().Printf("notify: resources.Load(%s): %v", e.Path, err)
			continue
		}
		tracked := make(map[notifyprefs.Key]resources.Resource, len(rs))
		for _, r := range rs {
			tracked[notifyprefs.Key{Type: r.Type, ID: r.ID}] = r
		}
		type agg struct {
			count  int
			newest string
		}
		groups := map[notifyprefs.Key]*agg{}
		var order []notifyprefs.Key
		for _, ev := range events { // oldest first, so the last one wins newest
			k := notifyprefs.Key{Type: ev.resType, ID: ev.resID}
			if _, ok := tracked[k]; !ok || !p.Notifies(k) {
				continue
			}
			g := groups[k]
			if g == nil {
				g = &agg{}
				groups[k] = g
				order = append(order, k)
			}
			g.count++
			g.newest = ev.title
		}
		for _, k := range order {
			g := groups[k]
			body := g.newest
			if g.count > 1 {
				body = fmt.Sprintf("%s (+%d more)", g.newest, g.count-1)
			}
			out = append(out, notifyBatch{
				WorktreePath: e.Path,
				ResourceType: k.Type,
				ResourceID:   k.ID,
				Title:        notifyResourceLabel(s.newResourceDTO(tracked[k])),
				Subtitle:     filepath.Base(e.Path),
				Body:         body,
				Tag:          notifyTag(e.Path, k.Type, k.ID),
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].WorktreePath < out[j].WorktreePath })
	return out, nil
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `go test ./internal/webui/ -run 'Cursor|ReadNewEvents|Batches|WorktreeWideToggle|NotifyResourceLabel'`
Expected: PASS. (`resources.Add` needs a real linked worktree, which is why the tests use `testgit.Worktree`.)

- [ ] **Step 5: Commit**

```bash
git add internal/webui/notify_scan.go internal/webui/notify_scan_test.go
git commit --signoff -m "feat(notify): turn new watcher events into per-resource batches" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Tab registry, browser transport, stream + presence/ack routes

**Files:**
- Create: `internal/webui/tabs.go`
- Test: `internal/webui/tabs_test.go`
- Modify: `internal/webui/stream.go`
- Modify: `internal/webui/server.go` (fields; routes)

**Interfaces:**
- Consumes: `notifyBatch`, `currentSession` (auth.go), `wdb.Subscriber`.
- Produces:
  - `type deliverOpts struct{ PreferTab, OnlySession string }`
  - `type notifyTransport interface{ Deliver(b notifyBatch, o deliverOpts) }`
  - `type notificationMsg struct` (JSON: `id, title, subtitle, body, worktree_path, resource_type, resource_id, tag`)
  - `type tabRegistry`, with `newTabRegistry()`, `register(id, session, route string, visible bool) (send <-chan notificationMsg, done func())`, `update(id, session, route string, visible bool) bool`, `ack(id, session, notificationID string, shown bool) bool`, `candidates(path, session, prefer string) []string`, `deliverToSession(b notifyBatch, session, prefer string) bool`, and `Deliver(b notifyBatch, o deliverOpts)` (satisfies `notifyTransport`)
  - `(*Server).tabRegistry() *tabRegistry` (lazy)
  - routes `POST /api/tabs/presence`, `POST /api/tabs/ack`

- [ ] **Step 1: Write the failing tests**

`internal/webui/tabs_test.go`:

```go
package webui

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/uisession"
)

func batchFor(path string) notifyBatch {
	return notifyBatch{WorktreePath: path, ResourceType: "pr", ResourceID: "o/r#1", Title: "t", Tag: notifyTag(path, "pr", "o/r#1")}
}

func TestCandidateOrder(t *testing.T) {
	wt := t.TempDir()
	r := newTabRegistry()
	r.register("other", "s1", "/worktree/%2Felsewhere", true)
	r.register("home-hidden", "s1", "/", false)
	r.register("home-visible", "s1", "/", true)
	r.register("detail", "s1", "/worktree/"+urlPathEscape(wt), false)
	r.register("phone", "s2", "/worktree/"+urlPathEscape(wt), true)

	got := r.candidates(wt, "s1", "")
	want := []string{"detail", "home-visible", "home-hidden", "other"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	if p := r.candidates(wt, "s1", "other"); p[0] != "other" {
		t.Fatalf("a preferred tab goes first, got %v", p)
	}
}

// answer acks every message arriving on send with shown.
func answer(r *tabRegistry, tab, session string, send <-chan notificationMsg, shown bool) {
	go func() {
		for m := range send {
			r.ack(tab, session, m.ID, shown)
		}
	}()
}

func TestDeliverFallsThroughDeclineAndTimeout(t *testing.T) {
	wt := t.TempDir()
	r := newTabRegistry()
	r.ackTimeout = 30 * time.Millisecond
	detailSend, _ := r.register("detail", "s1", "/worktree/"+urlPathEscape(wt), true)
	frozenSend, _ := r.register("frozen", "s1", "/", true)
	okSend, _ := r.register("ok", "s1", "/x", true)
	answer(r, "detail", "s1", detailSend, false) // no permission
	_ = frozenSend                                 // never answers
	got := make(chan notificationMsg, 1)
	go func() {
		m := <-okSend
		got <- m
		r.ack("ok", "s1", m.ID, true)
	}()

	if !r.deliverToSession(batchFor(wt), "s1", "") {
		t.Fatal("delivery should succeed on the third candidate")
	}
	if m := <-got; m.Tag != notifyTag(wt, "pr", "o/r#1") || m.WorktreePath != wt {
		t.Fatalf("message = %+v", m)
	}
}

func TestDeliverDropsWhenNobodyShows(t *testing.T) {
	r := newTabRegistry()
	r.ackTimeout = 20 * time.Millisecond
	send, _ := r.register("a", "s1", "/", true)
	answer(r, "a", "s1", send, false)
	if r.deliverToSession(batchFor(t.TempDir()), "s1", "") {
		t.Fatal("no tab showed it")
	}
}

func TestReconnectKeepsNewRegistration(t *testing.T) {
	r := newTabRegistry()
	_, doneOld := r.register("a", "s1", "/", true)
	newSend, _ := r.register("a", "s1", "/", true) // reconnect, same tab id
	doneOld()                                     // the old stream's deferred cleanup runs late
	if len(r.candidates(t.TempDir(), "s1", "")) != 1 {
		t.Fatal("the old connection's cleanup removed the new registration")
	}
	answer(r, "a", "s1", newSend, true)
	if !r.deliverToSession(batchFor(t.TempDir()), "s1", "") {
		t.Fatal("delivery must use the new connection")
	}
}

func TestPresenceAndAckRefuseOtherSessions(t *testing.T) {
	s := &Server{}
	s.tabRegistry().register("a", "s1", "/", true)
	post := func(path, body, session string) int {
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
		req = req.WithContext(context.WithValue(req.Context(), sessionContextKey{}, uisession.Session{Handle: session}))
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, withJSON(req))
		return rec.Code
	}
	if c := post("/api/tabs/presence", `{"tab":"a","route":"/x","visible":false}`, "s2"); c != http.StatusNotFound {
		t.Fatalf("presence from another session: %d, want 404", c)
	}
	if c := post("/api/tabs/ack", `{"tab":"a","notification_id":"n","shown":true}`, "s2"); c != http.StatusNotFound {
		t.Fatalf("ack from another session: %d, want 404", c)
	}
	if c := post("/api/tabs/presence", `{"tab":"a","route":"/x","visible":false}`, "s1"); c != http.StatusNoContent {
		t.Fatalf("own presence: %d, want 204", c)
	}
}

func withJSON(r *http.Request) *http.Request {
	r.Header.Set("Content-Type", "application/json")
	return r
}
```

> `s.Handler()` with a nil `Security` skips the session guard (see `server.go`), so the context value set above is what `currentSession` reads.

- [ ] **Step 2: Run them to make sure they fail**

Run: `go test ./internal/webui/ -run 'CandidateOrder|Deliver|Reconnect|PresenceAndAck'`
Expected: FAIL (undefined identifiers).

- [ ] **Step 3: Implement `tabs.go`**

```go
package webui

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
)

// deliverOpts narrows a delivery. Both fields are for the browser path only:
// a test notification goes to the session that asked for it, starting with
// the tab that asked.
type deliverOpts struct {
	PreferTab   string
	OnlySession string
}

// notifyTransport is the server's single delivery path: cmux or browser tabs.
type notifyTransport interface {
	Deliver(b notifyBatch, o deliverOpts)
}

// notificationMsg is the `notification` SSE payload.
type notificationMsg struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Subtitle     string `json:"subtitle"`
	Body         string `json:"body"`
	WorktreePath string `json:"worktree_path"`
	ResourceType string `json:"resource_type"`
	ResourceID   string `json:"resource_id"`
	Tag          string `json:"tag"`
}

type tabEntry struct {
	session    string
	route      string
	visible    bool
	lastActive time.Time
	send       chan notificationMsg
}

// tabRegistry knows every open tab's stream, session, route and visibility,
// so a browser notification can come out of exactly one tab per session.
type tabRegistry struct {
	mu         sync.Mutex
	tabs       map[string]*tabEntry
	acks       map[string]chan bool
	ackTimeout time.Duration
	now        func() time.Time
}

func newTabRegistry() *tabRegistry {
	return &tabRegistry{
		tabs:       map[string]*tabEntry{},
		acks:       map[string]chan bool{},
		ackTimeout: 5 * time.Second,
		now:        time.Now,
	}
}

func (s *Server) tabRegistry() *tabRegistry {
	s.tabsOnce.Do(func() { s.tabs = newTabRegistry() })
	return s.tabs
}

// register adds or replaces tab id. done removes it only if it is still this
// registration: a reconnecting tab registers again before the old stream's
// handler returns, and that late cleanup must not remove the new one.
func (r *tabRegistry) register(id, session, route string, visible bool) (<-chan notificationMsg, func()) {
	e := &tabEntry{session: session, route: route, visible: visible, lastActive: r.now(), send: make(chan notificationMsg, 4)}
	r.mu.Lock()
	r.tabs[id] = e
	r.mu.Unlock()
	return e.send, func() {
		r.mu.Lock()
		if r.tabs[id] == e {
			delete(r.tabs, id)
		}
		r.mu.Unlock()
	}
}

// update records a presence report. False when the tab is unknown or belongs
// to another session, which the handler reports as 404.
func (r *tabRegistry) update(id, session, route string, visible bool) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.tabs[id]
	if e == nil || e.session != session {
		return false
	}
	e.route, e.visible = route, visible
	if visible {
		e.lastActive = r.now()
	}
	return true
}

// ack resolves a pending notification; false for an unknown tab, another
// session's tab, or a notification nobody is waiting on any more.
func (r *tabRegistry) ack(id, session, notificationID string, shown bool) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e := r.tabs[id]; e == nil || e.session != session {
		return false
	}
	ch := r.acks[notificationID]
	if ch == nil {
		return false
	}
	delete(r.acks, notificationID)
	ch <- shown // buffered 1
	return true
}

// routeWorktree extracts the worktree path from a /worktree/<escaped> route.
func routeWorktree(route string) (string, bool) {
	rest, ok := strings.CutPrefix(route, "/worktree/")
	if !ok || rest == "" {
		return "", false
	}
	p, err := url.PathUnescape(rest)
	return p, err == nil
}

func urlPathEscape(p string) string { return url.PathEscape(p) }

// candidates orders session's tabs for a notification about path: the
// preferred tab, then tabs on that worktree's page, then the home page, then
// the rest; visible before hidden, then most recently active.
func (r *tabRegistry) candidates(path, session, prefer string) []string {
	want := wdb.Subscriber(path)
	rank := func(id string, e *tabEntry) int {
		if id == prefer {
			return 0
		}
		if wt, ok := routeWorktree(e.route); ok && wdb.Subscriber(wt) == want {
			return 1
		}
		if e.route == "/" {
			return 2
		}
		return 3
	}
	type cand struct {
		id      string
		rank    int
		visible bool
		active  time.Time
	}
	r.mu.Lock()
	var cs []cand
	for id, e := range r.tabs {
		if e.session == session {
			cs = append(cs, cand{id, rank(id, e), e.visible, e.lastActive})
		}
	}
	r.mu.Unlock()
	sort.Slice(cs, func(i, j int) bool {
		a, b := cs[i], cs[j]
		if a.rank != b.rank {
			return a.rank < b.rank
		}
		if a.visible != b.visible {
			return a.visible
		}
		return a.active.After(b.active)
	})
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.id
	}
	return out
}

func newNotificationID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// deliverToSession offers b to session's tabs in candidate order until one
// shows it. A negative ack moves on at once; silence moves on after
// ackTimeout, which covers a tab the browser has frozen with its stream
// still open. Each offer has its own ID, so a late ack from an earlier tab
// can never be mistaken for the current one.
func (r *tabRegistry) deliverToSession(b notifyBatch, session, prefer string) bool {
	for _, id := range r.candidates(b.WorktreePath, session, prefer) {
		r.mu.Lock()
		e := r.tabs[id]
		r.mu.Unlock()
		if e == nil {
			continue
		}
		msg := notificationMsg{ID: newNotificationID(), Title: b.Title, Subtitle: b.Subtitle, Body: b.Body,
			WorktreePath: b.WorktreePath, ResourceType: b.ResourceType, ResourceID: b.ResourceID, Tag: b.Tag}
		ch := make(chan bool, 1)
		r.mu.Lock()
		r.acks[msg.ID] = ch
		r.mu.Unlock()
		select {
		case e.send <- msg:
		default: // stream backed up: treat as a decline
			r.mu.Lock()
			delete(r.acks, msg.ID)
			r.mu.Unlock()
			continue
		}
		shown := false
		select {
		case shown = <-ch:
		case <-time.After(r.ackTimeout):
		}
		r.mu.Lock()
		delete(r.acks, msg.ID)
		r.mu.Unlock()
		if shown {
			return true
		}
	}
	return false
}

// Deliver offers b once per session with an open tab (or only o.OnlySession),
// each in its own goroutine so a slow session never delays another.
func (r *tabRegistry) Deliver(b notifyBatch, o deliverOpts) {
	r.mu.Lock()
	sessions := map[string]bool{}
	for _, e := range r.tabs {
		if o.OnlySession == "" || e.session == o.OnlySession {
			sessions[e.session] = true
		}
	}
	r.mu.Unlock()
	for sess := range sessions {
		go r.deliverToSession(b, sess, o.PreferTab)
	}
}

type tabPresenceRequest struct {
	Tab     string `json:"tab"`
	Route   string `json:"route"`
	Visible bool   `json:"visible"`
}

// handleTabPresence: POST /api/tabs/presence
func (s *Server) handleTabPresence(w http.ResponseWriter, r *http.Request) {
	var req tabPresenceRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil || req.Tab == "" {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	sess, _ := currentSession(r)
	if !s.tabRegistry().update(req.Tab, sess.Handle, req.Route, req.Visible) {
		writeError(w, http.StatusNotFound, "unknown tab")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type tabAckRequest struct {
	Tab            string `json:"tab"`
	NotificationID string `json:"notification_id"`
	Shown          bool   `json:"shown"`
}

// handleTabAck: POST /api/tabs/ack
func (s *Server) handleTabAck(w http.ResponseWriter, r *http.Request) {
	var req tabAckRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil || req.Tab == "" {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	sess, _ := currentSession(r)
	if !s.tabRegistry().ack(req.Tab, sess.Handle, req.NotificationID, req.Shown) {
		writeError(w, http.StatusNotFound, "unknown tab or notification")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

In `server.go`, add to the `Server` struct (after the `cmuxSetDescription` seam):

```go
	// tabs is the browser notification registry; see tabs.go. Lazily built
	// by tabRegistry(), since Server is a bare struct literal everywhere.
	tabsOnce sync.Once
	tabs     *tabRegistry
```

Then add to `routes()`, after `{"GET /api/stream", s.handleStream},`:

```go
		{"POST /api/tabs/presence", s.handleTabPresence},
		{"POST /api/tabs/ack", s.handleTabAck},
```

- [ ] **Step 4: Register tabs on the stream**

In `stream.go` add `"encoding/json"` to the imports. After `flusher.Flush()` (the first one), insert:

```go
	// A tab that names itself can be chosen to show a browser notification.
	// Its initial route and visibility ride on the URL, because a presence
	// POST racing this registration would be refused as an unknown tab.
	var notifications <-chan notificationMsg
	if tab := r.URL.Query().Get("tab"); tab != "" {
		sess, _ := currentSession(r)
		send, done := s.tabRegistry().register(tab, sess.Handle, r.URL.Query().Get("route"), r.URL.Query().Get("visible") == "1")
		defer done()
		notifications = send
	}
```

Add a case to the `select` (a nil channel never fires, so streams without `tab` are unchanged):

```go
		case msg := <-notifications:
			b, _ := json.Marshal(msg)
			fmt.Fprintf(w, "event: notification\ndata: %s\n\n", b)
			flusher.Flush()
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `go test ./internal/webui/`
Expected: PASS, including `TestEveryAPIRouteRequiresASession`, which now covers the two new routes.

- [ ] **Step 6: Commit**

```bash
git add internal/webui/tabs.go internal/webui/tabs_test.go internal/webui/stream.go internal/webui/server.go
git commit --signoff -m "feat(notify): pick one browser tab per session for each notification" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Delivery mode, cmux transport, notifier loop, wiring

**Files:**
- Create: `internal/webui/notifier.go`
- Test: `internal/webui/notifier_test.go`
- Modify: `internal/webui/server.go` (fields)
- Modify: `internal/webui/auth.go` (`sessionDTO`, `handleSession`)
- Modify: `cmd/ui.go` (~line 154, after `StartPolling`)

**Interfaces:**
- Consumes: `notifyTransport`, `deliverOpts`, `tabRegistry`, `initNotifyCursor`, `readNewEvents`, `notifyBatches`, `cmux.Notify`, `cmux.Match`, `s.cmuxList` (existing seam).
- Produces:
  - `(*Server).notifyMode() string` (`"cmux"` | `"browser"`)
  - `(*Server).deliver(b notifyBatch, o deliverOpts)`
  - `(*Server).notifyPass(c *notifyCursor)`
  - `(*Server).StartNotifier(interval time.Duration) (stop func())`
  - seams `cmuxAvailable func() bool` and `cmuxNotify func(cmux.NotifyOptions) error`
  - `sessionDTO.NotifyMode` (`json:"notify_mode,omitempty"`)

- [ ] **Step 1: Write the failing tests**

`internal/webui/notifier_test.go`:

```go
package webui

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/notifyprefs"
)

type fakeTransport struct{ got []notifyBatch }

func (f *fakeTransport) Deliver(b notifyBatch, _ deliverOpts) { f.got = append(f.got, b) }

func TestNotifyModeFollowsCmuxAvailability(t *testing.T) {
	on := &Server{cmuxAvailable: func() bool { return true }}
	off := &Server{cmuxAvailable: func() bool { return false }}
	if on.notifyMode() != "cmux" || off.notifyMode() != "browser" {
		t.Fatalf("modes = %q, %q", on.notifyMode(), off.notifyMode())
	}
}

func TestCmuxTransportTargetsWorkspace(t *testing.T) {
	wt := t.TempDir()
	var calls []cmux.NotifyOptions
	s := &Server{
		cmuxAvailable: func() bool { return true },
		cmuxList:      func() ([]cmux.Workspace, error) { return []cmux.Workspace{{ID: "WS-UUID", Ref: "workspace:3", CurrentDirectory: wt}}, nil },
		cmuxNotify:    func(o cmux.NotifyOptions) error { calls = append(calls, o); return nil },
	}
	s.deliver(notifyBatch{WorktreePath: wt, Title: "T", Subtitle: "S", Body: "B"}, deliverOpts{})
	if len(calls) != 1 || calls[0] != (cmux.NotifyOptions{Title: "T", Subtitle: "S", Body: "B", Workspace: "WS-UUID"}) {
		t.Fatalf("calls = %+v", calls)
	}
}

func TestCmuxTransportWithoutWorkspaceIsUntargeted(t *testing.T) {
	var calls []cmux.NotifyOptions
	s := &Server{
		cmuxAvailable: func() bool { return true },
		cmuxList:      func() ([]cmux.Workspace, error) { return nil, nil },
		cmuxNotify:    func(o cmux.NotifyOptions) error { calls = append(calls, o); return errors.New("boom") },
	}
	s.deliver(notifyBatch{WorktreePath: t.TempDir(), Title: "T"}, deliverOpts{})
	if len(calls) != 1 || calls[0].Workspace != "" {
		t.Fatalf("calls = %+v (a failure must be logged, not retried)", calls)
	}
}

func TestNotifyPassAdvancesEvenWhenDeliveryFails(t *testing.T) {
	conn := unreadTestDB(t)
	a, _ := twoWorktrees(t, conn)
	notifyprefs.SetAll(conn, a, true)
	ft := &fakeTransport{}
	s := &Server{DB: conn, transport: ft}
	s.notifyOnce.Do(func() {}) // pin the fake transport
	c, _ := initNotifyCursor(conn)
	insertTypedEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "pr_comment", "hello", "pr", "o/r#7")
	s.notifyPass(&c)
	s.notifyPass(&c)
	if len(ft.got) != 1 || ft.got[0].Body != "hello" {
		t.Fatalf("delivered %+v, want exactly one batch", ft.got)
	}
}

func TestSessionReportsNotifyMode(t *testing.T) {
	srv, store, _ := securedServer(t)
	srv.cmuxAvailable = func() bool { return true }
	token, _, err := store.Create("test")
	if err != nil {
		t.Fatal(err)
	}
	rec := serve(srv.Handler(), apiRequest("GET", "/api/session", "", &http.Cookie{Name: sessionCookieName, Value: token}))
	if rec.Code != http.StatusOK || !contains(rec.Body.String(), `"notify_mode":"cmux"`) {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	_ = httptest.NewRecorder
}

func contains(s, sub string) bool { return len(s) >= len(sub) && (s == sub || indexOf(s, sub) >= 0) }

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
```

> Simplify `contains` to `strings.Contains` (import `strings`) and drop `indexOf` and the stray `httptest` line. They are only here so the snippet compiles without knowing which imports the file already has. `securedServer`, `serve` and `apiRequest` are existing helpers in `auth_test.go`. If `securedServer` returns a Server value rather than a pointer, set the seam on whatever it returns before calling `Handler()`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `go test ./internal/webui/ -run 'NotifyMode|CmuxTransport|NotifyPass|SessionReportsNotifyMode'`
Expected: FAIL (undefined `notifyMode`, `cmuxAvailable`, …).

- [ ] **Step 3: Implement `notifier.go`**

```go
package webui

import (
	"sync"
	"time"

	"github.com/mturley/worktree/internal/cmux"
)

const (
	notifyModeCmux    = "cmux"
	notifyModeBrowser = "browser"
)

// notifyMode picks the delivery path once per process: cmux when the server
// can reach it (IsAvailable, not InPane: the server drives cmux from wherever
// it runs), else browser tabs. The two never both fire.
func (s *Server) notifyMode() string {
	s.notifyOnce.Do(func() {
		avail := cmux.IsAvailable
		if s.cmuxAvailable != nil {
			avail = s.cmuxAvailable
		}
		if avail() {
			s.notifyModeName, s.transport = notifyModeCmux, &cmuxTransport{s: s}
		} else {
			s.notifyModeName, s.transport = notifyModeBrowser, s.tabRegistry()
		}
	})
	if s.notifyModeName == "" { // transport pinned by a test
		return notifyModeBrowser
	}
	return s.notifyModeName
}

// deliver sends b through the active transport.
func (s *Server) deliver(b notifyBatch, o deliverOpts) {
	s.notifyMode()
	s.transport.Deliver(b, o)
}

// cmuxTransport posts `cmux notify` targeted at the worktree's workspace, so
// clicking the banner switches to it. With no matching workspace it posts
// untargeted (landing on the UI server's own workspace) rather than dropping
// the notification; the subtitle still names the worktree. A failure is
// logged and dropped: retrying a broken cmux would only stack up banners.
type cmuxTransport struct{ s *Server }

func (t *cmuxTransport) Deliver(b notifyBatch, _ deliverOpts) {
	s := t.s
	list := cmux.ListWorkspaces
	if s.cmuxList != nil {
		list = s.cmuxList
	}
	notify := cmux.Notify
	if s.cmuxNotify != nil {
		notify = s.cmuxNotify
	}
	target := ""
	if ws, err := list(); err != nil {
		s.logger().Printf("notify: listing cmux workspaces: %v", err)
	} else if hits := cmux.Match(ws, []string{b.WorktreePath})[b.WorktreePath]; len(hits) > 0 {
		target = hits[0].ID
		if target == "" {
			target = hits[0].Ref
		}
	}
	if err := notify(cmux.NotifyOptions{Title: b.Title, Subtitle: b.Subtitle, Body: b.Body, Workspace: target}); err != nil {
		s.logger().Printf("notify: %v", err)
	}
}

// notifyPass reads past the cursor and delivers one notification per
// (worktree, resource). The cursor advances whether or not delivery works.
func (s *Server) notifyPass(c *notifyCursor) {
	events, next, err := readNewEvents(s.DB, *c)
	if err != nil {
		s.logger().Printf("notify: reading events: %v", err)
		return
	}
	*c = next
	batches, err := s.notifyBatches(events)
	if err != nil {
		s.logger().Printf("notify: matching events: %v", err)
		return
	}
	for _, b := range batches {
		s.deliver(b, deliverOpts{})
	}
}

// StartNotifier runs notifyPass every interval until stop is called. It
// keeps its own cursor rather than hooking the pollers: they write straight
// to the DB, and on-demand polls (handlePollWorktree) write too.
func (s *Server) StartNotifier(interval time.Duration) (stop func()) {
	c, err := initNotifyCursor(s.DB)
	if err != nil {
		s.logger().Printf("notify: starting cursor: %v", err)
	}
	s.logger().Printf("notifications: %s mode", s.notifyMode())
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				s.notifyPass(&c)
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(done) }) }
}
```

In `server.go`, add to the `Server` struct next to the `tabs` fields:

```go
	// Notification delivery; see notifier.go. notifyOnce picks the mode.
	notifyOnce     sync.Once
	notifyModeName string
	transport      notifyTransport
	// Seams: cmux availability and `cmux notify`, for tests.
	cmuxAvailable func() bool
	cmuxNotify    func(cmux.NotifyOptions) error
```

In `auth.go`: add `NotifyMode string \`json:"notify_mode,omitempty"\`` to `sessionDTO`. In `handleSession`, replace the `writeJSON` line with:

```go
	dto := tosessionDTO(sess, true)
	// The server's notification delivery path, so the UI knows whether to
	// ask this browser for notification permission at all.
	dto.NotifyMode = s.notifyMode()
	writeJSON(w, http.StatusOK, dto)
```

In `cmd/ui.go`, after `defer stop()`:

```go
	// Notifications for resources the user toggled on; cmux or browser mode
	// is chosen inside (see internal/webui/notifier.go).
	stopNotify := srv.StartNotifier(5 * time.Second)
	defer stopNotify()
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `go test ./internal/webui/ && go build ./...`
Expected: PASS, and it builds.

- [ ] **Step 5: Commit**

```bash
git add internal/webui/notifier.go internal/webui/notifier_test.go internal/webui/server.go internal/webui/auth.go cmd/ui.go
git commit --signoff -m "feat(notify): deliver via cmux notify or browser tabs on a 5s loop" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `POST /api/notify`, test notification, DTO fields

**Files:**
- Create: `internal/webui/notify_api.go`
- Test: `internal/webui/notify_api_test.go`
- Modify: `internal/webui/server.go` (route)
- Modify: `internal/webui/worktrees.go` (`worktreeSummary.NotifyAll`, fill)
- Modify: `internal/webui/resources_api.go` (`resourceDTO.Notify`, fill in `handleWorktreeResources`)

**Interfaces:**
- Consumes: `notifyprefs.*`, `registry.Get`, `resources.Load`, `(*Server).deliver`, `notifyResourceLabel`, `notifyTag`, `currentSession`.
- Produces:
  - `POST /api/notify` with body `{path, type?, id?, on, tab?}`; response `{"ok":true,"mode":"cmux"|"browser"}`. 400 on a bad body, a missing path, a half-specified resource, or a link resource; 404 for an unregistered worktree or an untracked resource.
  - JSON `notify_all` on `/api/worktrees` rows; `notify` (omitempty) on resource DTOs from `/api/worktrees` focus resources and `/api/worktree-resources`.

- [ ] **Step 1: Write the failing tests**

`internal/webui/notify_api_test.go`:

```go
package webui

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"

	"github.com/mturley/worktree/internal/notifyprefs"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
	"github.com/mturley/worktree/internal/uisession"
)

func notifyAPIServer(t *testing.T) (*Server, string, *fakeTransport) {
	t.Helper()
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	registry.Register(conn, registry.Entry{Path: wt, Repo: "r", RepoRoot: "/r", Branch: "b", CreatedAt: "now"})
	resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#3", URL: "u"})
	resources.Add(conn, wt, resources.Resource{Type: "link", ID: "https://example.com", URL: "https://example.com"})
	ft := &fakeTransport{}
	s := &Server{DB: conn, transport: ft}
	s.notifyOnce.Do(func() {})
	return s, wt, ft
}

func postNotify(s *Server, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/notify", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(context.WithValue(req.Context(), sessionContextKey{}, uisession.Session{Handle: "s1"}))
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func TestNotifyAPIResourceToggleSendsTest(t *testing.T) {
	s, wt, ft := notifyAPIServer(t)
	if rec := postNotify(s, map[string]any{"path": wt, "type": "pr", "id": "o/r#3", "on": true}); rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	p, _ := notifyprefs.Get(s.DB, wt)
	if !p.Resources[notifyprefs.Key{Type: "pr", ID: "o/r#3"}] {
		t.Fatal("toggle not stored")
	}
	if len(ft.got) != 1 || ft.got[0].Title != "Notifications on" ||
		ft.got[0].Body != "You'll be notified about new events for PR #3" || ft.got[0].Subtitle != filepath.Base(wt) {
		t.Fatalf("test notification = %+v", ft.got)
	}

	postNotify(s, map[string]any{"path": wt, "type": "pr", "id": "o/r#3", "on": false})
	if len(ft.got) != 1 {
		t.Fatal("turning off must not send a test notification")
	}
}

func TestNotifyAPIWorktreeWide(t *testing.T) {
	s, wt, ft := notifyAPIServer(t)
	if rec := postNotify(s, map[string]any{"path": wt, "on": true}); rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if p, _ := notifyprefs.Get(s.DB, wt); !p.All {
		t.Fatal("worktree-wide toggle not stored")
	}
	want := "You'll be notified about new events for all resources in " + filepath.Base(wt)
	if len(ft.got) != 1 || ft.got[0].Body != want || ft.got[0].Tag != notifyTag(wt, "", "") {
		t.Fatalf("got %+v", ft.got)
	}
}

func TestNotifyAPIRejects(t *testing.T) {
	s, wt, _ := notifyAPIServer(t)
	cases := []struct {
		body map[string]any
		code int
	}{
		{map[string]any{"on": true}, http.StatusBadRequest},
		{map[string]any{"path": wt, "type": "pr", "on": true}, http.StatusBadRequest},
		{map[string]any{"path": wt, "type": "link", "id": "https://example.com", "on": true}, http.StatusBadRequest},
		{map[string]any{"path": t.TempDir(), "on": true}, http.StatusNotFound},
		{map[string]any{"path": wt, "type": "pr", "id": "o/r#404", "on": true}, http.StatusNotFound},
	}
	for _, c := range cases {
		if rec := postNotify(s, c.body); rec.Code != c.code {
			t.Errorf("%v: status %d, want %d", c.body, rec.Code, c.code)
		}
	}
}

func TestDTOsCarryNotifyFlags(t *testing.T) {
	s, wt, _ := notifyAPIServer(t)
	notifyprefs.SetResource(s.DB, wt, "pr", "o/r#3", true)
	resources.SetPrimary(s.DB, wt, "pr", "o/r#3", true)

	rec := httptest.NewRecorder()
	s.handleWorktreeResources(rec, httptest.NewRequest("GET", "/api/worktree-resources?path="+url.QueryEscape(wt), nil))
	var rs []resourceDTO
	json.NewDecoder(rec.Body).Decode(&rs)
	found := false
	for _, r := range rs {
		if r.ID == "o/r#3" {
			found = r.Notify
		}
	}
	if !found {
		t.Fatalf("resource DTO lacks notify: %+v", rs)
	}

	notifyprefs.SetAll(s.DB, wt, true)
	rec = httptest.NewRecorder()
	s.handleWorktrees(rec, httptest.NewRequest("GET", "/api/worktrees", nil))
	var ws []worktreeSummary
	json.NewDecoder(rec.Body).Decode(&ws)
	if len(ws) != 1 || !ws[0].NotifyAll {
		t.Fatalf("worktree summary lacks notify_all: %+v", ws)
	}
	if len(ws[0].FocusResources) != 1 || !ws[0].FocusResources[0].Notify {
		t.Fatalf("focus resource lacks notify: %+v", ws[0].FocusResources)
	}
}
```

> Check the `resources.SetPrimary` signature in `internal/resources/resources.go` before using it. If the primary flag is set some other way (e.g. a `Related` field on `Add`), mark the PR as focus that way instead. The assertion only needs the PR to appear in `focus_resources`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `go test ./internal/webui/ -run 'NotifyAPI|DTOsCarryNotifyFlags'`
Expected: FAIL (404 for the unknown route, missing fields).

- [ ] **Step 3: Implement `notify_api.go`**

```go
package webui

import (
	"encoding/json"
	"net/http"
	"path/filepath"

	"github.com/mturley/worktree/internal/notifyprefs"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

type setNotifyRequest struct {
	Path string `json:"path"`
	Type string `json:"type,omitempty"` // empty with ID: the worktree-wide toggle
	ID   string `json:"id,omitempty"`
	On   bool   `json:"on"`
	Tab  string `json:"tab,omitempty"` // browser mode: where the test notification goes first
}

// handleSetNotify: POST /api/notify
//
// Stores one toggle; turning one ON also sends a test notification through
// the real delivery path, so the user sees at once that it works where they
// are (or learns that it does not).
func (s *Server) handleSetNotify(w http.ResponseWriter, r *http.Request) {
	var req setNotifyRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	if (req.Type == "") != (req.ID == "") {
		writeError(w, http.StatusBadRequest, "type and id go together")
		return
	}
	if req.Type == "link" {
		writeError(w, http.StatusBadRequest, "links are never polled, so they have no events to notify about")
		return
	}
	entry, err := registry.Get(s.DB, req.Path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if entry == nil {
		writeError(w, http.StatusNotFound, "worktree not registered")
		return
	}

	label := ""
	if req.Type == "" {
		err = notifyprefs.SetAll(s.DB, req.Path, req.On)
	} else {
		rs, lerr := resources.Load(s.DB, req.Path)
		if lerr != nil {
			writeError(w, http.StatusInternalServerError, lerr.Error())
			return
		}
		var hit *resources.Resource
		for i := range rs {
			if rs[i].Type == req.Type && rs[i].ID == req.ID {
				hit = &rs[i]
			}
		}
		if hit == nil {
			writeError(w, http.StatusNotFound, "resource not tracked by this worktree")
			return
		}
		label = notifyResourceLabel(s.newResourceDTO(*hit))
		err = notifyprefs.SetResource(s.DB, req.Path, req.Type, req.ID, req.On)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if req.On {
		name := filepath.Base(req.Path)
		body := "You'll be notified about new events for " + label
		if req.Type == "" {
			body = "You'll be notified about new events for all resources in " + name
		}
		sess, _ := currentSession(r)
		s.deliver(notifyBatch{
			WorktreePath: req.Path, ResourceType: req.Type, ResourceID: req.ID,
			Title: "Notifications on", Subtitle: name, Body: body,
			Tag: notifyTag(req.Path, req.Type, req.ID),
		}, deliverOpts{PreferTab: req.Tab, OnlySession: sess.Handle})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mode": s.notifyMode()})
}
```

Route in `server.go`, after the worktree-notes routes:

```go
		{"POST /api/notify", s.handleSetNotify},
```

- [ ] **Step 4: Add the DTO fields**

`resources_api.go`: add to `resourceDTO`, after `UnreadThroughTS`:

```go
	// Notify is this resource's explicit notification toggle in the
	// requesting worktree. The worktree-wide toggle is NotifyAll on the
	// worktree; the UI shows the effective state as their OR.
	Notify bool `json:"notify,omitempty"`
```

In `handleWorktreeResources`, after the `ix := s.newUnreadIndex()` line:

```go
	prefs, err := notifyprefs.Get(s.DB, path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
```

and in the loop, after `ix.fill(&dto)`:

```go
		dto.Notify = prefs.Resources[notifyprefs.Key{Type: dto.Type, ID: dto.ID}]
```

(Add the `notifyprefs` import.)

`worktrees.go`: add to `worktreeSummary`, after `UnreadCount`:

```go
	// NotifyAll is the worktree-wide "Notify on all" toggle.
	NotifyAll bool `json:"notify_all"`
```

In `handleWorktrees`, before the `for _, e := range entries` loop:

```go
	// One query for every worktree's toggles, like the unread index above.
	allPrefs, err := notifyprefs.ListAll(s.DB)
	if err != nil && s.Logger != nil {
		s.Logger.Printf("notifyprefs.ListAll: %v", err)
	}
```

Inside the loop, before `for _, res := range rs`:

```go
		prefs := allPrefs[wdb.Subscriber(e.Path)]
```

In the `!res.Related` branch, after `ix.fill(&dto)`:

```go
				dto.Notify = prefs.Resources[notifyprefs.Key{Type: dto.Type, ID: dto.ID}]
```

and add `NotifyAll: prefs.All,` to the `worktreeSummary{...}` literal.

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `go test ./...`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add internal/webui/notify_api.go internal/webui/notify_api_test.go internal/webui/server.go internal/webui/worktrees.go internal/webui/resources_api.go
git commit --signoff -m "feat(notify): add toggle endpoint with test notification and DTO flags" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: UI API surface and the "Unreads only" rename

**Files:**
- Modify: `ui/src/api/types.ts`, `ui/src/api/client.ts`
- Modify: `ui/src/components/UnreadOnlyToggle.tsx`
- Modify: every test matching `grep -rln "Show unread only" ui/src --include=*.test.tsx` (today: `pages/HomePage.test.tsx`, `pages/WorktreeDetailPage.test.tsx`)

**Interfaces:**
- Produces (TS):
  - `type NotifyMode = "cmux" | "browser"`
  - `SessionInfo.notify_mode?: NotifyMode`
  - `WorktreeSummary.notify_all?: boolean`
  - `ResourceDTO.notify?: boolean`
  - `interface NotificationMsg { id; title; subtitle; body; worktree_path; resource_type; resource_id; tag }` (all strings)
  - `api.setNotify(args: { path: string; type?: string; id?: string; on: boolean; tab?: string }) => Promise<{ ok: boolean; mode: NotifyMode }>`
  - `api.tabPresence(args: { tab: string; route: string; visible: boolean }) => Promise<null>`
  - `api.tabAck(args: { tab: string; notification_id: string; shown: boolean }) => Promise<null>`

- [ ] **Step 1: Update the tests for the new label (failing first)**

In each file found by the grep, replace the string `"Show unread only"` (in `getByLabelText`, `getByRole(..., { name })`, etc.) with `"Unreads only"`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd ui && npx vitest run src/pages`
Expected: FAIL: unable to find a label "Unreads only".

- [ ] **Step 3: Rename the label**

In `UnreadOnlyToggle.tsx`, change `label="Show unread only"` to `label="Unreads only"`. In the comments of `ResourceList.tsx`, `lib/unreadOnlyPref.ts`, `hooks/useUnreadOnly.ts`, `pages/WorktreeDetailPage.tsx` and `lib/resourceOrder.ts`, change the quoted name "Show unread only" to "Unreads only" so they keep matching the UI.

- [ ] **Step 4: Add the types and client calls**

`types.ts`. Add next to `SessionInfo`:

```ts
/** How the server delivers notifications: `cmux notify`, or browser tabs. */
export type NotifyMode = "cmux" | "browser"

/** The `notification` stream message: shown by exactly one tab per session. */
export interface NotificationMsg {
  id: string
  title: string
  subtitle: string
  body: string
  worktree_path: string
  /** Empty for a worktree-wide test notification. */
  resource_type: string
  resource_id: string
  tag: string
}
```

Add `notify_mode?: NotifyMode` to `SessionInfo`. Add to `WorktreeSummary`:

```ts
  /** The worktree-wide "Notify on all" toggle. Absent on an older cached response. */
  notify_all?: boolean;
```

Add to `ResourceDTO`:

```ts
  /** This resource's own notification toggle; the effective state is `notify || worktree.notify_all`. */
  notify?: boolean
```

`client.ts`, inside `api`:

```ts
  /**
   * One notification toggle: worktree-wide without type/id, else one
   * resource. Turning one on makes the server send a test notification,
   * starting with this tab when `tab` is given.
   */
  setNotify: (args: { path: string; type?: string; id?: string; on: boolean; tab?: string }) =>
    fetchJSON<{ ok: boolean; mode: NotifyMode }>("/api/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  tabPresence: (args: { tab: string; route: string; visible: boolean }) =>
    fetchJSON<null>("/api/tabs/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  tabAck: (args: { tab: string; notification_id: string; shown: boolean }) =>
    fetchJSON<null>("/api/tabs/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
```

Add `NotifyMode` to the type import at the top of `client.ts`. A 204 has no JSON body: `fetchJSON` already returns `null` when `res.json()` fails, so `null` is the result.

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd ui && npm test && npx tsc --noEmit -p .`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/types.ts ui/src/api/client.ts ui/src/components/UnreadOnlyToggle.tsx ui/src/components/ResourceList.tsx ui/src/lib/unreadOnlyPref.ts ui/src/hooks/useUnreadOnly.ts ui/src/pages/WorktreeDetailPage.tsx ui/src/lib/resourceOrder.ts ui/src/pages/HomePage.test.tsx ui/src/pages/WorktreeDetailPage.test.tsx
git commit --signoff -m "feat(ui): notification API types; rename unread toggle to \"Unreads only\"" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Drop any path from `git add` that the grep or the comment pass didn't actually change.)

---

### Task 8: Tab identity, presence, and the stream `notification` handler

**Files:**
- Create: `ui/src/lib/tabId.ts`
- Create: `ui/src/lib/browserNotify.ts`, `ui/src/lib/browserNotify.test.ts`
- Create: `ui/src/hooks/useTabPresence.ts`, `ui/src/hooks/useTabPresence.test.tsx`
- Modify: `ui/src/hooks/useSSE.ts`, `ui/src/hooks/useSSE.test.tsx`
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Consumes: `api.tabPresence`, `api.tabAck`, `NotificationMsg`, `serializeResourceKey`, `withHomeParam`.
- Produces:
  - `TAB_ID: string`
  - `notificationHref(msg: NotificationMsg): string`
  - `showBrowserNotification(msg: NotificationMsg, onClick: () => void): boolean`
  - `openNotificationTarget(msg: NotificationMsg): void`
  - `useTabPresence(): void`
  - `streamUrl(): string`, exported from `useSSE.ts` for tests

- [ ] **Step 1: Write the failing tests**

`ui/src/lib/browserNotify.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest"
import { notificationHref, showBrowserNotification } from "./browserNotify"
import type { NotificationMsg } from "../api/types"

const msg: NotificationMsg = {
  id: "n1", title: "PR #3: Fix", subtitle: "wt-a", body: "approved", worktree_path: "/w/wt-a",
  resource_type: "pr", resource_id: "o/r#3", tag: "worktree:/w/wt-a|pr:o/r#3",
}

class FakeNotification {
  static permission: NotificationPermission = "granted"
  static instances: FakeNotification[] = []
  onclick: (() => void) | null = null
  close = vi.fn()
  constructor(public title: string, public opts: NotificationOptions) {
    FakeNotification.instances.push(this)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeNotification.instances = []
})

describe("notificationHref", () => {
  it("targets the worktree page with the resource selected", () => {
    expect(notificationHref(msg)).toBe("/worktree/%2Fw%2Fwt-a?resource=pr:o%2Fr%233")
  })
  it("targets the bare worktree page for a worktree-wide notification", () => {
    expect(notificationHref({ ...msg, resource_type: "", resource_id: "" })).toBe("/worktree/%2Fw%2Fwt-a")
  })
})

describe("showBrowserNotification", () => {
  it("shows with subtitle + body and tag, and runs onClick", () => {
    vi.stubGlobal("Notification", FakeNotification)
    const onClick = vi.fn()
    expect(showBrowserNotification(msg, onClick)).toBe(true)
    const n = FakeNotification.instances[0]
    expect(n.title).toBe("PR #3: Fix")
    expect(n.opts.body).toBe("wt-a\napproved")
    expect(n.opts.tag).toBe(msg.tag)
    n.onclick!()
    expect(onClick).toHaveBeenCalled()
    expect(n.close).toHaveBeenCalled()
  })
  it("returns false without permission", () => {
    FakeNotification.permission = "default"
    vi.stubGlobal("Notification", FakeNotification)
    expect(showBrowserNotification(msg, () => {})).toBe(false)
    FakeNotification.permission = "granted"
  })
  it("returns false without the API", () => {
    vi.stubGlobal("Notification", undefined)
    expect(showBrowserNotification(msg, () => {})).toBe(false)
  })
})
```

Add to `ui/src/hooks/useSSE.test.tsx`. Extend `FakeEventSource.emit` so tests can pass data: `emit(type: string, data?: string) { for (const fn of this.listeners[type] ?? []) fn({ data }) }`. Mock the client with `vi.mock("../api/client", async (orig) => ({ ...(await orig<typeof import("../api/client")>()), api: { tabAck: vi.fn(() => Promise.resolve(null)) } }))` near the top, importing `api` from `"../api/client"`. Then:

```ts
  it("names this tab on the stream URL", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const qc = new QueryClient()
    renderHook(() => useSSE(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    })
    const url = new URL(FakeEventSource.last!.url, "http://x")
    expect(url.pathname).toBe("/api/stream")
    expect(url.searchParams.get("tab")).toBeTruthy()
    expect(url.searchParams.get("route")).toBe(window.location.pathname)
  })

  it("acks shown:false for a notification it cannot show", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal("Notification", undefined)
    const qc = new QueryClient()
    renderHook(() => useSSE(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    })
    FakeEventSource.last!.emit("notification", JSON.stringify({ id: "n9", title: "t", subtitle: "", body: "", worktree_path: "/w", resource_type: "", resource_id: "", tag: "x" }))
    expect(api.tabAck).toHaveBeenCalledWith(expect.objectContaining({ notification_id: "n9", shown: false }))
  })
```

`ui/src/hooks/useTabPresence.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, cleanup, act } from "@testing-library/react"
import { api } from "../api/client"
import { useTabPresence } from "./useTabPresence"
import { TAB_ID } from "../lib/tabId"

vi.mock("../api/client", async (orig) => ({
  ...(await orig<typeof import("../api/client")>()),
  api: { tabPresence: vi.fn(() => Promise.resolve(null)) },
}))

afterEach(cleanup)

describe("useTabPresence", () => {
  it("reports route and visibility on mount and on visibility change", () => {
    renderHook(() => useTabPresence())
    expect(api.tabPresence).toHaveBeenLastCalledWith({ tab: TAB_ID, route: window.location.pathname, visible: true })
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    act(() => { document.dispatchEvent(new Event("visibilitychange")) })
    expect(api.tabPresence).toHaveBeenLastCalledWith({ tab: TAB_ID, route: window.location.pathname, visible: false })
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
  })
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd ui && npx vitest run src/lib/browserNotify.test.ts src/hooks/useSSE.test.tsx src/hooks/useTabPresence.test.tsx`
Expected: FAIL (missing modules / assertions).

- [ ] **Step 3: Implement**

`ui/src/lib/tabId.ts`:

```ts
/**
 * This tab's identity for the notification registry: new per page load, so a
 * reload is a new tab and a duplicated tab is a different one. The server
 * uses it to send a browser notification to exactly one tab per session.
 */
function makeTabId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    // randomUUID needs a secure context; the plain-HTTP listener is
    // loopback (secure), but stay safe everywhere.
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}

export const TAB_ID = makeTabId()
```

`ui/src/lib/browserNotify.ts`:

```ts
import { navigate } from "wouter/use-browser-location"
import type { NotificationMsg } from "../api/types"
import { serializeResourceKey } from "./resourceKey"
import { withHomeParam } from "./homeWorktree"

/** Where clicking a notification goes: the worktree, with the resource selected. */
export function notificationHref(msg: NotificationMsg): string {
  const base = `/worktree/${encodeURIComponent(msg.worktree_path)}`
  if (!msg.resource_type) return base
  return `${base}?resource=${serializeResourceKey({ type: msg.resource_type, id: msg.resource_id })}`
}

/**
 * Shows msg as a browser notification. False when this browser can't
 * (no API, or permission not granted); the caller acks that so the server
 * tries another tab.
 */
export function showBrowserNotification(msg: NotificationMsg, onClick: () => void): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false
  const n = new Notification(msg.title, {
    body: [msg.subtitle, msg.body].filter(Boolean).join("\n"),
    tag: msg.tag,
    icon: "/favicon.svg",
  })
  n.onclick = () => {
    window.focus()
    onClick()
    n.close()
  }
  return true
}

/** Brings the notification's worktree/resource up in this tab, unless it already is. */
export function openNotificationTarget(msg: NotificationMsg): void {
  const href = notificationHref(msg)
  const target = new URL(href, window.location.origin)
  const here = new URL(window.location.href)
  const sameResource =
    here.pathname === target.pathname &&
    (here.searchParams.get("resource") ?? "") === (target.searchParams.get("resource") ?? "")
  if (!sameResource) navigate(withHomeParam(href))
}
```

`ui/src/hooks/useTabPresence.ts`:

```ts
import { useEffect } from "react"
import { useBrowserLocation } from "wouter/use-browser-location"
import { api } from "../api/client"
import { TAB_ID } from "../lib/tabId"

/**
 * Keeps the server's tab registry current: which page this tab is on and
 * whether it is visible, so a notification comes out of the best tab.
 * Browser location rather than the app Router's, because this is mounted
 * beside useSSE, outside the Router.
 */
export function useTabPresence(): void {
  const [location] = useBrowserLocation()
  useEffect(() => {
    const report = () => {
      void api
        .tabPresence({ tab: TAB_ID, route: location, visible: document.visibilityState === "visible" })
        .catch(() => {}) // unknown tab (stream not open yet): the stream URL carries the same facts
    }
    report()
    document.addEventListener("visibilitychange", report)
    window.addEventListener("focus", report)
    return () => {
      document.removeEventListener("visibilitychange", report)
      window.removeEventListener("focus", report)
    }
  }, [location])
}
```

`ui/src/hooks/useSSE.ts`: add the imports, the `streamUrl` helper, the new URL, and the `notification` listener:

```ts
import { api } from "../api/client"
import type { NotificationMsg } from "../api/types"
import { TAB_ID } from "../lib/tabId"
import { openNotificationTarget, showBrowserNotification } from "../lib/browserNotify"

/**
 * The stream URL names this tab and where it is, so the server can register
 * it for notifications in the same request that opens the stream.
 */
export function streamUrl(): string {
  const params = new URLSearchParams({
    tab: TAB_ID,
    route: window.location.pathname,
    visible: document.visibilityState === "visible" ? "1" : "0",
  })
  return `/api/stream?${params.toString()}`
}
```

Replace `es = new EventSource("/api/stream")` with `es = new EventSource(streamUrl())`, and add after the `events_new` listener:

```ts
      // The server picked this tab to show a notification. Ack either way:
      // shown:false (no permission, no API) sends it on to the next tab at
      // once instead of after the server's timeout.
      es.addEventListener("notification", (e) => {
        let msg: NotificationMsg
        try {
          msg = JSON.parse((e as MessageEvent).data)
        } catch {
          return
        }
        const shown = showBrowserNotification(msg, () => openNotificationTarget(msg))
        void api.tabAck({ tab: TAB_ID, notification_id: msg.id, shown }).catch(() => {})
      })
```

`App.tsx`: import `useTabPresence` and call it in `AuthenticatedApp`, right after `useSSE()`:

```tsx
  // Tells the server where this tab is, so a browser notification comes out
  // of the tab that best matches it (see internal/webui/tabs.go).
  useTabPresence()
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd ui && npm test && npx tsc --noEmit -p .`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/tabId.ts ui/src/lib/browserNotify.ts ui/src/lib/browserNotify.test.ts ui/src/hooks/useTabPresence.ts ui/src/hooks/useTabPresence.test.tsx ui/src/hooks/useSSE.ts ui/src/hooks/useSSE.test.tsx ui/src/App.tsx
git commit --signoff -m "feat(ui): show server-chosen browser notifications and report tab presence" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Notification switches (worktree-wide and per-resource)

**Files:**
- Create: `ui/src/hooks/useNotifyMode.ts`
- Create: `ui/src/components/NotifySwitch.tsx`, `ui/src/components/NotifySwitch.test.tsx`
- Modify: `ui/src/components/ResourceCard.tsx` (new `notify` prop; switch in the detail variant)
- Modify: `ui/src/components/ResourceDetailPane.tsx`, `ui/src/components/SlackThreadPane.tsx`, `ui/src/components/LinkPane.tsx` (thread `notify` through to `ResourceCard`)
- Modify: `ui/src/pages/WorktreeDetailPage.tsx` (header switch; pass `notify`)

**Interfaces:**
- Consumes: `api.setNotify`, `TAB_ID`, `NotifyMode`, `api.session`.
- Produces:
  - `useNotifyMode(): NotifyMode | undefined`
  - `<NotifySwitch label checked onToggle tooltip? disabledReason? mode? />`
  - `interface ResourceNotifyContext { all: boolean; mode: NotifyMode | undefined }`, exported from `ResourceCard.tsx`
  - `ResourceCard` prop `notify?: ResourceNotifyContext`. When it's absent, no switch and no bell render, so existing callers and tests are unaffected.
  - `ResourceDetailPaneProps.notify?: ResourceNotifyContext`

- [ ] **Step 1: Write the failing tests**

`ui/src/components/NotifySwitch.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { NotifySwitch } from "./NotifySwitch"

class FakeNotification {
  static permission: NotificationPermission = "default"
  static requestPermission = vi.fn(async () => {
    FakeNotification.permission = "granted"
    return "granted" as NotificationPermission
  })
}

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  FakeNotification.permission = "default"
  FakeNotification.requestPermission.mockClear()
})

describe("NotifySwitch", () => {
  it("asks for permission before turning on in browser mode", async () => {
    vi.stubGlobal("Notification", FakeNotification)
    const onToggle = vi.fn(async () => {})
    wrap(<NotifySwitch label="Notify on all" checked={false} mode="browser" onToggle={onToggle} />)
    await userEvent.click(screen.getByLabelText("Notify on all"))
    expect(FakeNotification.requestPermission).toHaveBeenCalled()
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it("never asks in cmux mode", async () => {
    vi.stubGlobal("Notification", FakeNotification)
    const onToggle = vi.fn(async () => {})
    wrap(<NotifySwitch label="Notify on all" checked={false} mode="cmux" onToggle={onToggle} />)
    await userEvent.click(screen.getByLabelText("Notify on all"))
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it("warns when on but this browser blocks notifications", () => {
    FakeNotification.permission = "denied"
    vi.stubGlobal("Notification", FakeNotification)
    wrap(<NotifySwitch label="Notify on all" checked mode="browser" onToggle={async () => {}} />)
    expect(screen.getByText("This browser is blocking notifications. Allow them in the site settings to receive them here.")).toBeTruthy()
  })

  it("offers Allow when on but permission is undecided", async () => {
    vi.stubGlobal("Notification", FakeNotification)
    wrap(<NotifySwitch label="Notify on all" checked mode="browser" onToggle={async () => {}} />)
    expect(screen.getByText("Notifications aren't enabled in this browser")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Allow" }))
    expect(FakeNotification.requestPermission).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText("Notifications aren't enabled in this browser")).toBeNull())
  })

  it("shows no warnings in cmux mode", () => {
    FakeNotification.permission = "denied"
    vi.stubGlobal("Notification", FakeNotification)
    wrap(<NotifySwitch label="Notify on all" checked mode="cmux" onToggle={async () => {}} />)
    expect(screen.queryByText(/blocking notifications/)).toBeNull()
  })

  it("is disabled with its reason as a tooltip", async () => {
    wrap(
      <NotifySwitch
        label="Notify on new events"
        checked
        mode="cmux"
        disabledReason="Notifications are enabled for all resources in the worktree"
        onToggle={async () => {}}
      />,
    )
    expect((screen.getByLabelText("Notify on new events") as HTMLInputElement).disabled).toBe(true)
    await userEvent.hover(screen.getByTestId("notify-switch-target"))
    await waitFor(() =>
      expect(document.body.textContent).toContain("Notifications are enabled for all resources in the worktree"),
    )
  })
})
```

Add to `ResourceCard.test.tsx` (it already has `wrap` with `MantineProvider` only). The switch's mutation needs a QueryClient, so wrap these cases in one:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const wrapQ = (ui: React.ReactNode) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
    </MantineProvider>,
  )

describe("notification switch on the detail card", () => {
  const pr = { type: "pr", id: "o/r#1", url: "u", primary: true, title: "T" }
  it("is absent without a notify context", () => {
    wrap(<ResourceCard r={pr} path="/w" variant="detail" />)
    expect(screen.queryByLabelText("Notify on new events")).toBeNull()
  })
  it("is shown, and disabled while the worktree notifies on all", () => {
    wrapQ(<ResourceCard r={pr} path="/w" variant="detail" notify={{ all: true, mode: "cmux" }} />)
    const input = screen.getByLabelText("Notify on new events") as HTMLInputElement
    expect(input.checked).toBe(true)
    expect(input.disabled).toBe(true)
  })
  it("is never shown for a link", () => {
    wrapQ(<ResourceCard r={{ ...pr, type: "link", id: "https://x" }} path="/w" variant="detail" notify={{ all: false, mode: "cmux" }} />)
    expect(screen.queryByLabelText("Notify on new events")).toBeNull()
  })
})
```

(Use the file's existing `screen`/`render` imports; add any that are missing.)

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd ui && npx vitest run src/components/NotifySwitch.test.tsx src/components/ResourceCard.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement**

`ui/src/hooks/useNotifyMode.ts`:

```ts
import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
import type { NotifyMode } from "../api/types"

/** The server's delivery path, from the session query the app already holds. */
export function useNotifyMode(): NotifyMode | undefined {
  return useQuery({ queryKey: ["session"], queryFn: api.session, retry: false, staleTime: Infinity }).data?.notify_mode
}
```

`ui/src/components/NotifySwitch.tsx`:

```tsx
import { useState } from "react"
import { Button, Group, Stack, Switch, Text, Tooltip } from "@mantine/core"
import type { NotifyMode } from "../api/types"

function permission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission
}

/**
 * A notification toggle. In browser mode, turning it on is the click that
 * lets us ask for permission, so it asks first; and while it is on, it says
 * so when THIS browser can't show notifications. A setting saved from one
 * device does nothing on another until that browser allows it, and hiding
 * that would read as the feature being broken. In cmux mode none of this
 * applies: the server shows them.
 */
export function NotifySwitch({
  label,
  checked,
  onToggle,
  tooltip,
  disabledReason,
  mode,
}: {
  label: string
  checked: boolean
  onToggle: (on: boolean) => Promise<void>
  tooltip?: string
  disabledReason?: string
  mode: NotifyMode | undefined
}) {
  const [perm, setPerm] = useState(permission)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const browser = mode === "browser"

  const ask = async () => {
    if (permission() === "default") setPerm(await Notification.requestPermission())
  }

  const change = async (on: boolean) => {
    setSaving(true)
    setError(null)
    try {
      if (on && browser) await ask()
      await onToggle(on)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const sw = (
    <Switch
      size="sm"
      label={label}
      checked={checked}
      disabled={saving || Boolean(disabledReason)}
      onChange={(e) => void change(e.currentTarget.checked)}
    />
  )
  const reason = disabledReason ?? tooltip

  return (
    <Stack gap={4}>
      {reason ? (
        <Tooltip label={reason} withArrow multiline maw={280}>
          {/* A wrapper, not the input: a disabled input gets no hover events. */}
          <div data-testid="notify-switch-target" style={{ display: "inline-block" }}>{sw}</div>
        </Tooltip>
      ) : (
        sw
      )}
      {checked && browser && !disabledReason && perm === "unsupported" && (
        <Text size="xs" c="orange">This browser can't show notifications.</Text>
      )}
      {checked && browser && !disabledReason && perm === "denied" && (
        <Text size="xs" c="orange">
          This browser is blocking notifications. Allow them in the site settings to receive them here.
        </Text>
      )}
      {checked && browser && !disabledReason && perm === "default" && (
        <Group gap={6}>
          <Text size="xs" c="orange">Notifications aren't enabled in this browser</Text>
          <Button size="compact-xs" variant="light" onClick={() => void ask()}>Allow</Button>
        </Group>
      )}
      {error && <Text size="xs" c="red">{error}</Text>}
    </Stack>
  )
}
```

`ResourceCard.tsx`:
- Export `export interface ResourceNotifyContext { all: boolean; mode: NotifyMode | undefined }`.
- Add `notify?: ResourceNotifyContext` to `ResourceCardProps` and destructure it.
- Add a small inner component that owns the mutation, so the card itself needs no QueryClient:

```tsx
function ResourceNotifySwitch({ r, path, notify }: { r: ResourceDTO; path: string; notify: ResourceNotifyContext }) {
  const qc = useQueryClient()
  return (
    <NotifySwitch
      label="Notify on new events"
      checked={notify.all || Boolean(r.notify)}
      mode={notify.mode}
      disabledReason={notify.all ? "Notifications are enabled for all resources in the worktree" : undefined}
      onToggle={async (on) => {
        await api.setNotify({ path, type: r.type, id: r.id, on, tab: TAB_ID })
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["resources"] }),
          qc.invalidateQueries({ queryKey: ["worktrees"] }),
        ])
      }}
    />
  )
}
```

- In the detail-only `Group` that holds `RemoveControl`, render it first:

```tsx
        {variant === "detail" && (
          <Group gap="sm" wrap="nowrap" align="flex-start">
            {/* Links are never polled, so there is nothing to notify about. */}
            {notify && path && r.type !== "link" && <ResourceNotifySwitch r={r} path={path} notify={notify} />}
            <RemoveControl r={r} path={path} onRemoved={onRemoved} />
          </Group>
        )}
```

(Imports: `useQueryClient` from `@tanstack/react-query`, `NotifySwitch`, `TAB_ID` from `../lib/tabId`, `type NotifyMode` from `../api/types`.)

`ResourceDetailPane.tsx`: add `notify?: ResourceNotifyContext` to `ResourceDetailPaneProps`, destructure it in `ResourceDetailPane`, pass it to `SlackThreadPane`, `LinkPane` and the activity pane, and from each of those to its `<ResourceCard … notify={notify} />`. Do the same prop threading in `SlackThreadPane.tsx` and `LinkPane.tsx`: add an optional `notify?: ResourceNotifyContext` prop and pass it to their `ResourceCard`.

`WorktreeDetailPage.tsx`:

```tsx
  const notifyMode = useNotifyMode()
  const qc = useQueryClient()
  const notify = useMemo(
    () => ({ all: Boolean(summary?.notify_all), mode: notifyMode }),
    [summary?.notify_all, notifyMode],
  )
```

(Place after `summary` is computed. Import `useQueryClient`, `useNotifyMode`, `NotifySwitch`, `TAB_ID`, `api`, and `Group` if it isn't imported yet.)

Replace `toolbar={<UnreadOnlyToggle value={unreadOnly} onChange={setUnreadOnly} />}` with:

```tsx
      toolbar={
        <Group gap="lg" align="flex-start">
          <UnreadOnlyToggle value={unreadOnly} onChange={setUnreadOnly} />
          <NotifySwitch
            label="Notify on all"
            tooltip="Notify on new events for all resources in this worktree"
            checked={notify.all}
            mode={notify.mode}
            onToggle={async (on) => {
              await api.setNotify({ path, on, tab: TAB_ID })
              await Promise.all([
                qc.invalidateQueries({ queryKey: ["worktrees"] }),
                qc.invalidateQueries({ queryKey: ["resources"] }),
              ])
            }}
          />
        </Group>
      }
```

and pass `notify={notify}` to `<ResourceList …>` (used in Task 10) and to every `<ResourceDetailPane …>` in the page.

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd ui && npm test && npx tsc --noEmit -p .`
Expected: PASS. `ResourceList` doesn't take `notify` until Task 10, so either add the prop in that file now as an accepted-but-unused optional `notify?: ResourceNotifyContext`, or leave the `notify={notify}` on `ResourceList` for Task 10.

- [ ] **Step 5: Commit**

```bash
git add ui/src/hooks/useNotifyMode.ts ui/src/components/NotifySwitch.tsx ui/src/components/NotifySwitch.test.tsx ui/src/components/ResourceCard.tsx ui/src/components/ResourceCard.test.tsx ui/src/components/ResourceDetailPane.tsx ui/src/components/SlackThreadPane.tsx ui/src/components/LinkPane.tsx ui/src/pages/WorktreeDetailPage.tsx
git commit --signoff -m "feat(ui): notification switches for a worktree and for a resource" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Bell indicators

**Files:**
- Create: `ui/src/components/NotifyBell.tsx`, `ui/src/components/NotifyBell.test.tsx`
- Modify: `ui/src/components/ResourceCard.tsx` (bell beside `UnreadBadge` on list cards)
- Modify: `ui/src/components/SortableResourceCard.tsx`, `ui/src/components/ResourceList.tsx` (thread `notify`)
- Modify: `ui/src/components/ResourceTypeLine.tsx` (optional `trailing` slot)
- Modify: `ui/src/components/WorktreeCard.tsx` (+ `WorktreeCard.test.tsx`)

**Interfaces:**
- Consumes: `ResourceNotifyContext`, `ResourceDTO.notify`, `WorktreeSummary.notify_all`.
- Produces:
  - `<NotifyBell kind="explicit" | "implicit" tooltip?: string />`
  - `ResourceTypeLine` prop `trailing?: React.ReactNode`
  - `ResourceList` / `SortableResourceCard` prop `notify?: ResourceNotifyContext`

- [ ] **Step 1: Write the failing tests**

`ui/src/components/NotifyBell.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { NotifyBell } from "./NotifyBell"

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)
afterEach(cleanup)

describe("NotifyBell", () => {
  it("explicit: filled bell with its tooltip", async () => {
    wrap(<NotifyBell kind="explicit" />)
    const bell = screen.getByRole("img", { name: "Notifications on" })
    expect(bell.getAttribute("data-kind")).toBe("explicit")
    await userEvent.hover(bell)
    await waitFor(() => expect(document.body.textContent).toContain("Notifications are on for this resource"))
  })
  it("implicit: says where to turn it off", async () => {
    wrap(<NotifyBell kind="implicit" />)
    const bell = screen.getByRole("img", { name: "Notifications on for the whole worktree" })
    expect(bell.getAttribute("data-kind")).toBe("implicit")
    await userEvent.hover(bell)
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Notifications are on for all resources in this worktree. Turn off 'Notify on all' at the top of this page to change it",
      ),
    )
  })
})
```

Add to `ResourceCard.test.tsx` (`pr` as in Task 9):

```tsx
describe("bell on list cards", () => {
  const pr = { type: "pr", id: "o/r#1", url: "u", primary: true, title: "T" }
  it("explicit when the resource notifies", () => {
    wrap(<ResourceCard r={{ ...pr, notify: true }} notify={{ all: false, mode: "cmux" }} />)
    expect(screen.getByRole("img", { name: "Notifications on" })).toBeTruthy()
  })
  it("implicit wins when the worktree notifies on all", () => {
    wrap(<ResourceCard r={{ ...pr, notify: true }} notify={{ all: true, mode: "cmux" }} />)
    expect(screen.getByRole("img", { name: "Notifications on for the whole worktree" })).toBeTruthy()
  })
  it("none when off, and never on a link", () => {
    wrap(<ResourceCard r={pr} notify={{ all: false, mode: "cmux" }} />)
    expect(screen.queryByRole("img", { name: /Notifications on/ })).toBeNull()
    cleanup()
    wrap(<ResourceCard r={{ ...pr, type: "link", id: "https://x" }} notify={{ all: true, mode: "cmux" }} />)
    expect(screen.queryByRole("img", { name: /Notifications on/ })).toBeNull()
  })
})
```

Add to `WorktreeCard.test.tsx`. Build the summary with the file's existing fixture or helper, and spread these fields over it:

```tsx
describe("notification bells", () => {
  it("one worktree bell when notify_all, and no resource bells", () => {
    renderCard({ ...baseSummary, notify_all: true, focus_resources: [{ ...basePR, notify: true }] })
    expect(screen.getAllByRole("img", { name: /Notifications on/ })).toHaveLength(1)
    expect(screen.getByRole("img", { name: "Notifications on for the whole worktree" })).toBeTruthy()
  })
  it("a bell per notifying resource otherwise", () => {
    renderCard({ ...baseSummary, notify_all: false, focus_resources: [{ ...basePR, notify: true }, { ...basePR, id: "o/r#2" }] })
    expect(screen.getAllByRole("img", { name: "Notifications on" })).toHaveLength(1)
  })
})
```

(`renderCard`, `baseSummary`, `basePR` stand for whatever this test file already uses to render a `WorktreeCard` and build a `WorktreeSummary` / PR `ResourceDTO`. Use those names, or add minimal ones beside the existing render wrapper at line ~21.)

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd ui && npx vitest run src/components/NotifyBell.test.tsx src/components/ResourceCard.test.tsx src/components/WorktreeCard.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement**

`ui/src/components/NotifyBell.tsx`:

```tsx
import { Box, Tooltip } from "@mantine/core"
import { IconBell, IconBellFilled, IconStack2 } from "@tabler/icons-react"

const EXPLICIT = "Notifications are on for this resource"
const IMPLICIT =
  "Notifications are on for all resources in this worktree. Turn off 'Notify on all' at the top of this page to change it"

/**
 * Marks something that will notify. Explicit: set on this resource (filled).
 * Implicit: inherited from the worktree-wide toggle (outlined, dimmed, with a
 * stack badge), so the reader knows the switch to change is the worktree's,
 * not this one's.
 */
export function NotifyBell({ kind, tooltip }: { kind: "explicit" | "implicit"; tooltip?: string }) {
  const explicit = kind === "explicit"
  return (
    <Tooltip label={tooltip ?? (explicit ? EXPLICIT : IMPLICIT)} withArrow multiline maw={280}>
      <Box
        component="span"
        role="img"
        aria-label={explicit ? "Notifications on" : "Notifications on for the whole worktree"}
        data-kind={kind}
        style={{ position: "relative", display: "inline-flex", flex: "none", lineHeight: 0 }}
      >
        {explicit ? (
          <IconBellFilled size={14} style={{ color: "var(--mantine-color-yellow-6)" }} aria-hidden />
        ) : (
          <>
            <IconBell size={14} style={{ color: "var(--mantine-color-dimmed)" }} aria-hidden />
            <IconStack2
              size={8}
              aria-hidden
              style={{ position: "absolute", right: -4, bottom: -3, color: "var(--mantine-color-dimmed)" }}
            />
          </>
        )}
      </Box>
    </Tooltip>
  )
}
```

`ResourceCard.tsx`: compute the bell once in `ResourceCard`:

```tsx
  // Links are never polled, so they never notify, whatever the toggles say.
  const bell =
    !notify || r.type === "link" ? null
    : notify.all ? <NotifyBell kind="implicit" />
    : r.notify ? <NotifyBell kind="explicit" />
    : null
```

and in `bodyWithBadge` replace the lone `UnreadBadge` with:

```tsx
      <Group gap={6} wrap="nowrap" style={{ flex: "none" }}>
        {variant !== "detail" && bell}
        <UnreadBadge unread={showsUnread(variant) && hasUnread(r)} count={r.unread_count} />
      </Group>
```

(The detail card shows the switch from Task 9 instead of a bell.)

`SortableResourceCard.tsx`: add `notify?: ResourceNotifyContext` to its props and pass `notify={notify}` to `ResourceCard`. `ResourceList.tsx`: add `notify?: ResourceNotifyContext` to its props and pass it to each `SortableResourceCard` (the render at ~line 287).

`ResourceTypeLine.tsx`: change the signature to `export function ResourceTypeLine({ r, trailing }: { r: ResourceDTO; trailing?: React.ReactNode })` and render `{trailing}` as the last child of the `Group`.

`WorktreeCard.tsx`:
- `FocusResourceLine` takes `notifyAll: boolean`:

```tsx
function FocusResourceLine({ r, notifyAll }: { r: ResourceDTO; notifyAll: boolean }) {
```

  and renders `<ResourceTypeLine r={r} trailing={!notifyAll && r.notify && r.type !== "link" ? <NotifyBell kind="explicit" /> : undefined} />`.
- The map passes `notifyAll={Boolean(w.notify_all)}`.
- In the title row, before `UnreadBadge`, add the worktree bell, pushed right with the badge:

```tsx
            {w.notify_all && (
              <Box ml="auto" style={{ display: "inline-flex" }}>
                <NotifyBell kind="implicit" tooltip="Notifications are on for all resources in this worktree" />
              </Box>
            )}
            <UnreadBadge unread={!!w.has_unread} count={w.unread_count} ml={w.notify_all ? undefined : "auto"} />
```

  (`Box` is already imported there.)

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd ui && npm test && npx tsc --noEmit -p .`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/NotifyBell.tsx ui/src/components/NotifyBell.test.tsx ui/src/components/ResourceCard.tsx ui/src/components/ResourceCard.test.tsx ui/src/components/SortableResourceCard.tsx ui/src/components/ResourceList.tsx ui/src/components/ResourceTypeLine.tsx ui/src/components/WorktreeCard.tsx ui/src/components/WorktreeCard.test.tsx ui/src/pages/WorktreeDetailPage.tsx
git commit --signoff -m "feat(ui): bell indicators for notifying resources and worktrees" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Docs, spec reconciliation, and end-to-end check

**Files:**
- Modify: `docs/web-ui-architecture.md` (new "Notifications" section; add the routes to its route list)
- Modify: `.claude/CLAUDE.md` (add `notifyprefs` to the package list)
- Modify: `docs/superpowers/specs/2026-10-06-resource-notifications-design.md` (apply the "Deviations" listed at the top of this plan)

- [ ] **Step 1: Write the "Notifications" section**

Add to `docs/web-ui-architecture.md`, matching the surrounding sections' style. It covers:
- `worktree_notify` / `internal/notifyprefs`: a row means on; the empty resource is worktree-wide; cleanup via `resources.Remove`/`RemoveAll`.
- The notifier (`notifier.go`, `notify_scan.go`): a 5s loop with its own `(ts, seen)` cursor, why `seen` exists (1-second `ts`), the skipped types, one batch per (worktree, resource), the cursor starting at `MAX(ts)`, and no retries.
- The mode: `cmux.IsAvailable()` → `cmux notify --workspace`, untargeted when there's no workspace; otherwise browser tabs. `notify_mode` on `/api/session`.
- The tab registry (`tabs.go`): `?tab&route&visible` on `/api/stream`, `POST /api/tabs/presence`, `POST /api/tabs/ack`, candidate order, the 5s ack timeout and why (frozen tabs), per-offer IDs, the `tag` duplicate guard, and the reconnect-safe unregister.
- `POST /api/notify`: the body, the test notification, and why links are refused.
- UI: `NotifySwitch` (the permission UX), `NotifyBell` (explicit/implicit), and where each renders.

Add `POST /api/notify`, `POST /api/tabs/presence`, `POST /api/tabs/ack` to the route table/list in the same doc.

- [ ] **Step 2: Update CLAUDE.md**

Add after the `notes` bullet in `.claude/CLAUDE.md`:

```markdown
  - `notifyprefs` — per-worktree notification toggles (`worktree_notify`):
    a row means on, and the row with an empty resource is the worktree-wide
    "Notify on all". Keyed by `wdb.Subscriber`. Removed with the worktree's
    resources (unlike notes). The notifier and delivery live in `webui`
    (`notifier.go`, `notify_scan.go`, `tabs.go`); see
    `docs/web-ui-architecture.md` "Notifications".
```

- [ ] **Step 3: Reconcile the spec**

In the spec, change `PUT /api/notify` to `POST /api/notify` (HTTP API table, Test notification section, UI section). Replace the `POST /api/tabs/<id>` and `POST /api/tabs/<id>/ack` rows with `POST /api/tabs/presence` / `POST /api/tabs/ack` (tab in the body), and note that the initial presence rides on the stream URL. Change the cleanup bullet to `resources.Remove` / `resources.RemoveAll`. Add "links get no switch or bell and are refused by the API" to the UI section.

- [ ] **Step 4: Full verification**

Run: `make test && cd ui && npm test && npx tsc --noEmit -p . && cd .. && make build`
Expected: all PASS; `bin/worktree` builds.

- [ ] **Step 5: Manual check, cmux mode (needs Mike)**

Run the branch build on this worktree's ports, beside the installed server:

```bash
./bin/worktree ui --port 4071 --local-only --no-open > ~/tmp/notify-e2e-server.log 2>&1 &
echo $! > ~/tmp/notify-e2e-server.pid
cmux open --no-focus http://localhost:4071/
```

- [ ] Toggling "Notify on all" on a worktree fires a "Notifications on" cmux banner, and clicking it switches to that worktree's workspace.
- [ ] Bells render as designed on the home page and the detail page.
- [ ] A real new event (e.g. a comment on a tracked PR) produces one banner within a poll interval plus 5 seconds.

Stop it afterwards with `kill $(cat ~/tmp/notify-e2e-server.pid)`. Never pattern-kill.

- [ ] **Step 6: Manual check, browser mode (needs Mike)**

Start the same build from a shell where `CMUX_SOCKET_PATH` is unset (`env -u CMUX_SOCKET_PATH ./bin/worktree ui --port 4071 --local-only --no-open …`), and open it in a regular browser with two tabs (one on the home page, one on the worktree).
- [ ] Turning a toggle on prompts for permission, then shows a test notification.
- [ ] A notification comes from the worktree tab only.
- [ ] Clicking it focuses that tab and selects the resource.

- [ ] **Step 7: Commit**

```bash
git add docs/web-ui-architecture.md .claude/CLAUDE.md docs/superpowers/specs/2026-10-06-resource-notifications-design.md
git commit --signoff -m "docs: document resource notifications" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
