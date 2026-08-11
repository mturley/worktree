# Phase 1 — Worktree DB Adoption (watcher library + resources + ports + env/shellenv + discovery pivot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a SQLite database (via the `github.com/mturley/watcher` library) worktree's source of truth for tracked resources, port allocations, and the worktree registry — replacing the `.worktree-resources`, `.port-ranges`, and `.worktree-env` files and the `.git/info/exclude` block — and expose the `worktree resources ... --json` CLI contract handler will bind to later.

**Architecture:** worktree opens a per-user SQLite DB at `${XDG_DATA_HOME:-~/.local/share}/worktree/worktree.db`, runs the watcher library's `db.Migrate` on it, and becomes a watcher *consumer* under the subscriber namespace `worktree:<canonical-worktree-path>`. Tracked resources become `watcher_subscriptions` rows; a small worktree-owned `worktree_primary` table records the primary-vs-related flag the library schema does not carry; a worktree-owned `port_allocations` table replaces the flat `.port-ranges` file; and a worktree-owned `worktrees` registry table replaces filesystem discovery. `.worktree-env` becomes a `worktree env` shellenv-style command computed live from the DB. Everything worktree persists that only worktree reads moves into the DB; the only shell-facing bridge is the `worktree env` command.

**Tech Stack:** Go 1.26, `github.com/mturley/watcher` (SQLite library, v0.2.4), `modernc.org/sqlite` (pure-Go driver, transitively required by the library and used directly to open the DB), `github.com/spf13/cobra`, `gopkg.in/yaml.v3`.

## Global Constraints

- **DB path:** `${XDG_DATA_HOME:-$HOME/.local/share}/worktree/worktree.db`. Directory created with `0755`, DB file default perms. Never hard-code `/Users/...` or `~` string prefixes — resolve via `os.UserHomeDir()` / `os.Getenv("XDG_DATA_HOME")`.
- **Driver:** open with `sql.Open("sqlite", dsn)` using the `modernc.org/sqlite` driver (registered as `"sqlite"`), matching the library (`watcher/testutil/testutil.go` uses the same driver name). DSN must enable foreign keys and busy timeout: `file:<path>?_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)`.
- **Subscriber identity:** `worktree:<canonical-worktree-path>` where the path is `filepath.Clean` of the absolute worktree path (resolve symlinks via `filepath.EvalSymlinks` when the path exists; fall back to `filepath.Clean(filepath.Abs(...))` when it does not). One helper produces this string; nothing else builds it by hand.
- **NO backwards-compat / NO migration of old files.** Per roadmap decision #2, worktree has no other users. Do NOT read or import `.worktree-resources`, `.port-ranges`, or `.worktree-env` at runtime, and do NOT write them going forward. There is no data-migration command in this phase.
- **watcher library is unmodified.** `watcher_subscriptions` and all `watcher_*` tables stay library-owned. worktree-owned tables live alongside them in the same DB file, created by worktree's own migration hook, and MUST NOT collide with any `watcher_*` name (the library's `checkForCollisions` aborts on unexpected `watcher_*` tables — worktree tables must not use that prefix).
- **`Related` semantics preserved:** `primary = !Related`. At most one primary resource per `(worktree, type)`; adding a new primary demotes the existing primary of that type to related (this mirrors the current `resources.Add` behavior at `internal/resources/resources.go:75-86`).
- **In-process polling only (CC-1):** no launchd/cron/scheduler in this phase. Any polling is an explicit one-shot command (`worktree watcher run`) for testing; the interval loop is Phase 2 (UI server).
- **`--json` output is a stable machine contract (CC-2):** exact field names `type`, `id`, `url`, `primary`. Non-zero exit + stderr message when not inside a worktree or the DB is unavailable.
- Every code change ships with tests; `make test` (i.e. `go test ./...`) stays green. `make build` stays green.

---

## File Structure

New / changed packages and their single responsibility:

- **Create `internal/db/db.go`** — opens the DB, runs `watcher/db.Migrate`, runs worktree's own `migrate()` (worktree-owned tables), exposes `*sql.DB`. One place that knows the DB path + driver + pragmas.
- **Create `internal/db/migrate.go`** — worktree-owned schema (`worktree_primary`, `port_allocations`, `worktrees`) via `CREATE TABLE IF NOT EXISTS`. Disjoint from the library's `Migrate`.
- **Create `internal/db/subscriber.go`** — the `Subscriber(worktreePath) string` helper + `WorktreePathFromSubscriber(sub) (string, bool)`.
- **Rewrite `internal/resources/resources.go`** — same public surface (`Resource`, `Load`, `Add`, `Remove`, `PrimaryOfType`, `OfType`) but backed by `watcher_subscriptions` + `worktree_primary` instead of the file. `Save`/`FilePath`/`parseLine`/`Filename` removed.
- **Rewrite `internal/ports/ports.go`** — same public surface (`Allocation`, `Allocate`, `Release`, `LoadAllocations`) but backed by the `port_allocations` table with atomic allocate. `saveAllocations`/`portRangesFile` removed.
- **Create `internal/registry/registry.go`** — worktree registry CRUD over the `worktrees` table (`Register`, `Unregister`, `List`, `Get`, `Reconcile`). Replaces filesystem discovery for `list`/`cleanup`.
- **Create `internal/shellenv/shellenv.go`** — computes the `export ...` lines for a worktree from the DB (the `worktree env` command's engine).
- **Create `cmd/env.go`** — the `worktree env` command (shellenv bridge).
- **Create `cmd/resources.go`** — the `worktree resources list|add|unwatch|remove` command group with `--json` (CC-2 contract).
- **Create `cmd/watcher.go`** — `worktree watcher run` one-shot poller (pr/jira) for testing timeline data.
- **Delete `internal/gitutil/exclude.go`** — `.git/info/exclude` management removed entirely.
- **Delete `internal/env/env.go`'s file-writing** — keep `KubeconfigPath`/`SeedKubeconfig`/`WorktreeEnv` struct; remove `Generate`/`FilePath`/`Filename`.
- **Modify `internal/config/config.go`** — drop the `search:` section (`SearchConfig`, its defaults, its env overrides).
- **Modify `internal/discovery/discovery.go`** — remove `Discover`/`findGitRepos`/`listWorktrees` scan; keep `IsInsideWorktree`.
- **Modify `internal/setup/shellrc.go`** — shell snippet does `eval "$(worktree env)"` instead of `source .worktree-env`.
- **Modify `cmd/root.go`, `cmd/list.go`, `cmd/cleanup.go`, `cmd/delete.go`, `cmd/prune.go`, `cmd/jira.go`, `cmd/info.go`, `cmd/open.go`, `cmd/setup.go`** — repoint call sites at the new DB-backed APIs and register the worktree at creation.

Task ordering is bottom-up: DB layer first, then each owned table's package, then the CLI surfaces, then the create/delete wiring, then discovery/shellrc cutover, then cleanup of dead file code, then a cold-start measurement gate.

---

### Task 1: DB open + worktree-owned migration layer

**Files:**
- Create: `internal/db/db.go`
- Create: `internal/db/migrate.go`
- Create: `internal/db/subscriber.go`
- Test: `internal/db/db_test.go`
- Test: `internal/db/subscriber_test.go`
- Modify: `go.mod` / `go.sum` (add `github.com/mturley/watcher` + `modernc.org/sqlite`)

**Interfaces:**
- Produces:
  - `func Open() (*sql.DB, error)` — opens the DB at the Global-Constraints path, runs `watcherdb.Migrate(conn)` then worktree `migrate(conn)`, returns the handle.
  - `func OpenAt(path string) (*sql.DB, error)` — same but explicit path (tests, `WORKTREE_DB` override).
  - `func Path() string` — the resolved DB path.
  - `func migrate(conn *sql.DB) error` — creates worktree-owned tables (idempotent).
  - `func Subscriber(worktreePath string) string` — returns `worktree:<canonical-path>`.
  - `func WorktreePathFromSubscriber(sub string) (string, bool)` — inverse; `false` if not a `worktree:` subscriber.

- [ ] **Step 1: Add dependencies**

Run (in `/Users/mturley/git/worktree`):
```bash
go get github.com/mturley/watcher@v0.2.4
go get modernc.org/sqlite@latest
```
Expected: `go.mod` now requires both. `go mod tidy` after later imports exist.

- [ ] **Step 2: Write the failing test for `Subscriber`/`WorktreePathFromSubscriber`**

Create `internal/db/subscriber_test.go`:
```go
package db

import "testing"

func TestSubscriberRoundTrip(t *testing.T) {
	sub := Subscriber("/tmp/wt/foo")
	if sub != "worktree:/tmp/wt/foo" {
		t.Fatalf("got %q", sub)
	}
	path, ok := WorktreePathFromSubscriber(sub)
	if !ok || path != "/tmp/wt/foo" {
		t.Fatalf("round-trip failed: %q %v", path, ok)
	}
	if _, ok := WorktreePathFromSubscriber("handler:session:abc"); ok {
		t.Fatal("non-worktree subscriber must return ok=false")
	}
}

func TestSubscriberCleansPath(t *testing.T) {
	if got := Subscriber("/tmp/wt/../wt/foo/"); got != "worktree:/tmp/wt/foo" {
		t.Fatalf("expected cleaned path, got %q", got)
	}
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `go test ./internal/db/ -run TestSubscriber -v`
Expected: FAIL to compile (`Subscriber` undefined).

- [ ] **Step 4: Implement `internal/db/subscriber.go`**

```go
package db

import (
	"path/filepath"
	"strings"
)

const subscriberPrefix = "worktree:"

// Subscriber returns the canonical subscriber identity for a worktree at
// worktreePath: "worktree:<canonical-absolute-path>". Symlinks are resolved
// when the path exists so the same worktree always maps to one subscriber.
func Subscriber(worktreePath string) string {
	abs, err := filepath.Abs(worktreePath)
	if err != nil {
		abs = worktreePath
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	return subscriberPrefix + filepath.Clean(abs)
}

// WorktreePathFromSubscriber returns the worktree path encoded in a
// "worktree:"-prefixed subscriber string, or ok=false for any other subscriber.
func WorktreePathFromSubscriber(sub string) (string, bool) {
	if !strings.HasPrefix(sub, subscriberPrefix) {
		return "", false
	}
	return strings.TrimPrefix(sub, subscriberPrefix), true
}
```

- [ ] **Step 5: Run to verify pass**

Run: `go test ./internal/db/ -run TestSubscriber -v`
Expected: PASS.

- [ ] **Step 6: Write the failing test for `OpenAt` + migration idempotency**

Create `internal/db/db_test.go`:
```go
package db

import (
	"path/filepath"
	"testing"
)

func TestOpenAtCreatesTables(t *testing.T) {
	p := filepath.Join(t.TempDir(), "worktree.db")
	conn, err := OpenAt(p)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer conn.Close()

	for _, tbl := range []string{"watcher_subscriptions", "worktree_primary", "port_allocations", "worktrees"} {
		var name string
		err := conn.QueryRow(
			`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, tbl).Scan(&name)
		if err != nil {
			t.Fatalf("expected table %q to exist: %v", tbl, err)
		}
	}
}

func TestOpenAtIdempotent(t *testing.T) {
	p := filepath.Join(t.TempDir(), "worktree.db")
	c1, err := OpenAt(p)
	if err != nil {
		t.Fatal(err)
	}
	c1.Close()
	c2, err := OpenAt(p) // second open must not error on existing tables
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}
	c2.Close()
}
```

- [ ] **Step 7: Run to verify it fails**

Run: `go test ./internal/db/ -run TestOpenAt -v`
Expected: FAIL to compile (`OpenAt` undefined).

- [ ] **Step 8: Implement `internal/db/migrate.go`**

```go
package db

import "database/sql"

// migrate creates the worktree-owned tables. It is idempotent and disjoint
// from the watcher library's Migrate (which owns all watcher_* tables). None
// of these table names use the watcher_ prefix, so the library's collision
// check never flags them.
func migrate(conn *sql.DB) error {
	stmts := []string{
		// primary/related flag the library schema does not carry.
		// Keyed by (subscriber, resource) so it composes with watcher_subscriptions.
		`CREATE TABLE IF NOT EXISTS worktree_primary (
			subscriber    TEXT NOT NULL,
			resource_type TEXT NOT NULL,
			resource_id   TEXT NOT NULL,
			is_primary    INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (subscriber, resource_type, resource_id)
		)`,
		// port allocations: one slot per name, unique slot for atomic allocate.
		`CREATE TABLE IF NOT EXISTS port_allocations (
			name TEXT PRIMARY KEY,
			slot INTEGER NOT NULL UNIQUE
		)`,
		// worktree registry: replaces filesystem discovery.
		`CREATE TABLE IF NOT EXISTS worktrees (
			path       TEXT PRIMARY KEY,
			repo       TEXT NOT NULL,
			repo_root  TEXT NOT NULL,
			branch     TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
	}
	for _, s := range stmts {
		if _, err := conn.Exec(s); err != nil {
			return err
		}
	}
	return nil
}
```

- [ ] **Step 9: Implement `internal/db/db.go`**

```go
package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	watcherdb "github.com/mturley/watcher/db"
	_ "modernc.org/sqlite"
)

// Path returns the resolved worktree DB path:
// ${XDG_DATA_HOME:-~/.local/share}/worktree/worktree.db, overridable via WORKTREE_DB.
func Path() string {
	if p := os.Getenv("WORKTREE_DB"); p != "" {
		return p
	}
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "worktree", "worktree.db")
}

// Open opens (creating as needed) the worktree DB at the standard path.
func Open() (*sql.DB, error) {
	return OpenAt(Path())
}

// OpenAt opens (creating as needed) the worktree DB at path, running the
// watcher library migration then worktree's own migration.
func OpenAt(path string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("creating db dir: %w", err)
	}
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)", path)
	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening db: %w", err)
	}
	if err := watcherdb.Migrate(conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("watcher migrate: %w", err)
	}
	if err := migrate(conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("worktree migrate: %w", err)
	}
	return conn, nil
}
```

- [ ] **Step 10: `go mod tidy` and run tests**

Run: `go mod tidy && go test ./internal/db/ -v`
Expected: PASS (all four tables exist; re-open idempotent).

- [ ] **Step 11: Commit**

```bash
git add go.mod go.sum internal/db/db.go internal/db/migrate.go internal/db/subscriber.go internal/db/db_test.go internal/db/subscriber_test.go
git commit --signoff -m "feat(db): worktree SQLite DB + watcher lib migration + owned tables"
```

---

### Task 2: DB-backed resources package

**Files:**
- Rewrite: `internal/resources/resources.go`
- Test: `internal/resources/resources_test.go`

**Interfaces:**
- Consumes: `db.Subscriber` (Task 1); `watcher.Resource{Type,ID,URL}`; `watcherdb.Subscribe/SubscribeOpts/UserUnsubscribe/Unsubscribe/ActiveSubscriptions`.
- Produces (public surface, keep names stable — many callers depend on them):
  - `type Resource struct { Type, ID, URL string; Related bool }` (unchanged shape).
  - `func Load(conn *sql.DB, worktreePath string) ([]Resource, error)` — **signature now takes `*sql.DB`** (was file-path only). Returns active subscriptions for that worktree with `Related` filled from `worktree_primary`.
  - `func Add(conn *sql.DB, worktreePath string, r Resource) error` — upserts subscription + primary flag; enforces one-primary-per-type.
  - `func Remove(conn *sql.DB, worktreePath, resType, id string) error` — **hard** remove (`Unsubscribe` + delete primary row).
  - `func Unwatch(conn *sql.DB, worktreePath, resType, id string) error` — **soft** user tombstone (`UserUnsubscribe`); primary flag row retained.
  - `func PrimaryOfType(resources []Resource, resType string) *Resource` (unchanged, pure).
  - `func OfType(resources []Resource, resType string) []Resource` (unchanged, pure).

> **Reviewer note (Global Constraints):** `Load` returns only *active* subscriptions (not user-tombstoned ones). `Add` on a resource that was previously user-unwatched must revive it — call `watcherdb.Subscribe` with `IfAbsent:false` so the library reinstates a non-user tombstone but leaves a *user* tombstone alone... except an explicit `Add` is a user re-watch, which per the roadmap's handler learnings requires reviving even a user tombstone. Use `watcherdb.Reinstate` first (idempotent revive) then `Subscribe` to refresh URL. See Step 4.

- [ ] **Step 1: Write failing tests**

Create `internal/resources/resources_test.go`:
```go
package resources

import (
	"database/sql"
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
```
```go
func TestAddAndLoad(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/a"
	if err := Add(conn, wt, Resource{Type: "pr", ID: "o/r#1", URL: "http://x/1"}); err != nil {
		t.Fatal(err)
	}
	res, err := Load(conn, wt)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 1 || res[0].ID != "o/r#1" || res[0].Related {
		t.Fatalf("got %+v", res)
	}
}

func TestSecondPrimaryDemotesFirst(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/a"
	Add(conn, wt, Resource{Type: "pr", ID: "o/r#1", URL: "u1"})
	Add(conn, wt, Resource{Type: "pr", ID: "o/r#2", URL: "u2"}) // new primary
	res, _ := Load(conn, wt)
	primaries := 0
	for _, r := range res {
		if !r.Related {
			primaries++
		}
	}
	if primaries != 1 {
		t.Fatalf("expected exactly 1 primary pr, got %d in %+v", primaries, res)
	}
	if p := PrimaryOfType(res, "pr"); p == nil || p.ID != "o/r#2" {
		t.Fatalf("expected #2 primary, got %+v", p)
	}
}

func TestUnwatchThenLoadExcludes(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/a"
	Add(conn, wt, Resource{Type: "jira", ID: "RH-1", URL: "u"})
	if err := Unwatch(conn, wt, "jira", "RH-1"); err != nil {
		t.Fatal(err)
	}
	res, _ := Load(conn, wt)
	if len(res) != 0 {
		t.Fatalf("unwatched resource should not appear in Load: %+v", res)
	}
}

func TestAddRevivesUserUnwatched(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/a"
	Add(conn, wt, Resource{Type: "jira", ID: "RH-1", URL: "u"})
	Unwatch(conn, wt, "jira", "RH-1")
	if err := Add(conn, wt, Resource{Type: "jira", ID: "RH-1", URL: "u2"}); err != nil {
		t.Fatal(err)
	}
	res, _ := Load(conn, wt)
	if len(res) != 1 || res[0].URL != "u2" {
		t.Fatalf("explicit Add must revive a user-unwatched resource: %+v", res)
	}
}

func TestRemoveIsHard(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/a"
	Add(conn, wt, Resource{Type: "pr", ID: "o/r#1", URL: "u"})
	if err := Remove(conn, wt, "pr", "o/r#1"); err != nil {
		t.Fatal(err)
	}
	res, _ := Load(conn, wt)
	if len(res) != 0 {
		t.Fatalf("removed resource should be gone: %+v", res)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/resources/ -v`
Expected: FAIL to compile (new signatures / `Unwatch` undefined).

- [ ] **Step 3: Rewrite `internal/resources/resources.go`**

```go
package resources

import (
	"database/sql"
	"fmt"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
)

type Resource struct {
	Type    string // "pr", "jira"
	ID      string // "owner/repo#123" or "RHOAIENG-456"
	URL     string
	Related bool // true when NOT the primary resource of its type
}

// Load returns the active tracked resources for a worktree.
func Load(conn *sql.DB, worktreePath string) ([]Resource, error) {
	sub := wdb.Subscriber(worktreePath)
	subs, err := watcherdb.ActiveSubscriptions(conn, sub, false)
	if err != nil {
		return nil, err
	}
	primary, err := loadPrimaryFlags(conn, sub)
	if err != nil {
		return nil, err
	}
	var out []Resource
	for _, s := range subs {
		key := s.Resource.Type + "\x00" + s.Resource.ID
		out = append(out, Resource{
			Type:    s.Resource.Type,
			ID:      s.Resource.ID,
			URL:     s.Resource.URL,
			Related: !primary[key], // absent flag => related (not primary)
		})
	}
	return out, nil
}

func loadPrimaryFlags(conn *sql.DB, sub string) (map[string]bool, error) {
	rows, err := conn.Query(
		`SELECT resource_type, resource_id, is_primary FROM worktree_primary WHERE subscriber = ?`, sub)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := make(map[string]bool)
	for rows.Next() {
		var t, id string
		var p int
		if err := rows.Scan(&t, &id, &p); err != nil {
			return nil, err
		}
		m[t+"\x00"+id] = p == 1
	}
	return m, rows.Err()
}

// Add tracks r for the worktree (reviving a prior user-unwatch), and records
// its primary/related flag. Adding a primary demotes the existing primary of
// the same type to related.
func Add(conn *sql.DB, worktreePath string, r Resource) error {
	sub := wdb.Subscriber(worktreePath)
	wr := watcher.Resource{Type: r.Type, ID: r.ID, URL: r.URL}

	// Explicit Add is a user re-watch: revive even a user tombstone, then
	// refresh the URL / keep it live.
	if err := watcherdb.Reinstate(conn, sub, wr); err != nil {
		return fmt.Errorf("reinstate: %w", err)
	}
	if err := watcherdb.Subscribe(conn, sub, wr, watcherdb.SubscribeOpts{}); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}

	if !r.Related {
		// Demote any existing primary of this type.
		if _, err := conn.Exec(
			`UPDATE worktree_primary SET is_primary = 0 WHERE subscriber = ? AND resource_type = ?`,
			sub, r.Type); err != nil {
			return err
		}
	}
	isPrimary := 0
	if !r.Related {
		isPrimary = 1
	}
	_, err := conn.Exec(
		`INSERT INTO worktree_primary (subscriber, resource_type, resource_id, is_primary)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT (subscriber, resource_type, resource_id)
		 DO UPDATE SET is_primary = excluded.is_primary`,
		sub, r.Type, r.ID, isPrimary)
	return err
}

// Remove hard-deletes the resource (no user tombstone) and its primary flag.
func Remove(conn *sql.DB, worktreePath, resType, id string) error {
	sub := wdb.Subscriber(worktreePath)
	wr := watcher.Resource{Type: resType, ID: id}
	if err := watcherdb.Unsubscribe(conn, sub, wr); err != nil {
		return err
	}
	_, err := conn.Exec(
		`DELETE FROM worktree_primary WHERE subscriber = ? AND resource_type = ? AND resource_id = ?`,
		sub, resType, id)
	return err
}

// Unwatch soft-unsubscribes as a user tombstone (distinct from Remove). The
// primary flag row is retained so a later Add restores the prior classification.
func Unwatch(conn *sql.DB, worktreePath, resType, id string) error {
	sub := wdb.Subscriber(worktreePath)
	return watcherdb.UserUnsubscribe(conn, sub, watcher.Resource{Type: resType, ID: id})
}

func PrimaryOfType(resources []Resource, resType string) *Resource {
	for i := range resources {
		if resources[i].Type == resType && !resources[i].Related {
			return &resources[i]
		}
	}
	return nil
}

func OfType(resources []Resource, resType string) []Resource {
	var result []Resource
	for _, r := range resources {
		if r.Type == resType {
			result = append(result, r)
		}
	}
	return result
}
```
> Note: `Unsubscribe` (hard) vs `UserUnsubscribe` (user tombstone) vs `Reinstate` all exist in `watcher/db/subscriptions.go` (verified). `PrimaryOfType` now indexes the slice (`&resources[i]`) instead of `&r` to avoid returning a pointer to the loop variable — a latent bug in the old file-based version.

- [ ] **Step 4: Run to verify pass**

Run: `go test ./internal/resources/ -v`
Expected: PASS all five tests.

- [ ] **Step 5: Commit**

```bash
git add internal/resources/resources.go internal/resources/resources_test.go
git commit --signoff -m "feat(resources): back tracked resources with watcher_subscriptions + primary table"
```

---

### Task 3: DB-backed ports package (atomic allocation)

**Files:**
- Rewrite: `internal/ports/ports.go`
- Test: `internal/ports/ports_test.go`

**Interfaces:**
- Consumes: `*sql.DB` (Task 1). `BasePort`/`RangeSize` constants unchanged.
- Produces:
  - `type Allocation struct { Slot int; Name string }` with methods `Start()/End()/Range()` (unchanged).
  - `func Allocate(conn *sql.DB, name string) (Allocation, error)` — **now takes `*sql.DB`**, returns existing allocation if name present, else the lowest free slot, inserted atomically.
  - `func Release(conn *sql.DB, name string) error`.
  - `func LoadAllocations(conn *sql.DB) ([]Allocation, error)` — sorted by slot.

- [ ] **Step 1: Write failing tests**

Create `internal/ports/ports_test.go`:
```go
package ports

import (
	"database/sql"
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

func TestAllocateAssignsLowestFreeSlot(t *testing.T) {
	conn := testDB(t)
	a, _ := Allocate(conn, "alpha")
	b, _ := Allocate(conn, "beta")
	if a.Slot != 0 || b.Slot != 1 {
		t.Fatalf("slots: alpha=%d beta=%d", a.Slot, b.Slot)
	}
}

func TestAllocateIsIdempotentPerName(t *testing.T) {
	conn := testDB(t)
	a1, _ := Allocate(conn, "alpha")
	a2, _ := Allocate(conn, "alpha")
	if a1.Slot != a2.Slot {
		t.Fatalf("same name got different slots: %d %d", a1.Slot, a2.Slot)
	}
}

func TestReleaseFreesSlotForReuse(t *testing.T) {
	conn := testDB(t)
	Allocate(conn, "alpha") // slot 0
	Allocate(conn, "beta")  // slot 1
	if err := Release(conn, "alpha"); err != nil {
		t.Fatal(err)
	}
	c, _ := Allocate(conn, "gamma") // should reuse slot 0
	if c.Slot != 0 {
		t.Fatalf("expected freed slot 0 reused, got %d", c.Slot)
	}
}

func TestAllocationRange(t *testing.T) {
	a := Allocation{Slot: 0}
	if a.Range() != "4020-4029" {
		t.Fatalf("range: %s", a.Range())
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/ports/ -v`
Expected: FAIL to compile (new signatures).

- [ ] **Step 3: Rewrite `internal/ports/ports.go`**

```go
package ports

import (
	"database/sql"
	"fmt"
)

const (
	BasePort  = 4020
	RangeSize = 10
)

type Allocation struct {
	Slot int
	Name string
}

func (a Allocation) Start() int    { return BasePort + a.Slot*RangeSize }
func (a Allocation) End() int      { return a.Start() + RangeSize - 1 }
func (a Allocation) Range() string { return fmt.Sprintf("%d-%d", a.Start(), a.End()) }

// LoadAllocations returns all allocations ordered by slot.
func LoadAllocations(conn *sql.DB) ([]Allocation, error) {
	rows, err := conn.Query(`SELECT slot, name FROM port_allocations ORDER BY slot`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Allocation
	for rows.Next() {
		var a Allocation
		if err := rows.Scan(&a.Slot, &a.Name); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Allocate returns name's existing allocation, or assigns the lowest free slot
// and inserts it. The UNIQUE(slot) constraint makes concurrent allocations of
// the same slot fail rather than silently collide; we retry on that.
func Allocate(conn *sql.DB, name string) (Allocation, error) {
	// Existing?
	var slot int
	err := conn.QueryRow(`SELECT slot FROM port_allocations WHERE name = ?`, name).Scan(&slot)
	if err == nil {
		return Allocation{Slot: slot, Name: name}, nil
	}
	if err != sql.ErrNoRows {
		return Allocation{}, err
	}

	for attempt := 0; attempt < 1000; attempt++ {
		free, err := lowestFreeSlot(conn)
		if err != nil {
			return Allocation{}, err
		}
		_, err = conn.Exec(`INSERT INTO port_allocations (name, slot) VALUES (?, ?)`, name, free)
		if err == nil {
			return Allocation{Slot: free, Name: name}, nil
		}
		// UNIQUE violation (name or slot taken concurrently) -> re-read and retry.
		if isConstraintErr(err) {
			// Maybe the name got inserted concurrently; return that row if so.
			if e2 := conn.QueryRow(`SELECT slot FROM port_allocations WHERE name = ?`, name).Scan(&slot); e2 == nil {
				return Allocation{Slot: slot, Name: name}, nil
			}
			continue
		}
		return Allocation{}, err
	}
	return Allocation{}, fmt.Errorf("could not allocate a free port slot for %q", name)
}

func lowestFreeSlot(conn *sql.DB) (int, error) {
	rows, err := conn.Query(`SELECT slot FROM port_allocations ORDER BY slot`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	used := map[int]bool{}
	for rows.Next() {
		var s int
		if err := rows.Scan(&s); err != nil {
			return 0, err
		}
		used[s] = true
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	slot := 0
	for used[slot] {
		slot++
	}
	return slot, nil
}

func Release(conn *sql.DB, name string) error {
	_, err := conn.Exec(`DELETE FROM port_allocations WHERE name = ?`, name)
	return err
}

// isConstraintErr reports whether err is a SQLite UNIQUE/PRIMARY KEY violation.
func isConstraintErr(err error) bool {
	return err != nil && strings.Contains(err.Error(), "constraint failed")
}
```
> Add `"strings"` to the import block. The modernc.org/sqlite driver surfaces UNIQUE/PRIMARY KEY violations with the substring `"constraint failed"` in the error text — matching on that is sufficient for the retry path.

- [ ] **Step 4: Run to verify pass**

Run: `go test ./internal/ports/ -v`
Expected: PASS all four tests.

- [ ] **Step 5: Commit**

```bash
git add internal/ports/ports.go internal/ports/ports_test.go
git commit --signoff -m "feat(ports): atomic DB-backed port allocation replacing .port-ranges"
```

---

### Task 4: worktree registry package

**Files:**
- Create: `internal/registry/registry.go`
- Test: `internal/registry/registry_test.go`

**Interfaces:**
- Consumes: `*sql.DB` (Task 1).
- Produces:
  - `type Entry struct { Path, Repo, RepoRoot, Branch, CreatedAt string }`
  - `func Register(conn *sql.DB, e Entry) error` — upsert by path.
  - `func Unregister(conn *sql.DB, path string) error`
  - `func List(conn *sql.DB) ([]Entry, error)` — ordered by repo, then path.
  - `func Get(conn *sql.DB, path string) (*Entry, error)` — nil if absent.
  - `type ReconcileResult struct { Orphans []string; Stale []string }`
  - `func Reconcile(conn *sql.DB, worktreesBase string) (ReconcileResult, error)` — Orphans = dirs under worktreesBase not in DB; Stale = DB rows whose `path` no longer exists on disk.

- [ ] **Step 1: Write failing tests**

Create `internal/registry/registry_test.go`:
```go
package registry

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

func TestRegisterListGet(t *testing.T) {
	conn := testDB(t)
	e := Entry{Path: "/wt/a", Repo: "repo", RepoRoot: "/repo", Branch: "b", CreatedAt: "2026-08-11T00:00:00Z"}
	if err := Register(conn, e); err != nil {
		t.Fatal(err)
	}
	list, _ := List(conn)
	if len(list) != 1 || list[0].Path != "/wt/a" {
		t.Fatalf("list: %+v", list)
	}
	got, _ := Get(conn, "/wt/a")
	if got == nil || got.Branch != "b" {
		t.Fatalf("get: %+v", got)
	}
	if missing, _ := Get(conn, "/nope"); missing != nil {
		t.Fatalf("expected nil for missing path")
	}
}

func TestRegisterUpsert(t *testing.T) {
	conn := testDB(t)
	Register(conn, Entry{Path: "/wt/a", Repo: "r", RepoRoot: "/r", Branch: "b1", CreatedAt: "t"})
	Register(conn, Entry{Path: "/wt/a", Repo: "r", RepoRoot: "/r", Branch: "b2", CreatedAt: "t"})
	list, _ := List(conn)
	if len(list) != 1 || list[0].Branch != "b2" {
		t.Fatalf("expected upsert to one row w/ branch b2: %+v", list)
	}
}

func TestReconcileFindsStaleAndOrphans(t *testing.T) {
	conn := testDB(t)
	base := t.TempDir()

	// on-disk worktree dir NOT in DB -> orphan
	orphan := filepath.Join(base, "orphan")
	os.MkdirAll(orphan, 0o755)

	// DB row whose dir is gone -> stale
	Register(conn, Entry{Path: filepath.Join(base, "gone"), Repo: "r", RepoRoot: "/r", Branch: "b", CreatedAt: "t"})

	// DB row that exists -> neither
	live := filepath.Join(base, "live")
	os.MkdirAll(live, 0o755)
	Register(conn, Entry{Path: live, Repo: "r", RepoRoot: "/r", Branch: "b", CreatedAt: "t"})

	res, err := Reconcile(conn, base)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Orphans) != 1 || res.Orphans[0] != orphan {
		t.Fatalf("orphans: %+v", res.Orphans)
	}
	if len(res.Stale) != 1 || res.Stale[0] != filepath.Join(base, "gone") {
		t.Fatalf("stale: %+v", res.Stale)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/registry/ -v`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `internal/registry/registry.go`**

```go
package registry

import (
	"database/sql"
	"os"
	"path/filepath"
)

type Entry struct {
	Path      string
	Repo      string
	RepoRoot  string
	Branch    string
	CreatedAt string
}

func Register(conn *sql.DB, e Entry) error {
	_, err := conn.Exec(
		`INSERT INTO worktrees (path, repo, repo_root, branch, created_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (path) DO UPDATE SET
		   repo = excluded.repo, repo_root = excluded.repo_root,
		   branch = excluded.branch, created_at = excluded.created_at`,
		e.Path, e.Repo, e.RepoRoot, e.Branch, e.CreatedAt)
	return err
}

func Unregister(conn *sql.DB, path string) error {
	_, err := conn.Exec(`DELETE FROM worktrees WHERE path = ?`, path)
	return err
}

func List(conn *sql.DB) ([]Entry, error) {
	rows, err := conn.Query(
		`SELECT path, repo, repo_root, branch, created_at FROM worktrees ORDER BY repo, path`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Entry
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.Path, &e.Repo, &e.RepoRoot, &e.Branch, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func Get(conn *sql.DB, path string) (*Entry, error) {
	var e Entry
	err := conn.QueryRow(
		`SELECT path, repo, repo_root, branch, created_at FROM worktrees WHERE path = ?`, path).
		Scan(&e.Path, &e.Repo, &e.RepoRoot, &e.Branch, &e.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &e, nil
}

type ReconcileResult struct {
	Orphans []string // dirs under worktreesBase not registered in the DB
	Stale   []string // registered paths that no longer exist on disk
}

func Reconcile(conn *sql.DB, worktreesBase string) (ReconcileResult, error) {
	var res ReconcileResult
	entries, err := List(conn)
	if err != nil {
		return res, err
	}
	registered := make(map[string]bool)
	for _, e := range entries {
		registered[e.Path] = true
		if _, err := os.Stat(e.Path); os.IsNotExist(err) {
			res.Stale = append(res.Stale, e.Path)
		}
	}

	dirents, err := os.ReadDir(worktreesBase)
	if err != nil {
		if os.IsNotExist(err) {
			return res, nil
		}
		return res, err
	}
	for _, d := range dirents {
		if !d.IsDir() {
			continue
		}
		p := filepath.Join(worktreesBase, d.Name())
		if !registered[p] {
			res.Orphans = append(res.Orphans, p)
		}
	}
	return res, nil
}
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./internal/registry/ -v`
Expected: PASS all three tests.

- [ ] **Step 5: Commit**

```bash
git add internal/registry/registry.go internal/registry/registry_test.go
git commit --signoff -m "feat(registry): DB-backed worktree registry + disk reconcile"
```

---

### Task 5: shellenv engine + `worktree env` command

**Files:**
- Modify: `internal/env/env.go` (remove file writer, keep kubeconfig helpers)
- Create: `internal/shellenv/shellenv.go`
- Create: `cmd/env.go`
- Test: `internal/shellenv/shellenv_test.go`

**Interfaces:**
- Consumes: `*sql.DB` (Task 1); `ports.Allocate`/`Allocation.Range` (Task 3); `registry.Get` (Task 4); `env.KubeconfigPath` (kept).
- Produces:
  - `func shellenv.Lines(conn *sql.DB, worktreePath string) ([]string, error)` — returns `export KEY=VALUE` lines for the given worktree computed from the DB (empty slice if the path is not a registered worktree — safe to eval anywhere).
  - `cmd/env.go`: `worktree env [path]` prints those lines to stdout; prints nothing and exits 0 when not in a worktree.

- [ ] **Step 1: Write failing test**

Create `internal/shellenv/shellenv_test.go`:
```go
package shellenv

import (
	"path/filepath"
	"strings"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
)

func TestLinesForRegisteredWorktree(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	wt := "/wt/my-branch"
	registry.Register(conn, registry.Entry{
		Path: wt, Repo: "repo", RepoRoot: "/repo", Branch: "my-branch", CreatedAt: "t",
	})
	ports.Allocate(conn, "my-branch") // slot 0 -> 4020-4029

	lines, err := Lines(conn, wt)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(lines, "\n")
	for _, want := range []string{
		"export WORKTREE_PORTS=4020-4029",
		`export WORKTREE_PATH="/wt/my-branch"`,
		"export WORKTREE_TITLE=",
		"export KUBECONFIG=",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in:\n%s", want, joined)
		}
	}
}

func TestLinesEmptyForUnregistered(t *testing.T) {
	conn, _ := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	defer conn.Close()
	lines, err := Lines(conn, "/not/a/worktree")
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 0 {
		t.Fatalf("expected no lines for unregistered path, got %v", lines)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/shellenv/ -v`
Expected: FAIL to compile (`Lines` undefined).

- [ ] **Step 3: Trim `internal/env/env.go`**

Remove `Filename`, `FilePath`, and `Generate`. Keep the `WorktreeEnv` struct, `KubeconfigPath`, `SeedKubeconfig`. Resulting file:
```go
package env

import (
	"fmt"
	"os"
	"path/filepath"
)

type WorktreeEnv struct {
	Ports string
	Title string
	Path  string
	Kube  string
}

func KubeconfigPath(repo, worktreeName string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".kube", fmt.Sprintf("config-%s-%s", repo, worktreeName))
}

func SeedKubeconfig(kubePath string) error {
	if _, err := os.Stat(kubePath); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(kubePath), 0o755); err != nil {
		return err
	}
	src := os.Getenv("KUBECONFIG")
	if src == "" {
		home, _ := os.UserHomeDir()
		src = filepath.Join(home, ".kube", "config")
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return nil
	}
	return os.WriteFile(kubePath, data, 0o600)
}
```
> This will break `cmd/root.go`'s `env.Generate` call — that is repaired in Task 8. Until then the build may fail; run only the package-scoped tests in this task's steps. (The task reviewer is told this build gap is expected and closed in Task 8.)

- [ ] **Step 4: Implement `internal/shellenv/shellenv.go`**

```go
package shellenv

import (
	"database/sql"
	"fmt"
	"path/filepath"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
)

// Lines returns the `export KEY=VALUE` shell lines for the worktree at
// worktreePath, computed live from the DB. It returns an empty slice (no error)
// when the path is not a registered worktree, so the caller can safely eval the
// output from any directory.
func Lines(conn *sql.DB, worktreePath string) ([]string, error) {
	wt, err := registry.Get(conn, worktreePath)
	if err != nil {
		return nil, err
	}
	if wt == nil {
		return nil, nil
	}

	name := filepath.Base(wt.Path)
	alloc, err := ports.Allocate(conn, name) // returns existing allocation if present
	if err != nil {
		return nil, err
	}
	kube := env.KubeconfigPath(wt.Repo, name)

	return []string{
		fmt.Sprintf("export WORKTREE_PORTS=%s", alloc.Range()),
		fmt.Sprintf("export WORKTREE_TITLE=%q", "wt "+wt.Branch),
		fmt.Sprintf("export WORKTREE_PATH=%q", wt.Path),
		fmt.Sprintf("export KUBECONFIG=%q", kube),
	}, nil
}
```

- [ ] **Step 5: Implement `cmd/env.go`**

```go
package cmd

import (
	"fmt"
	"os"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/shellenv"
	"github.com/spf13/cobra"
)

var envCmd = &cobra.Command{
	Use:   "env [path]",
	Short: "Print shell exports for the current (or given) worktree (eval this)",
	Long:  "Prints `export ...` lines computed from the worktree database. Add\n`eval \"$(worktree env)\"` to your shell's chpwd hook. Prints nothing outside a worktree.",
	Args:  cobra.MaximumNArgs(1),
	// Silence usage/errors so a failing eval never spams the shell.
	SilenceUsage:  true,
	SilenceErrors: true,
	RunE:          runEnv,
}

func init() {
	rootCmd.AddCommand(envCmd)
}

func runEnv(cmd *cobra.Command, args []string) error {
	path := "."
	if len(args) == 1 {
		path = args[0]
	}
	abs, err := os.Getwd()
	if err == nil && path == "." {
		path = abs
	}

	conn, err := wdb.Open()
	if err != nil {
		return nil // never break the shell on a DB error
	}
	defer conn.Close()

	lines, err := shellenv.Lines(conn, path)
	if err != nil {
		return nil
	}
	for _, l := range lines {
		fmt.Fprintln(cmd.OutOrStdout(), l)
	}
	return nil
}
```

- [ ] **Step 6: Run to verify pass**

Run: `go test ./internal/shellenv/ ./internal/env/ -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/env/env.go internal/shellenv/shellenv.go cmd/env.go internal/shellenv/shellenv_test.go
git commit --signoff -m "feat(env): worktree env shellenv command replacing .worktree-env file"
```

---

### Task 6: `worktree resources` command group (CC-2 CLI contract)

**Files:**
- Create: `cmd/resources.go`
- Test: `cmd/resources_test.go`

**Interfaces:**
- Consumes: `wdb.Open` (Task 1); `resources.Load/Add/Remove/Unwatch` (Task 2).
- Produces the CC-2 CLI:
  - `worktree resources list [--worktree <path>] [--json]`
  - `worktree resources add <type> <id> [--url <url>] [--related]`
  - `worktree resources unwatch <type> <id> [--worktree <path>]` (soft)
  - `worktree resources remove <type> <id> [--worktree <path>]` (hard)
  - JSON shape: `[{"type":"pr","id":"o/r#1","url":"...","primary":true}]`.
  - A testable pure function `func resourcesJSON(rs []resources.Resource) ([]byte, error)`.

- [ ] **Step 1: Write failing test for the JSON contract**

Create `cmd/resources_test.go`:
```go
package cmd

import (
	"encoding/json"
	"testing"

	"github.com/mturley/worktree/internal/resources"
)

func TestResourcesJSONContract(t *testing.T) {
	rs := []resources.Resource{
		{Type: "pr", ID: "o/r#1", URL: "http://x/1", Related: false},
		{Type: "jira", ID: "RH-2", URL: "http://x/2", Related: true},
	}
	b, err := resourcesJSON(rs)
	if err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d", len(got))
	}
	if got[0]["type"] != "pr" || got[0]["id"] != "o/r#1" || got[0]["primary"] != true {
		t.Fatalf("row0: %+v", got[0])
	}
	if got[1]["primary"] != false {
		t.Fatalf("related resource must be primary=false: %+v", got[1])
	}
	// exact field set — the contract handler binds to
	for _, k := range []string{"type", "id", "url", "primary"} {
		if _, ok := got[0][k]; !ok {
			t.Fatalf("missing field %q", k)
		}
	}
}

func TestResourcesJSONEmptyIsArray(t *testing.T) {
	b, err := resourcesJSON(nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "[]" {
		t.Fatalf("empty must serialize to [], got %s", b)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./cmd/ -run TestResourcesJSON -v`
Expected: FAIL to compile (`resourcesJSON` undefined).

- [ ] **Step 3: Implement `cmd/resources.go`**

```go
package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
	"github.com/spf13/cobra"
)

type resourceJSON struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	URL     string `json:"url"`
	Primary bool   `json:"primary"`
}

func resourcesJSON(rs []resources.Resource) ([]byte, error) {
	out := make([]resourceJSON, 0, len(rs)) // ensures [] not null when empty
	for _, r := range rs {
		out = append(out, resourceJSON{Type: r.Type, ID: r.ID, URL: r.URL, Primary: !r.Related})
	}
	return json.Marshal(out)
}

var (
	resWorktree string
	resJSON     bool
	resURL      string
	resRelated  bool
)

var resourcesCmd = &cobra.Command{
	Use:     "resources",
	Short:   "Manage resources tracked by a worktree",
	GroupID: "worktree",
}

var resourcesListCmd = &cobra.Command{
	Use:   "list",
	Short: "List tracked resources",
	RunE:  runResourcesList,
}

var resourcesAddCmd = &cobra.Command{
	Use:   "add <type> <id>",
	Short: "Track a resource",
	Args:  cobra.ExactArgs(2),
	RunE:  runResourcesAdd,
}

var resourcesUnwatchCmd = &cobra.Command{
	Use:   "unwatch <type> <id>",
	Short: "Soft-unsubscribe from a resource (user tombstone)",
	Args:  cobra.ExactArgs(2),
	RunE:  runResourcesUnwatch,
}

var resourcesRemoveCmd = &cobra.Command{
	Use:   "remove <type> <id>",
	Short: "Hard-remove a resource",
	Args:  cobra.ExactArgs(2),
	RunE:  runResourcesRemove,
}

func init() {
	resourcesListCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesListCmd.Flags().BoolVar(&resJSON, "json", false, "machine-readable JSON output")
	resourcesAddCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesAddCmd.Flags().StringVar(&resURL, "url", "", "resource URL")
	resourcesAddCmd.Flags().BoolVar(&resRelated, "related", false, "mark as related (not primary)")
	resourcesUnwatchCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")
	resourcesRemoveCmd.Flags().StringVar(&resWorktree, "worktree", "", "worktree path (default: cwd)")

	resourcesCmd.AddCommand(resourcesListCmd, resourcesAddCmd, resourcesUnwatchCmd, resourcesRemoveCmd)
	rootCmd.AddCommand(resourcesCmd)
}

func resourceWorktreePath() (string, error) {
	if resWorktree != "" {
		return resWorktree, nil
	}
	return os.Getwd()
}

func runResourcesList(cmd *cobra.Command, args []string) error {
	wt, err := resourceWorktreePath()
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	rs, err := resources.Load(conn, wt)
	if err != nil {
		return err
	}
	if resJSON {
		b, err := resourcesJSON(rs)
		if err != nil {
			return err
		}
		fmt.Fprintln(cmd.OutOrStdout(), string(b))
		return nil
	}
	for _, r := range rs {
		marker := " "
		if r.Related {
			marker = "~"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "%s %s:%s %s\n", marker, r.Type, r.ID, r.URL)
	}
	return nil
}

func runResourcesAdd(cmd *cobra.Command, args []string) error {
	wt, err := resourceWorktreePath()
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	return resources.Add(conn, wt, resources.Resource{
		Type: args[0], ID: args[1], URL: resURL, Related: resRelated,
	})
}

func runResourcesUnwatch(cmd *cobra.Command, args []string) error {
	wt, err := resourceWorktreePath()
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	return resources.Unwatch(conn, wt, args[0], args[1])
}

func runResourcesRemove(cmd *cobra.Command, args []string) error {
	wt, err := resourceWorktreePath()
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	return resources.Remove(conn, wt, args[0], args[1])
}
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./cmd/ -run TestResourcesJSON -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/resources.go cmd/resources_test.go
git commit --signoff -m "feat(cmd): worktree resources list/add/unwatch/remove with --json contract"
```

---

### Task 7: `worktree watcher run` one-shot poller

**Files:**
- Create: `cmd/watcher.go`

**Interfaces:**
- Consumes: `wdb.Open`; `watcherdb.ActiveResources`; the library pollers `github` (`github.Poll(conn, token, resources, logger)`) and `jira` (`jira.Poll(conn, cfg, resources, logger)`); credentials read from `~/.config/watcher/auth.yaml` via the library config package.
- Produces: `worktree watcher run [pr|jira|all]` — a one-shot poll writing events to `watcher_events`. No loop, no scheduler (CC-1).

> This task is intentionally thin. Its purpose is to prove worktree can produce its own timeline data before the Phase 2 UI server owns the interval loop. Credentials come from the shared watcher `auth.yaml`; if absent, the command prints a clear "run watcher auth setup" message and exits non-zero.

- [ ] **Step 1: Confirm the library's poller + config signatures**

Run: `go doc github.com/mturley/watcher/github Poll && go doc github.com/mturley/watcher/jira Poll && go doc github.com/mturley/watcher/config`
Expected: prints the exact `Poll` signatures and the config accessor names. **Use whatever the library actually exports** — adjust the calls below to match (the config package's GitHub token / Jira auth accessors). Do NOT invent names.

- [ ] **Step 2: Implement `cmd/watcher.go`**

```go
package cmd

import (
	"fmt"
	"log"
	"os"

	wdb "github.com/mturley/worktree/internal/db"
	watcherdb "github.com/mturley/watcher/db"
	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	wconfig "github.com/mturley/watcher/config"
	"github.com/spf13/cobra"
)

var watcherCmd = &cobra.Command{
	Use:     "watcher",
	Short:   "Watcher (resource polling) commands",
	GroupID: "worktree",
}

var watcherRunCmd = &cobra.Command{
	Use:   "run [pr|jira|all]",
	Short: "Poll tracked resources once, writing timeline events to the DB",
	Args:  cobra.MaximumNArgs(1),
	RunE:  runWatcherRun,
}

func init() {
	watcherCmd.AddCommand(watcherRunCmd)
	rootCmd.AddCommand(watcherCmd)
}

func runWatcherRun(cmd *cobra.Command, args []string) error {
	which := "all"
	if len(args) == 1 {
		which = args[0]
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()

	logger := log.New(os.Stderr, "watcher: ", 0)
	auth, err := wconfig.Load() // adjust to the real loader name from Step 1
	if err != nil {
		return fmt.Errorf("loading ~/.config/watcher/auth.yaml: %w (run watcher auth setup)", err)
	}

	if which == "pr" || which == "all" {
		prs, err := watcherdb.ActiveResources(conn, "pr")
		if err != nil {
			return err
		}
		if len(prs) > 0 {
			// adjust token accessor to the real one from Step 1
			if err := wgithub.Poll(conn, auth.GitHubToken(), prs, logger); err != nil {
				logger.Printf("github poll: %v", err)
			}
		}
	}
	if which == "jira" || which == "all" {
		issues, err := watcherdb.ActiveResources(conn, "jira")
		if err != nil {
			return err
		}
		if len(issues) > 0 {
			// adjust JiraAuth construction to the real accessor from Step 1
			if err := wjira.Poll(conn, auth.JiraAuth(), issues, logger); err != nil {
				logger.Printf("jira poll: %v", err)
			}
		}
	}
	fmt.Fprintln(cmd.OutOrStdout(), "poll complete")
	return nil
}
```

- [ ] **Step 3: Reconcile with the real library API + build**

Run: `go build ./...`
Fix the `wconfig.Load`/`auth.GitHubToken()`/`auth.JiraAuth()` calls to match the exact exported names discovered in Step 1. Expected: builds clean.

- [ ] **Step 4: Manual smoke (no automated test — needs live creds)**

Document in the commit body that this command was smoke-tested manually against a real tracked PR/issue (or note it's untested if creds unavailable). No unit test — it wraps live network pollers.

- [ ] **Step 5: Commit**

```bash
git add cmd/watcher.go
git commit --signoff -m "feat(cmd): worktree watcher run one-shot poller (pr/jira)"
```

---

### Task 8: Wire creation/deletion + jira/info/open/prune to the DB; register worktrees

**Files:**
- Modify: `cmd/root.go` (`finalizeWorktree`, `detectAndSaveJiraIssues`, `openCmuxWorkspace`, and the two `finalizeWorktree` callers at `cmd/root.go:128`, `:188`)
- Modify: `cmd/delete.go`
- Modify: `cmd/jira.go`
- Modify: `cmd/info.go`
- Modify: `cmd/open.go`
- Delete: `cmd/prune.go` (subsumed by reconcile-based cleanup in Task 9)
- Test: `cmd/root_test.go` (new, for a small extracted helper) — see Step 1

**Interfaces:**
- Consumes: `wdb.Open`; `resources.*` (Task 2, new signatures); `ports.*` (Task 3, new signatures); `registry.Register/Unregister` (Task 4); `env.KubeconfigPath/SeedKubeconfig` (Task 5).
- Produces: worktree creation now (a) allocates a port via the DB, (b) registers the worktree in the `worktrees` table, (c) records resources via the DB, and NO LONGER writes `.worktree-env` or `.git/info/exclude`. Deletion unregisters + releases via the DB.

- [ ] **Step 1: Extract + test a registry-entry helper**

Add to `cmd/root.go` a pure helper and test it. Helper:
```go
// buildRegistryEntry constructs a registry.Entry from a create result.
func buildRegistryEntry(result gitutil.CreateResult, repoRoot, nowRFC3339 string) registry.Entry {
	return registry.Entry{
		Path:      result.Path,
		Repo:      filepath.Base(repoRoot),
		RepoRoot:  repoRoot,
		Branch:    result.Branch,
		CreatedAt: nowRFC3339,
	}
}
```
Test `cmd/root_test.go`:
```go
package cmd

import (
	"testing"

	"github.com/mturley/worktree/internal/gitutil"
)

func TestBuildRegistryEntry(t *testing.T) {
	e := buildRegistryEntry(gitutil.CreateResult{Path: "/wt/a", Branch: "b"}, "/repos/myrepo", "2026-08-11T00:00:00Z")
	if e.Repo != "myrepo" || e.RepoRoot != "/repos/myrepo" || e.Branch != "b" || e.Path != "/wt/a" {
		t.Fatalf("got %+v", e)
	}
}
```
Run: `go test ./cmd/ -run TestBuildRegistryEntry -v` → FAIL (undefined) → implement → PASS.

- [ ] **Step 2: Rewrite `finalizeWorktree` in `cmd/root.go`**

Replace the body (`cmd/root.go:221-280`, the port/env/exclude/resource block) with DB-backed logic. Key changes:
- Open the DB once at the top: `conn, err := wdb.Open()` (warn + continue on error, mirroring existing warning style).
- `alloc, err := ports.Allocate(conn, wtName)` (was `ports.Allocate(cfg.WorktreesBase, wtName)`).
- Keep `env.KubeconfigPath` + `env.SeedKubeconfig`.
- **Delete** the `env.Generate(...)` call and its warning (no more `.worktree-env`).
- **Delete** the `gitutil.AddExcludes(repoRoot)` call and its warning (no more exclude block).
- Register the worktree: `registry.Register(conn, buildRegistryEntry(result, repoRoot, time.Now().UTC().Format(time.RFC3339)))`.
- `resources.Add(conn, result.Path, *primaryResource)` (new signature).
- Keep the printed summary, but change the header line from "Environment variables written to .worktree-env:" to "Environment (via `eval \"$(worktree env)\"`):".

Replacement block:
```go
	repoName := filepath.Base(repoRoot)
	wtName := filepath.Base(result.Path)

	conn, err := wdb.Open()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to open worktree db: %v\n", err)
	}

	var alloc ports.Allocation
	if conn != nil {
		alloc, err = ports.Allocate(conn, wtName)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to allocate port range: %v\n", err)
		}
		if err := registry.Register(conn, buildRegistryEntry(result, repoRoot, time.Now().UTC().Format(time.RFC3339))); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to register worktree: %v\n", err)
		}
	}

	kubePath := env.KubeconfigPath(repoName, wtName)
	if err := env.SeedKubeconfig(kubePath); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to seed kubeconfig: %v\n", err)
	}

	if primaryResource != nil && conn != nil {
		if err := resources.Add(conn, result.Path, *primaryResource); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to save resource: %v\n", err)
		}
	}

	if len(cfg.Jira.Projects) > 0 && conn != nil {
		detectAndSaveJiraIssues(conn, cfg, result, pr)
	}

	if result.Created {
		offerDotfiles(repoRoot, result.Path)
	}

	fmt.Printf("\n  %s\n", ui.Dim("Environment (via eval \"$(worktree env)\"):"))
	fmt.Printf("    WORKTREE_PATH  = %s\n", ui.ShortPath(result.Path))
	fmt.Printf("    WORKTREE_TITLE = wt %s\n", result.Branch)
	fmt.Printf("    WORKTREE_PORTS = %s\n", alloc.Range())
	fmt.Printf("    KUBECONFIG     = %s\n\n", ui.ShortPath(kubePath))

	if conn != nil {
		conn.Close()
	}
```
Add imports to `cmd/root.go`: `time`, `github.com/mturley/worktree/internal/registry`, `wdb "github.com/mturley/worktree/internal/db"`. Remove now-unused `env.Generate` usage.

- [ ] **Step 3: Update `detectAndSaveJiraIssues` and `openCmuxWorkspace` signatures in `cmd/root.go`**

`detectAndSaveJiraIssues` now takes `conn *sql.DB` and calls `resources.Load(conn, result.Path)` / `resources.Add(conn, result.Path, r)`. `openCmuxWorkspace` calls `resources.Load` — open a DB handle inside it (it currently takes `cfg, result`; add a conn open or pass conn). Repoint every `resources.Load(...)` / `resources.OfType(...)` here to the two-arg `Load(conn, path)`.

- [ ] **Step 4: Update `cmd/delete.go`**

Replace `ports.Release(cfg.WorktreesBase, wtName)` with a DB-backed release + unregister:
```go
	conn, err := wdb.Open()
	if err == nil {
		defer conn.Close()
		if err := ports.Release(conn, wtName); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to release port range: %v\n", err)
		} else {
			fmt.Printf("%s Released port range\n", ui.Green("✓"))
		}
		if err := registry.Unregister(conn, wtPath); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to unregister worktree: %v\n", err)
		}
	}
```
Add imports `wdb`, `registry`. Remove the `config`-based `cfg.WorktreesBase` port call.

- [ ] **Step 5: Update `cmd/jira.go`, `cmd/info.go`, `cmd/open.go`**

Each currently calls `resources.Load(wtPath)` / `resources.Add(wtPath, r)` / `resources.Remove(wtPath, ...)`. Open a DB handle at the top of each command's RunE and pass `conn` as the new first arg. Example for `cmd/open.go`:
```go
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	res, err := resources.Load(conn, wtPath)
```
Apply the same pattern to `cmd/jira.go` (`resources.Load`, `resources.Add`, `resources.Remove` — the `Remove` here should stay a **hard** remove, matching prior behavior) and `cmd/info.go` (`resources.Load`).

- [ ] **Step 6: Keep `cmd/prune.go` compiling (minimal)**

`cmd/prune.go` calls the old `ports.Release(cfg.WorktreesBase, ...)` / `ports.LoadAllocations(cfg.WorktreesBase)` and `discovery.Discover`, all of which changed/vanished. Task 9 **deletes** `cmd/prune.go` entirely (its behavior is subsumed by the reconcile-based cleanup). To avoid touching a doomed file twice, delete `cmd/prune.go` **now** as part of this task (move the deletion earlier):
```bash
git rm cmd/prune.go
```
If `prune` is referenced in help text or a test, remove those references. (Task 9 Step 5 then only needs to confirm it's gone.)

- [ ] **Step 7: Build + test**

Run: `go build ./... && go test ./cmd/ ./internal/... -v`
Expected: builds clean; all tests pass. (This is the task that closes the intentional build gap from Task 5.)

- [ ] **Step 8: Manual smoke**

Run in a real repo: create a worktree (`worktree add <branch>`), then:
```bash
worktree resources list --json   # shows the primary resource
worktree env                     # prints exports incl. WORKTREE_PORTS
sqlite3 "$(worktree env >/dev/null; echo)"  # (optional) inspect
```
Confirm no `.worktree-env`, `.worktree-resources`, or `.git/info/exclude` block was written. Delete it (`worktree delete`) and confirm the port slot frees and the registry row is gone.

- [ ] **Step 9: Commit**

```bash
git add cmd/root.go cmd/delete.go cmd/jira.go cmd/info.go cmd/open.go cmd/root_test.go
git rm cmd/prune.go
git commit --signoff -m "feat(cmd): wire create/delete/jira/info/open to the DB; register worktrees; drop prune"
```

---

### Task 9: Discovery pivot — DB-backed list/cleanup + reconcile; drop filesystem scan

**Files:**
- Modify: `internal/discovery/discovery.go` (remove `Discover`/`findGitRepos`/`listWorktrees`; keep `IsInsideWorktree` and the `Worktree` type if still used by list rendering)
- Modify: `cmd/list.go`
- Modify: `cmd/cleanup.go`
- Modify: `internal/config/config.go` (drop `search:`)
- Test: covered by `internal/registry` reconcile test (Task 4) + a `config` test below

**Interfaces:**
- Consumes: `registry.List/Reconcile` (Task 4); `discovery.IsInsideWorktree` (kept).
- Produces: `worktree list` reads the DB registry; `worktree cleanup` uses `registry.Reconcile` to surface orphans/stale and offers removal.

- [ ] **Step 1: Write failing test for config without `search:`**

Add to `internal/config/config_test.go` (create if absent):
```go
package config

import "testing"

func TestDefaultConfigHasNoSearchSection(t *testing.T) {
	cfg := DefaultConfig()
	// Compile-time guarantee: the Search field is gone. This test documents intent;
	// if SearchConfig still exists this file won't compile.
	_ = cfg.WorktreesBase
}
```
> The real signal is that `cfg.Search` no longer compiles anywhere. Removing the field breaks `list.go`/`cleanup.go` until they're reworked in this task.

- [ ] **Step 2: Drop `search:` from `internal/config/config.go`**

Remove `SearchConfig`, the `Search` field, its defaults in `DefaultConfig`, and the `WORKTREE_SEARCH_ROOTS`/`WORKTREE_SEARCH_DEPTH` env overrides + the `cfg.Search.Roots` expand loop in `Load`. Resulting `Config`:
```go
type Config struct {
	WorktreesBase string     `yaml:"worktrees_base"`
	Jira          JiraConfig `yaml:"jira"`
	Editor        string     `yaml:"editor"`
}
```
Trim `applyEnvOverrides` to only `WORKTREES_BASE`.

- [ ] **Step 3: Rewrite `cmd/list.go` to read the registry**

```go
func runList(cmd *cobra.Command, args []string) error {
	conn, err := wdb.Open()
	if err != nil {
		return fmt.Errorf("opening db: %w", err)
	}
	defer conn.Close()

	entries, err := registry.List(conn)
	if err != nil {
		return fmt.Errorf("listing worktrees: %w", err)
	}
	if len(entries) == 0 {
		fmt.Println("No worktrees managed by worktree yet. Create one with `worktree add`.")
		return nil
	}

	cmuxDirs := map[string]bool{}
	if cmux.IsAvailable() {
		if workspaces, err := cmux.ListWorkspaces(); err == nil {
			for _, ws := range workspaces {
				if ws.CurrentDirectory != "" {
					cmuxDirs[ws.CurrentDirectory] = true
				}
			}
		}
	}

	currentRepo := ""
	n := 0
	for _, e := range entries {
		if e.Repo != currentRepo {
			fmt.Printf("\n%s\n", ui.Bold(e.Repo))
			currentRepo = e.Repo
		}
		n++
		missing := ""
		if _, statErr := os.Stat(e.Path); os.IsNotExist(statErr) {
			missing = " " + ui.Red("(missing)")
		}
		cmuxMarker := ""
		if cmuxDirs[e.Path] {
			cmuxMarker = " " + ui.Green("[open]")
		}
		branch := e.Branch
		if branch == "" {
			branch = "(no branch)"
		}
		fmt.Printf("  %s %s %s%s%s\n",
			ui.Dim(fmt.Sprintf("[%d]", n)), ui.Cyan(branch), ui.Dim(ui.ShortPath(e.Path)), missing, cmuxMarker)
	}
	fmt.Println()
	return nil
}
```
Update imports: drop `discovery`, add `os`, `wdb`, `registry`.

- [ ] **Step 4: Rewrite `cmd/cleanup.go` around `registry.Reconcile`**

Replace the `discovery.Discover` scan with:
```go
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()

	res, err := registry.Reconcile(conn, cfg.WorktreesBase)
	if err != nil {
		return err
	}
	if len(res.Stale) == 0 && len(res.Orphans) == 0 {
		fmt.Println("Nothing to clean up.")
		return nil
	}
```
Then present `res.Stale` (registered but gone → offer to unregister + release ports) and `res.Orphans` (on disk but unmanaged → offer to delete the directory). Reuse the existing `readSelections` helper. For each stale path chosen: `registry.Unregister(conn, path)` + `ports.Release(conn, filepath.Base(path))`. For each orphan chosen: `os.RemoveAll(path)` (confirm first). Remove the `discovery`/`gitutil`/`env` imports no longer used; keep `ports`.

- [ ] **Step 5: Confirm `cmd/prune.go` is gone**

`cmd/prune.go` was deleted in Task 8 (its scan-based behavior is subsumed by cleanup's reconcile). Confirm: `test ! -f cmd/prune.go && echo gone`. If it somehow remains, `git rm cmd/prune.go` and remove any help/test references.

- [ ] **Step 6: Trim `internal/discovery/discovery.go`**

Remove `Discover`, `findGitRepos`, `listWorktrees`, `RepoGroup`, and the `Worktree`/`Status` machinery if nothing else references them after Steps 3-5. Keep `IsInsideWorktree`. Run `go vet ./...` to catch unused leftovers.

- [ ] **Step 7: Build + test**

Run: `go build ./... && go test ./... `
Expected: builds clean; all tests pass; no references to `cfg.Search` or `discovery.Discover` remain (`grep -rn "cfg.Search\|discovery.Discover\|findGitRepos" cmd/ internal/` returns nothing).

- [ ] **Step 8: Commit**

```bash
git add internal/config/config.go internal/config/config_test.go cmd/list.go cmd/cleanup.go internal/discovery/discovery.go
git commit --signoff -m "feat(discovery): pivot list/cleanup to the DB registry; drop filesystem scan + search config"
```

---

### Task 10: Remove `.git/info/exclude` management + shellrc cutover to `worktree env`

**Files:**
- Delete: `internal/gitutil/exclude.go`
- Modify: `internal/setup/shellrc.go`
- Modify: `cmd/setup.go` (if it references excludes or the old env source)
- Test: `internal/setup/shellrc_test.go` (new)

**Interfaces:**
- Produces: shellrc snippets that run `eval "$(worktree env)"` on directory change instead of sourcing `.worktree-env`. No code references `.git/info/exclude` anywhere after this task.

- [ ] **Step 1: Confirm exclude is fully unreferenced, then delete**

Run: `grep -rn "AddExcludes\|RemoveExcludes\|info/exclude\|gitutil/exclude" cmd/ internal/`
Expected after Task 8: only `internal/gitutil/exclude.go` itself. Delete it:
```bash
git rm internal/gitutil/exclude.go
```
If any caller still references it, that's a Task 8 miss — fix the caller (remove the call) before deleting.

- [ ] **Step 2: Write failing test for the new shell snippet**

Create `internal/setup/shellrc_test.go`:
```go
package setup

import (
	"strings"
	"testing"
)

func TestZshSnippetUsesWorktreeEnv(t *testing.T) {
	rc := ShellRC{Shell: "zsh"}
	s := rc.snippet()
	if strings.Contains(s, ".worktree-env") || strings.Contains(s, "source ") {
		t.Fatalf("snippet must not source a file:\n%s", s)
	}
	if !strings.Contains(s, `eval "$(worktree env)"`) {
		t.Fatalf("snippet must eval worktree env:\n%s", s)
	}
}

func TestBashAndFishSnippetsEvalWorktreeEnv(t *testing.T) {
	for _, sh := range []string{"bash", "fish"} {
		s := ShellRC{Shell: sh}.snippet()
		if !strings.Contains(s, "worktree env") {
			t.Fatalf("%s snippet must call worktree env:\n%s", sh, s)
		}
	}
}
```

- [ ] **Step 3: Run to verify failure**

Run: `go test ./internal/setup/ -v`
Expected: FAIL (snippets still source `.worktree-env`).

- [ ] **Step 4: Update the snippets in `internal/setup/shellrc.go`**

```go
const zshSnippet = `# BEGIN worktree managed
# Load worktree environment when entering a worktree directory
_worktree_env_hook() {
  eval "$(worktree env 2>/dev/null)"
}
if [[ -z "$_WORKTREE_CHPWD_REGISTERED" ]]; then
  autoload -Uz add-zsh-hook
  add-zsh-hook chpwd _worktree_env_hook
  _WORKTREE_CHPWD_REGISTERED=1
  _worktree_env_hook
fi
# END worktree managed`

const bashSnippet = `# BEGIN worktree managed
# Load worktree environment on each prompt
_worktree_env_hook() {
  eval "$(worktree env 2>/dev/null)"
}
case "$PROMPT_COMMAND" in
  *_worktree_env_hook*) ;;
  *) PROMPT_COMMAND="_worktree_env_hook${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
esac
# END worktree managed`

const fishSnippet = `# BEGIN worktree managed
# Load worktree environment when the directory changes
function _worktree_env_hook --on-variable PWD
  eval (worktree env 2>/dev/null)
end
_worktree_env_hook
# END worktree managed`
```
> bash has no `chpwd`; the original sourced on every shellrc load. Using `PROMPT_COMMAND` runs the eval on each prompt (idempotent + cheap once the cold-start note below is satisfied). Also update `Description()` to say "Load worktree env via `worktree env` in %s".

- [ ] **Step 5: Update `cmd/setup.go` if needed**

Run: `grep -n "worktree-env\|exclude\|Generate" cmd/setup.go`. Remove any messaging about `.worktree-env` file sourcing; the shellrc install path is unchanged (still `ShellRC.Install()`).

- [ ] **Step 6: Build + test**

Run: `go build ./... && go test ./... `
Expected: builds clean, all tests pass; `grep -rn "worktree-env\|info/exclude" cmd/ internal/` returns nothing (except possibly historical comments — remove those too).

- [ ] **Step 7: Commit**

```bash
git add internal/setup/shellrc.go internal/setup/shellrc_test.go cmd/setup.go
git rm internal/gitutil/exclude.go
git commit --signoff -m "feat(setup): shellrc evals worktree env; remove .git/info/exclude management"
```

---

### Task 11: Register worktree as a watcher ConsumerRegistry entry at setup

**Files:**
- Modify: `cmd/setup.go`
- Test: none automated (small wiring; verified via manual smoke) — but add a guard test for the helper below.
- Test: `cmd/setup_registration_test.go` (for the pure DB-path helper)

**Interfaces:**
- Consumes: `wdb.Path()` (Task 1); the watcher config API — `wconfig.Load(path)` returns `*wconfig.Config`, `(*Config).RegisterConsumer(name, dbPath string)`, `(*Config).Save(path)`, `wconfig.DefaultPath()` (all verified in `github.com/mturley/watcher/config`).
- Produces: after `worktree setup`, `~/.config/watcher/auth.yaml` has a consumer entry `worktree -> <worktree db path>` (forward-looking per CC-1; the poll fan-out that would consume it is not built yet).

> Rationale (roadmap CC-1): worktree keeps its own DB + in-process polling, but should *register itself* in the shared ConsumerRegistry now — cheap and forward-looking — so a future unified-poller phase can find it. This is not load-bearing for anything else in Phase 1.

- [ ] **Step 1: Write a failing guard test for the consumer name constant**

Create `cmd/setup_registration_test.go`:
```go
package cmd

import "testing"

func TestConsumerName(t *testing.T) {
	if consumerName != "worktree" {
		t.Fatalf("consumer name must be stable %q, got %q", "worktree", consumerName)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./cmd/ -run TestConsumerName -v`
Expected: FAIL (undefined `consumerName`).

- [ ] **Step 3: Add registration to `cmd/setup.go`**

Add the constant and a helper, and call it from setup's RunE (after the shellrc install, best-effort — a failure here must not fail setup):
```go
const consumerName = "worktree"

// registerWatcherConsumer records worktree's DB in the shared watcher
// ConsumerRegistry (~/.config/watcher/auth.yaml). Best-effort: forward-looking
// per CC-1, not required by any Phase 1 feature.
func registerWatcherConsumer() error {
	path := wconfig.DefaultPath()
	cfg, err := wconfig.Load(path) // returns a zero-value config if the file is absent
	if err != nil {
		return err
	}
	cfg.RegisterConsumer(consumerName, wdb.Path())
	return cfg.Save(path)
}
```
Call site in setup's RunE:
```go
	if err := registerWatcherConsumer(); err != nil {
		fmt.Fprintf(os.Stderr, "Note: could not register worktree in watcher consumer registry: %v\n", err)
	}
```
Add imports: `wconfig "github.com/mturley/watcher/config"`, `wdb "github.com/mturley/worktree/internal/db"`.

> Verified against `github.com/mturley/watcher/config`: `Load(path)` returns `&Config{}, nil` when the file is absent (no guard needed), and `Save(path)` writes it `0600` creating the parent `0700`. **Caveat:** `Load` returns an *error* if an existing `auth.yaml` is group/world-readable (`perm&0o077 != 0`). If registration fails with that error, the best-effort call surfaces the chmod hint to stderr and setup still succeeds — do NOT swallow the message. The registry map serializes under the top-level YAML key `consumers:` (`ConsumerRegistry map[string]Consumer \`yaml:"consumers,omitempty"\``), and each `Consumer` is `{ db: <path> }`. So the smoke check in Step 5 looks for `consumers:` → `worktree:` → `db:`.

- [ ] **Step 4: Run to verify pass + build**

Run: `go test ./cmd/ -run TestConsumerName -v && go build ./...`
Expected: PASS, builds clean.

- [ ] **Step 5: Manual smoke**

Run `worktree setup`, then inspect `~/.config/watcher/auth.yaml` — confirm a `consumers: { worktree: { db: <path> } }` entry pointing at the worktree DB path. Confirm existing handler/github/jira/slack entries are preserved (round-trip load+save must not drop them).

- [ ] **Step 6: Commit**

```bash
git add cmd/setup.go cmd/setup_registration_test.go
git commit --signoff -m "feat(setup): register worktree in the watcher consumer registry"
```

---

### Task 12: Cold-start measurement gate (PC-1 decision point)

**Files:**
- Create: `docs/superpowers/notes/phase1-env-coldstart.md` (measurement record)

**Interfaces:** none (measurement + decision only).

> Per the locked decision: Phase 1 ships `worktree env` in the main binary and *measures* cold start; the separate `worktree-env` binary is deferred unless the measured time is bad. This task records the measurement and the go/no-go.

- [ ] **Step 1: Build the release binary**

Run: `make build`
Expected: `bin/worktree` exists.

- [ ] **Step 2: Measure `worktree env` cold start**

Run (outside a worktree, so it does the DB-open + registry miss path — the common `cd` case):
```bash
cd /tmp
for i in 1 2 3 4 5; do /usr/bin/time -p ./bin/worktree env >/dev/null; done 2>&1 | grep real
```
Also measure inside a registered worktree (the DB-hit path). Record all `real` times.

- [ ] **Step 3: Record + decide**

Write `docs/superpowers/notes/phase1-env-coldstart.md` with: the measured times (outside/inside a worktree), the machine, and a verdict:
- **≤ ~50ms:** single binary is fine — mark the separate `worktree-env` binary **deferred (not needed)**.
- **> ~50ms:** file a follow-up task/issue for a minimal `worktree-env` binary (DB read + print exports, no cobra/UI deps) invoked by the shellrc eval, and note the shellrc would call `worktree-env` instead of `worktree env`.

Include the raw numbers so the decision is auditable.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes/phase1-env-coldstart.md
git commit --signoff -m "docs: record worktree env cold-start measurement + separate-binary decision"
```

---

### Task 13: Update project docs (CLAUDE.md, design proposal) for the DB model

**Files:**
- Modify: `.claude/CLAUDE.md` (project structure list)
- Modify: `docs/design-proposal.md` (if it describes the file-based model)
- Modify: `README.md` (if present; setup instructions mention `.worktree-env`)

**Interfaces:** none (docs).

- [ ] **Step 1: Audit docs for stale file-model references**

Run: `grep -rn "worktree-resources\|worktree-env\|port-ranges\|info/exclude\|search roots\|discovery" .claude/ docs/ README.md 2>/dev/null`

- [ ] **Step 2: Update `.claude/CLAUDE.md`**

In the "Project Structure" list, add `db`, `registry`, `shellenv` to the `internal/` package list and note resources/ports/discovery are now DB-backed. Update any Build & Test notes if a second binary was added (it wasn't, per Task 11 default).

- [ ] **Step 3: Update `docs/design-proposal.md` + README**

Replace descriptions of `.worktree-resources`/`.worktree-env`/`.port-ranges`/filesystem discovery with the DB model: a SQLite DB at `${XDG_DATA_HOME:-~/.local/share}/worktree/worktree.db`, `worktree env` shellenv command, DB-backed list/cleanup. Note the CC-2 `worktree resources ... --json` contract for handler.

- [ ] **Step 4: Commit**

```bash
git add .claude/CLAUDE.md docs/design-proposal.md README.md
git commit --signoff -m "docs: describe the DB-backed worktree model + resources --json contract"
```

---

## Phase 1 completion criteria

- `worktree add` creates a worktree that is registered in the DB, has a DB port allocation, a DB primary resource, and writes NO `.worktree-*` files and NO `.git/info/exclude` block.
- `worktree resources list --json` emits the exact CC-2 contract.
- `worktree resources unwatch` (soft) and `remove` (hard) behave distinctly (verified by tests).
- `worktree env` prints exports from the DB and is safe to eval outside a worktree; shellrc uses it.
- `worktree list` and `worktree cleanup` are DB-backed; `worktree cleanup` reconciles disk vs DB.
- `worktree watcher run` produces timeline events into `watcher_events`.
- No code references `.worktree-resources`, `.worktree-env`, `.port-ranges`, `.git/info/exclude`, `cfg.Search`, or `discovery.Discover`.
- `make build` and `make test` are green.
- Cold-start measurement recorded; separate-binary decision made.

## Out of scope (later phases)
- The Mantine UI + interval polling loop (Phase 2).
- Slack (Phases 3-4).
- Handler consuming the `--json` contract (Phase 5).
- Sourcing jira/github creds from the shared `~/.config/watcher/auth.yaml` instead of worktree `config.yaml` (roadmap follow-up; not P1-blocking).
