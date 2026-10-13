# Watcher Log Modal + Per-Resource Poll Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Watcher log" button beside every activity refresh button opens a modal with a persisted, live log of watcher HTTP/poll activity and a per-resource last-poll status table.

**Architecture:** The watcher library (`~/git/watcher`) gains three tables, a `polllog` package (an instrumented `http.RoundTripper`, a body sanitizer, context tagging), per-resource outcome recording in all three pollers, and self-pruning; it is released as v0.13.0. worktree re-pins and adds two read-only endpoints (`/api/watchers/resources`, `/api/watchers/log`) consumed only by a modal that fetches nothing until opened.

**Tech Stack:** Go 1.25, SQLite (modernc), net/http; React + Mantine + TanStack Query + Vitest.

**Spec:** `docs/superpowers/specs/2026-10-13-watcher-log-modal-design.md`

## Global Constraints

- Library release version: **v0.13.0**; schema version bumps **5 → 6**.
- Pruning: **7 days** and **50,000 rows**, run at the end of every `Poll`.
- Sanitized bodies/messages capped at **500 runes** (ellipsis included).
- Endpoint recorded as `req.URL.Host + req.URL.Path` — **never** the query string; request headers are never read.
- Log timestamps use the fixed-width UTC format `2006-01-02T15:04:05.000000Z` (lexically sortable).
- `validate.go` (credential checks) and `github/summaries.go` (linked-resources fetch, not polling) are **not** instrumented. Interactive Slack traffic is **not** logged.
- No new requests on any page unless the modal is open. `/api/stream`, `/api/watchers`, and existing page queries are unchanged.
- Modal polling: log every **3 s** (`after_id`), resource status every **10 s**. Log page size default **200**, max **500**.
- Library work is committed on `~/git/watcher` `main` (the repo's documented release flow). worktree work is on branch `watcher-log-modal`.
- Commits use `git commit --signoff` and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git add -A`/`.`.
- **Pushing requires Mike's explicit approval** (plan approval covers commits only). Task 8 stops and asks.
- worktree subscriptions are keyed by `wdb.Subscriber(path)` — never a raw `"worktree:"+path`.

## Review Focus

1. A response whose body the Transport buffered (non-2xx) or wrapped (2xx) must still decode normally for the poller — pinned in Task 4 (`TestTransport_BodyStillReadable`).
2. A failing log write (DB closed/locked) must never fail the HTTP request or the poll — pinned in Task 4 (`TestTransport_LogWriteFailureDoesNotFailRequest`).
3. Slack resource IDs contain `:` (`C1:1699…`); `resource=slack:C1:1699…` must split on the first colon only — pinned in Task 10 (`TestWatchedResources_SlackIDWithColon`).
4. A scoped log view must include only *untagged* poll rows of the scope's sources, never other resources' rows of the same source — pinned in Task 2 (`TestQueryPollLog_ResourceScopeIncludesSameSourcePollRows`).
5. Closing the modal must stop all intervals; reopening must start fresh — pinned in Task 13 (`stops requesting after close`).

---

## Part A — watcher library (`~/git/watcher`)

All commands in Part A run from `~/git/watcher`.

### Task 1: Schema v6 — poll log and per-resource status tables

**Files:**
- Modify: `db/schema.go` (bump `CurrentSchemaVersion`, extend `managedTables`, `managedColumns`, `schemaDDL`)
- Test: `db/migrate_test.go`

**Interfaces:**
- Produces: tables `watcher_resource_poll_status`, `watcher_poll_log`, `watcher_poll_log_resources` (DDL below); `CurrentSchemaVersion == 6`.

- [ ] **Step 1: Write the failing test** — append to `db/migrate_test.go`:

```go
func TestMigrateV6AddsPollLogTables(t *testing.T) {
	c := mem(t)
	if err := Migrate(c); err != nil {
		t.Fatal(err)
	}
	for _, tbl := range []string{"watcher_resource_poll_status", "watcher_poll_log", "watcher_poll_log_resources"} {
		ok, err := tableExists(c, tbl)
		if err != nil || !ok {
			t.Fatalf("table %s missing (err=%v)", tbl, err)
		}
	}
	if !hasIndex(t, c, "idx_watcher_poll_log_ts") || !hasIndex(t, c, "idx_watcher_poll_log_resources_res") {
		t.Fatal("poll log indexes missing")
	}
	v, err := SchemaVersion(c)
	if err != nil || v != 6 {
		t.Fatalf("version = %d (err=%v), want 6", v, err)
	}
}

func TestMigrateV5DatabaseUpgradesToV6(t *testing.T) {
	c := mem(t)
	if err := Migrate(c); err != nil {
		t.Fatal(err)
	}
	// Simulate a v5 database: drop the new tables and rewind the version.
	for _, tbl := range []string{"watcher_poll_log_resources", "watcher_poll_log", "watcher_resource_poll_status"} {
		if _, err := c.Exec("DROP TABLE " + tbl); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := c.Exec("UPDATE watcher_schema_version SET version = 5"); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(c); err != nil {
		t.Fatalf("Migrate v5->v6: %v", err)
	}
	if ok, _ := tableExists(c, "watcher_poll_log"); !ok {
		t.Fatal("watcher_poll_log not created on upgrade")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./db -run 'TestMigrateV6|TestMigrateV5Database' -v`
Expected: FAIL (`table watcher_resource_poll_status missing`).

- [ ] **Step 3: Implement** in `db/schema.go`:

Append to the version comment and bump:

```go
// Bumped to 6 to add watcher_resource_poll_status, watcher_poll_log and
// watcher_poll_log_resources (the watcher log). Purely additive tables; the
// bump is required for the same short-circuit reason as v3.
const CurrentSchemaVersion = 6
```

Add `"watcher_resource_poll_status", "watcher_poll_log", "watcher_poll_log_resources"` to `managedTables`, and to `managedColumns`:

```go
	"watcher_resource_poll_status": {
		"resource_type", "resource_id", "last_attempt", "last_success",
		"last_error", "last_error_message", "last_detail",
	},
	"watcher_poll_log": {
		"id", "ts", "source", "level", "kind", "message", "method",
		"endpoint", "http_status", "duration_ms", "bytes", "error_body",
	},
	"watcher_poll_log_resources": {"log_id", "resource_type", "resource_id"},
```

Append to `schemaDDL` (before the index block):

```sql
CREATE TABLE IF NOT EXISTS watcher_resource_poll_status (
	resource_type TEXT NOT NULL,
	resource_id TEXT NOT NULL,
	last_attempt TEXT,
	last_success TEXT,
	last_error TEXT,
	last_error_message TEXT,
	last_detail TEXT,
	PRIMARY KEY (resource_type, resource_id)
);

CREATE TABLE IF NOT EXISTS watcher_poll_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts TEXT NOT NULL,
	source TEXT NOT NULL,
	level TEXT NOT NULL,
	kind TEXT NOT NULL,
	message TEXT NOT NULL,
	method TEXT,
	endpoint TEXT,
	http_status INTEGER,
	duration_ms INTEGER,
	bytes INTEGER,
	error_body TEXT
);

CREATE TABLE IF NOT EXISTS watcher_poll_log_resources (
	log_id INTEGER NOT NULL REFERENCES watcher_poll_log(id) ON DELETE CASCADE,
	resource_type TEXT NOT NULL,
	resource_id TEXT NOT NULL,
	PRIMARY KEY (log_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_watcher_poll_log_ts ON watcher_poll_log (ts);
CREATE INDEX IF NOT EXISTS idx_watcher_poll_log_source ON watcher_poll_log (source, id);
CREATE INDEX IF NOT EXISTS idx_watcher_poll_log_resources_res
	ON watcher_poll_log_resources (resource_type, resource_id, log_id);
```

Note: `AUTOINCREMENT` creates SQLite's internal `sqlite_sequence` table. If `checkForCollisions` or any test enumerates all tables with a `watcher_` prefix only, it is unaffected; if a test asserts the *full* table list of the DB, add `sqlite_sequence` to its expectations.

- [ ] **Step 4: Run the full db suite**

Run: `go test ./db/... -v 2>&1 | tail -30`
Expected: PASS (including existing `TestMigrateSetsVersion` — update its expected version to 6 if it hard-codes 5).

- [ ] **Step 5: Commit**

```bash
git add db/schema.go db/migrate_test.go
git commit --signoff -m "feat(db): schema v6 adds watcher poll log and per-resource poll status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Poll log storage — insert, query, prune

**Files:**
- Create: `db/polllog.go`
- Test: `db/polllog_test.go`

**Interfaces:**
- Consumes: Task 1 tables.
- Produces:

```go
const PollLogTSFormat = "2006-01-02T15:04:05.000000Z"

type PollLogEntry struct {
	ID         int64
	TS         string // PollLogTSFormat; InsertPollLog fills it when empty
	Source     string // github | jira | slack
	Level      string // info | warn | error
	Kind       string // poll | http | resource
	Message    string
	Method     string
	Endpoint   string
	HTTPStatus int
	DurationMS int
	Bytes      int64
	ErrorBody  string
	Resources  []watcher.Resource // Type + ID only
}

type PollLogQuery struct {
	Sources        []string           // empty = all
	MinLevel       string             // "" or "info" = all; "warn" = warn+error; "error"
	ResourceScoped bool               // true = filter by Resources (even if empty)
	Resources      []watcher.Resource
	AfterID        int64              // > 0: id > AfterID
	BeforeID       int64              // > 0: id < BeforeID
	Limit          int                // <= 0 → 200
}

func SourceForType(resourceType string) string // "pr"→"github", else identity
func InsertPollLog(conn *sql.DB, e PollLogEntry) (int64, error)
func QueryPollLog(conn *sql.DB, q PollLogQuery) (entries []PollLogEntry, hasMore bool, err error)
func PrunePollLog(conn *sql.DB, maxAge time.Duration, maxRows int) error
```

- [ ] **Step 1: Write the failing tests** — `db/polllog_test.go`:

```go
package db

import (
	"testing"
	"time"

	"github.com/mturley/watcher"
)

func migrated(t *testing.T) *sql.DB {
	t.Helper()
	c := mem(t)
	if err := Migrate(c); err != nil {
		t.Fatal(err)
	}
	return c
}

var (
	prA   = watcher.Resource{Type: "pr", ID: "o/r#1"}
	prB   = watcher.Resource{Type: "pr", ID: "o/r#2"}
	jiraA = watcher.Resource{Type: "jira", ID: "ABC-1"}
)

func ins(t *testing.T, c *sql.DB, e PollLogEntry) int64 {
	t.Helper()
	id, err := InsertPollLog(c, e)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func ids(es []PollLogEntry) []int64 {
	out := make([]int64, len(es))
	for i, e := range es {
		out[i] = e.ID
	}
	return out
}

func TestInsertPollLog_RoundTripWithResources(t *testing.T) {
	c := migrated(t)
	id := ins(t, c, PollLogEntry{Source: "github", Level: "error", Kind: "http",
		Message: "POST api.github.com/graphql → 504", Method: "POST",
		Endpoint: "api.github.com/graphql", HTTPStatus: 504, DurationMS: 12300,
		Bytes: 1234, ErrorBody: "Unicorn! · GitHub", Resources: []watcher.Resource{prA, prB}})
	got, _, err := QueryPollLog(c, PollLogQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != id {
		t.Fatalf("got %+v", got)
	}
	e := got[0]
	if e.HTTPStatus != 504 || e.ErrorBody != "Unicorn! · GitHub" || e.Bytes != 1234 || len(e.Resources) != 2 {
		t.Fatalf("bad round trip: %+v", e)
	}
	if _, err := time.Parse(PollLogTSFormat, e.TS); err != nil {
		t.Fatalf("TS %q not in PollLogTSFormat: %v", e.TS, err)
	}
}

func TestQueryPollLog_NewestFirstCursorsAndHasMore(t *testing.T) {
	c := migrated(t)
	var all []int64
	for i := 0; i < 5; i++ {
		all = append(all, ins(t, c, PollLogEntry{Source: "jira", Level: "info", Kind: "http", Message: "x"}))
	}
	got, more, _ := QueryPollLog(c, PollLogQuery{Limit: 2})
	if want := []int64{all[4], all[3]}; !equalInt64(ids(got), want) || !more {
		t.Fatalf("page1 = %v more=%v, want %v true", ids(got), more, want)
	}
	got, more, _ = QueryPollLog(c, PollLogQuery{Limit: 10, BeforeID: all[3]})
	if want := []int64{all[2], all[1], all[0]}; !equalInt64(ids(got), want) || more {
		t.Fatalf("older = %v more=%v", ids(got), more)
	}
	got, _, _ = QueryPollLog(c, PollLogQuery{AfterID: all[2]})
	if want := []int64{all[4], all[3]}; !equalInt64(ids(got), want) {
		t.Fatalf("newer = %v", ids(got))
	}
}

func TestQueryPollLog_SourceAndLevelFilters(t *testing.T) {
	c := migrated(t)
	ins(t, c, PollLogEntry{Source: "github", Level: "info", Kind: "poll", Message: "a"})
	w := ins(t, c, PollLogEntry{Source: "github", Level: "warn", Kind: "poll", Message: "b"})
	e := ins(t, c, PollLogEntry{Source: "jira", Level: "error", Kind: "http", Message: "c"})
	got, _, _ := QueryPollLog(c, PollLogQuery{MinLevel: "warn"})
	if want := []int64{e, w}; !equalInt64(ids(got), want) {
		t.Fatalf("warn+ = %v", ids(got))
	}
	got, _, _ = QueryPollLog(c, PollLogQuery{MinLevel: "warn", Sources: []string{"github"}})
	if want := []int64{w}; !equalInt64(ids(got), want) {
		t.Fatalf("github warn+ = %v", ids(got))
	}
}

func TestQueryPollLog_ResourceScopeIncludesSameSourcePollRows(t *testing.T) {
	c := migrated(t)
	ghStart := ins(t, c, PollLogEntry{Source: "github", Level: "info", Kind: "poll", Message: "github poll started"})
	jiraStart := ins(t, c, PollLogEntry{Source: "jira", Level: "info", Kind: "poll", Message: "jira poll started"})
	mine := ins(t, c, PollLogEntry{Source: "github", Level: "info", Kind: "http", Message: "batch", Resources: []watcher.Resource{prA, prB}})
	other := ins(t, c, PollLogEntry{Source: "github", Level: "error", Kind: "resource", Message: "B failed", Resources: []watcher.Resource{prB}})
	_ = jiraStart
	_ = other
	got, _, err := QueryPollLog(c, PollLogQuery{ResourceScoped: true, Resources: []watcher.Resource{prA}})
	if err != nil {
		t.Fatal(err)
	}
	if want := []int64{mine, ghStart}; !equalInt64(ids(got), want) {
		t.Fatalf("scoped = %v, want %v (no jira poll row, no prB-only row)", ids(got), want)
	}
	got, _, _ = QueryPollLog(c, PollLogQuery{ResourceScoped: true})
	if len(got) != 0 {
		t.Fatalf("empty scope should return nothing, got %v", ids(got))
	}
}

func TestPrunePollLog_ByAgeAndCount(t *testing.T) {
	c := migrated(t)
	old := time.Now().UTC().Add(-8 * 24 * time.Hour).Format(PollLogTSFormat)
	oldID := ins(t, c, PollLogEntry{TS: old, Source: "github", Level: "info", Kind: "http", Message: "old", Resources: []watcher.Resource{prA}})
	var kept []int64
	for i := 0; i < 4; i++ {
		kept = append(kept, ins(t, c, PollLogEntry{Source: "github", Level: "info", Kind: "http", Message: "new", Resources: []watcher.Resource{prA}}))
	}
	if err := PrunePollLog(c, 7*24*time.Hour, 3); err != nil {
		t.Fatal(err)
	}
	got, _, _ := QueryPollLog(c, PollLogQuery{})
	if want := []int64{kept[3], kept[2], kept[1]}; !equalInt64(ids(got), want) {
		t.Fatalf("after prune = %v, want %v", ids(got), want)
	}
	var orphans int
	c.QueryRow(`SELECT COUNT(*) FROM watcher_poll_log_resources WHERE log_id NOT IN (SELECT id FROM watcher_poll_log)`).Scan(&orphans)
	if orphans != 0 {
		t.Fatalf("%d orphan join rows", orphans)
	}
	next := ins(t, c, PollLogEntry{Source: "github", Level: "info", Kind: "http", Message: "after"})
	if next <= kept[3] || next == oldID {
		t.Fatalf("id reused: %d", next)
	}
}

func equalInt64(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
```

(Add `"database/sql"` to the imports.)

- [ ] **Step 2: Run to verify failure**

Run: `go test ./db -run 'PollLog' -v`
Expected: FAIL (undefined: `InsertPollLog`).

- [ ] **Step 3: Implement** `db/polllog.go`:

```go
package db

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/mturley/watcher"
)

// PollLogTSFormat is fixed-width so ts sorts and compares lexically (RFC3339Nano
// trims trailing zeros and would not).
const PollLogTSFormat = "2006-01-02T15:04:05.000000Z"

// PollLogEntry is one row of the watcher log. See the watcher log design spec
// in the worktree repo for what each kind means.
type PollLogEntry struct {
	ID         int64
	TS         string
	Source     string
	Level      string
	Kind       string
	Message    string
	Method     string
	Endpoint   string
	HTTPStatus int
	DurationMS int
	Bytes      int64
	ErrorBody  string
	Resources  []watcher.Resource
}

// PollLogQuery filters QueryPollLog. ResourceScoped distinguishes "no resource
// filter" from "filter to this (possibly empty) set".
type PollLogQuery struct {
	Sources        []string
	MinLevel       string
	ResourceScoped bool
	Resources      []watcher.Resource
	AfterID        int64
	BeforeID       int64
	Limit          int
}

// SourceForType maps a resource type to the poller (log source) that polls it.
func SourceForType(resourceType string) string {
	if resourceType == "pr" {
		return "github"
	}
	return resourceType
}

func levelsAtLeast(min string) []string {
	switch min {
	case "warn":
		return []string{"warn", "error"}
	case "error":
		return []string{"error"}
	default:
		return nil
	}
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullInt(n int64) any {
	if n == 0 {
		return nil
	}
	return n
}

// InsertPollLog writes one log row and its resource tags in one transaction.
func InsertPollLog(conn *sql.DB, e PollLogEntry) (int64, error) {
	if e.TS == "" {
		e.TS = time.Now().UTC().Format(PollLogTSFormat)
	}
	tx, err := conn.Begin()
	if err != nil {
		return 0, fmt.Errorf("begin poll log insert: %w", err)
	}
	defer tx.Rollback()
	res, err := tx.Exec(`INSERT INTO watcher_poll_log
		(ts, source, level, kind, message, method, endpoint, http_status, duration_ms, bytes, error_body)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.TS, e.Source, e.Level, e.Kind, e.Message, nullStr(e.Method), nullStr(e.Endpoint),
		nullInt(int64(e.HTTPStatus)), nullInt(int64(e.DurationMS)), nullInt(e.Bytes), nullStr(e.ErrorBody))
	if err != nil {
		return 0, fmt.Errorf("insert poll log: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	for _, r := range e.Resources {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO watcher_poll_log_resources (log_id, resource_type, resource_id) VALUES (?, ?, ?)`,
			id, r.Type, r.ID); err != nil {
			return 0, fmt.Errorf("insert poll log resource: %w", err)
		}
	}
	return id, tx.Commit()
}

// QueryPollLog returns matching entries newest first, plus whether more rows
// exist beyond Limit in the same direction.
func QueryPollLog(conn *sql.DB, q PollLogQuery) ([]PollLogEntry, bool, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = 200
	}
	var where []string
	var args []any
	if len(q.Sources) > 0 {
		where = append(where, "l.source IN ("+placeholders(len(q.Sources))+")")
		for _, s := range q.Sources {
			args = append(args, s)
		}
	}
	if lv := levelsAtLeast(q.MinLevel); lv != nil {
		where = append(where, "l.level IN ("+placeholders(len(lv))+")")
		for _, s := range lv {
			args = append(args, s)
		}
	}
	if q.AfterID > 0 {
		where = append(where, "l.id > ?")
		args = append(args, q.AfterID)
	}
	if q.BeforeID > 0 {
		where = append(where, "l.id < ?")
		args = append(args, q.BeforeID)
	}
	if q.ResourceScoped {
		if len(q.Resources) == 0 {
			return nil, false, nil
		}
		var match []string
		sources := map[string]bool{}
		for _, r := range q.Resources {
			match = append(match, "(resource_type = ? AND resource_id = ?)")
			args = append(args, r.Type, r.ID)
			sources[SourceForType(r.Type)] = true
		}
		var srcList []string
		for s := range sources {
			srcList = append(srcList, s)
		}
		clause := "(l.id IN (SELECT log_id FROM watcher_poll_log_resources WHERE " + strings.Join(match, " OR ") + ")" +
			" OR (l.kind = 'poll' AND l.source IN (" + placeholders(len(srcList)) + ")" +
			" AND NOT EXISTS (SELECT 1 FROM watcher_poll_log_resources x WHERE x.log_id = l.id)))"
		for _, s := range srcList {
			args = append(args, s)
		}
		where = append(where, clause)
	}
	sqlStr := `SELECT l.id, l.ts, l.source, l.level, l.kind, l.message,
		COALESCE(l.method,''), COALESCE(l.endpoint,''), COALESCE(l.http_status,0),
		COALESCE(l.duration_ms,0), COALESCE(l.bytes,0), COALESCE(l.error_body,'')
		FROM watcher_poll_log l`
	if len(where) > 0 {
		sqlStr += " WHERE " + strings.Join(where, " AND ")
	}
	sqlStr += " ORDER BY l.id DESC LIMIT ?"
	args = append(args, limit+1)
	rows, err := conn.Query(sqlStr, args...)
	if err != nil {
		return nil, false, fmt.Errorf("query poll log: %w", err)
	}
	var out []PollLogEntry
	for rows.Next() {
		var e PollLogEntry
		if err := rows.Scan(&e.ID, &e.TS, &e.Source, &e.Level, &e.Kind, &e.Message,
			&e.Method, &e.Endpoint, &e.HTTPStatus, &e.DurationMS, &e.Bytes, &e.ErrorBody); err != nil {
			rows.Close()
			return nil, false, err
		}
		out = append(out, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	// Ascending queries for AfterID still return newest first (ORDER BY id DESC);
	// callers merge by id. Attach resource tags.
	for i := range out {
		rs, err := conn.Query(`SELECT resource_type, resource_id FROM watcher_poll_log_resources WHERE log_id = ? ORDER BY resource_type, resource_id`, out[i].ID)
		if err != nil {
			return nil, false, err
		}
		for rs.Next() {
			var r watcher.Resource
			if err := rs.Scan(&r.Type, &r.ID); err != nil {
				rs.Close()
				return nil, false, err
			}
			out[i].Resources = append(out[i].Resources, r)
		}
		rs.Close()
	}
	return out, more, nil
}

// PrunePollLog deletes rows older than maxAge, then the oldest rows beyond
// maxRows, along with their resource tags.
func PrunePollLog(conn *sql.DB, maxAge time.Duration, maxRows int) error {
	cutoff := time.Now().UTC().Add(-maxAge).Format(PollLogTSFormat)
	stmts := []struct {
		sql  string
		args []any
	}{
		{`DELETE FROM watcher_poll_log_resources WHERE log_id IN (SELECT id FROM watcher_poll_log WHERE ts < ?)`, []any{cutoff}},
		{`DELETE FROM watcher_poll_log WHERE ts < ?`, []any{cutoff}},
		{`DELETE FROM watcher_poll_log_resources WHERE log_id <= (SELECT id FROM watcher_poll_log ORDER BY id DESC LIMIT 1 OFFSET ?)`, []any{maxRows}},
		{`DELETE FROM watcher_poll_log WHERE id <= (SELECT id FROM watcher_poll_log ORDER BY id DESC LIMIT 1 OFFSET ?)`, []any{maxRows}},
	}
	for _, s := range stmts {
		if _, err := conn.Exec(s.sql, s.args...); err != nil {
			return fmt.Errorf("prune poll log: %w", err)
		}
	}
	return nil
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}
```

If `placeholders` already exists in package `db`, delete this copy and reuse it.

- [ ] **Step 4: Run tests**

Run: `go test ./db -run 'PollLog' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/polllog.go db/polllog_test.go
git commit --signoff -m "feat(db): watcher poll log insert, scoped query, and pruning

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Per-resource poll status

**Files:**
- Create: `db/resourcepoll.go`
- Test: `db/resourcepoll_test.go`

**Interfaces:**
- Produces:

```go
type ResourcePollDetail struct {
	OK            bool   `json:"ok"`
	DurationMS    int    `json:"duration_ms,omitempty"`
	HTTPStatus    int    `json:"http_status,omitempty"`
	EventsEmitted int    `json:"events_emitted"`
	Note          string `json:"note,omitempty"`
}

type ResourceKey struct{ Type, ID string }

type ResourcePollStatus struct {
	Type, ID         string
	LastAttempt      string
	LastSuccess      string
	LastError        string
	LastErrorMessage string
	Detail           *ResourcePollDetail
}

func (s ResourcePollStatus) Failing() bool // LastError != "" && LastError > LastSuccess

func RecordResourcePoll(conn *sql.DB, r watcher.Resource, ok bool, message string, d ResourcePollDetail) error
func GetResourcePollStatuses(conn *sql.DB, rs []watcher.Resource) (map[ResourceKey]ResourcePollStatus, error)
```

Timestamps here are `PollLogTSFormat` (sub-second, so a success and an error in the same second still order correctly).

- [ ] **Step 1: Write the failing test** — `db/resourcepoll_test.go`:

```go
package db

import (
	"testing"

	"github.com/mturley/watcher"
)

func TestRecordResourcePoll_ErrorThenSuccess(t *testing.T) {
	c := migrated(t)
	r := watcher.Resource{Type: "pr", ID: "o/r#1"}
	if err := RecordResourcePoll(c, r, false, "GitHub API error: Unicorn! · GitHub",
		ResourcePollDetail{HTTPStatus: 504, DurationMS: 12300, Note: "GitHub API error"}); err != nil {
		t.Fatal(err)
	}
	m, err := GetResourcePollStatuses(c, []watcher.Resource{r, {Type: "jira", ID: "NEVER-1"}})
	if err != nil {
		t.Fatal(err)
	}
	st, ok := m[ResourceKey{"pr", "o/r#1"}]
	if !ok || !st.Failing() || st.LastErrorMessage != "GitHub API error: Unicorn! · GitHub" || st.Detail == nil || st.Detail.HTTPStatus != 504 || st.Detail.OK {
		t.Fatalf("after error: %+v (detail %+v)", st, st.Detail)
	}
	if _, present := m[ResourceKey{"jira", "NEVER-1"}]; present {
		t.Fatal("never-polled resource should be absent")
	}
	if err := RecordResourcePoll(c, r, true, "", ResourcePollDetail{OK: true, EventsEmitted: 2}); err != nil {
		t.Fatal(err)
	}
	m, _ = GetResourcePollStatuses(c, []watcher.Resource{r})
	st = m[ResourceKey{"pr", "o/r#1"}]
	if st.Failing() || st.LastSuccess == "" || st.LastErrorMessage == "" || st.Detail.EventsEmitted != 2 || !st.Detail.OK {
		t.Fatalf("after success: %+v (detail %+v) — last error kept for history, detail replaced", st, st.Detail)
	}
	if st.LastAttempt != st.LastSuccess {
		t.Fatalf("last_attempt %q != last_success %q", st.LastAttempt, st.LastSuccess)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./db -run TestRecordResourcePoll -v`
Expected: FAIL (undefined).

- [ ] **Step 3: Implement** `db/resourcepoll.go`:

```go
package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/mturley/watcher"
)

// ResourcePollDetail is the JSON stored in last_detail: what the most recent
// poll of one resource saw. For a batched GitHub call, DurationMS and
// HTTPStatus are the batch's, shared by every PR in it.
type ResourcePollDetail struct {
	OK            bool   `json:"ok"`
	DurationMS    int    `json:"duration_ms,omitempty"`
	HTTPStatus    int    `json:"http_status,omitempty"`
	EventsEmitted int    `json:"events_emitted"`
	Note          string `json:"note,omitempty"`
}

type ResourceKey struct{ Type, ID string }

type ResourcePollStatus struct {
	Type, ID         string
	LastAttempt      string
	LastSuccess      string
	LastError        string
	LastErrorMessage string
	Detail           *ResourcePollDetail
}

// Failing reports whether the last error is newer than the last success —
// the same rule as HasPollerError, per resource.
func (s ResourcePollStatus) Failing() bool {
	return s.LastError != "" && s.LastError > s.LastSuccess
}

// RecordResourcePoll records one resource's poll outcome. The previous error
// message is kept after a success so the UI can still say when it last failed.
func RecordResourcePoll(conn *sql.DB, r watcher.Resource, ok bool, message string, d ResourcePollDetail) error {
	d.OK = ok
	now := time.Now().UTC().Format(PollLogTSFormat)
	detail, err := json.Marshal(d)
	if err != nil {
		return err
	}
	if ok {
		_, err = conn.Exec(`INSERT INTO watcher_resource_poll_status
			(resource_type, resource_id, last_attempt, last_success, last_detail) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(resource_type, resource_id) DO UPDATE SET
			last_attempt = excluded.last_attempt, last_success = excluded.last_success, last_detail = excluded.last_detail`,
			r.Type, r.ID, now, now, string(detail))
	} else {
		_, err = conn.Exec(`INSERT INTO watcher_resource_poll_status
			(resource_type, resource_id, last_attempt, last_error, last_error_message, last_detail) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(resource_type, resource_id) DO UPDATE SET
			last_attempt = excluded.last_attempt, last_error = excluded.last_error,
			last_error_message = excluded.last_error_message, last_detail = excluded.last_detail`,
			r.Type, r.ID, now, now, message, string(detail))
	}
	if err != nil {
		return fmt.Errorf("record resource poll: %w", err)
	}
	return nil
}

// GetResourcePollStatuses returns status rows for the given resources; a
// resource that has never been polled is absent from the map.
func GetResourcePollStatuses(conn *sql.DB, rs []watcher.Resource) (map[ResourceKey]ResourcePollStatus, error) {
	out := make(map[ResourceKey]ResourcePollStatus, len(rs))
	for _, r := range rs {
		var st ResourcePollStatus
		var attempt, success, lastErr, msg, detail sql.NullString
		err := conn.QueryRow(`SELECT resource_type, resource_id, last_attempt, last_success, last_error, last_error_message, last_detail
			FROM watcher_resource_poll_status WHERE resource_type = ? AND resource_id = ?`, r.Type, r.ID).
			Scan(&st.Type, &st.ID, &attempt, &success, &lastErr, &msg, &detail)
		if err == sql.ErrNoRows {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("get resource poll status: %w", err)
		}
		st.LastAttempt, st.LastSuccess, st.LastError, st.LastErrorMessage = attempt.String, success.String, lastErr.String, msg.String
		if detail.Valid {
			var d ResourcePollDetail
			if json.Unmarshal([]byte(detail.String), &d) == nil {
				st.Detail = &d
			}
		}
		out[ResourceKey{r.Type, r.ID}] = st
	}
	return out, nil
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./db -v 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/resourcepoll.go db/resourcepoll_test.go
git commit --signoff -m "feat(db): record per-resource poll outcomes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: `polllog` package — sanitizer, context tagging, instrumented transport

**Files:**
- Create: `polllog/sanitize.go`, `polllog/transport.go`, `polllog/write.go`
- Test: `polllog/sanitize_test.go`, `polllog/transport_test.go`

**Interfaces:**
- Consumes: `db.InsertPollLog`, `db.PollLogEntry` (Task 2).
- Produces:

```go
func Sanitize(body []byte, contentType string) string
func SanitizeMessage(msg string) string
func WithResources(ctx context.Context, rs ...watcher.Resource) context.Context
func ResourcesFrom(ctx context.Context) []watcher.Resource
type CallStats struct{ Status, DurationMS int } // last call wins
func WithStats(ctx context.Context) (context.Context, *CallStats)
type Transport struct {
	Base   http.RoundTripper // nil → http.DefaultTransport
	Conn   *sql.DB
	Source string
	Logger *log.Logger       // nil → log.Default()
}
func NewClient(conn *sql.DB, source string, timeout time.Duration, logger *log.Logger) *http.Client
func Write(conn *sql.DB, source, level, message string, rs ...watcher.Resource) error // kind = "resource" if rs given, else "poll"
func Prune(conn *sql.DB, logger *log.Logger) // db.PrunePollLog(conn, 7*24h, 50000), logs failure
```

- [ ] **Step 1: Write the failing sanitizer tests** — `polllog/sanitize_test.go`:

```go
package polllog

import (
	"strings"
	"testing"
	"unicode/utf8"
)

const githubUnicorn = `<!DOCTYPE html>
<!--
Hello future GitHubber!
-->
<html><head><title>Unicorn! &middot; GitHub</title>
<style>body { color: red }</style></head>
<body><p><strong>We couldn't respond to your request in time.</strong></p>
<img src="data:image/png;base64,iVBORw0KGgoAAAA"></body></html>`

func TestSanitize(t *testing.T) {
	cases := []struct {
		name, body, ct, want string
	}{
		{"html title wins", githubUnicorn, "text/html", "Unicorn! · GitHub"},
		{"html sniffed without content type", githubUnicorn, "", "Unicorn! · GitHub"},
		{"html without title strips tags/style", `<html><style>x{}</style><p>Bad  <b>gateway</b></p></html>`, "text/html", "Bad gateway"},
		{"json kept, whitespace collapsed", "{\"message\": \"\",\n  \"status\": 503}", "application/json", `{"message": "", "status": 503}`},
		{"empty", "", "", ""},
	}
	for _, c := range cases {
		if got := Sanitize([]byte(c.body), c.ct); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestSanitize_CapsAt500Runes(t *testing.T) {
	got := Sanitize([]byte(strings.Repeat("é", 800)), "text/plain")
	if n := utf8.RuneCountInString(got); n != 500 || !strings.HasSuffix(got, "…") {
		t.Fatalf("len %d suffix %q", n, got[len(got)-3:])
	}
}

func TestSanitize_InvalidUTF8(t *testing.T) {
	if got := Sanitize([]byte{'o', 'k', 0xff, 'x'}, ""); !utf8.ValidString(got) {
		t.Fatalf("invalid utf8 out: %q", got)
	}
}

func TestSanitizeMessage_EmbeddedHTML(t *testing.T) {
	msg := "Failed to fetch PR data: GitHub API returned status 504: " + githubUnicorn
	want := "Failed to fetch PR data: GitHub API returned status 504: Unicorn! · GitHub"
	if got := SanitizeMessage(msg); got != want {
		t.Fatalf("got %q", got)
	}
	if got := SanitizeMessage("slack error: thread_not_found"); got != "slack error: thread_not_found" {
		t.Fatalf("plain message changed: %q", got)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./polllog -v`
Expected: FAIL (package has no non-test files / undefined `Sanitize`).

- [ ] **Step 3: Implement** `polllog/sanitize.go`:

```go
// Package polllog records watcher HTTP and poll activity to the watcher log
// (watcher_poll_log). It never stores query strings, headers, or full bodies.
package polllog

import (
	"html"
	"regexp"
	"strings"
	"unicode/utf8"
)

const maxRunes = 500

var (
	titleRe   = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	commentRe = regexp.MustCompile(`(?s)<!--.*?-->`)
	blockRe   = regexp.MustCompile(`(?is)<(style|script)[^>]*>.*?</(style|script)>`)
	tagRe     = regexp.MustCompile(`(?s)<[^>]*>`)
	spaceRe   = regexp.MustCompile(`\s+`)
)

func isHTML(s, contentType string) bool {
	if strings.Contains(strings.ToLower(contentType), "html") {
		return true
	}
	t := strings.ToLower(strings.TrimSpace(s))
	return strings.HasPrefix(t, "<!doctype") || strings.HasPrefix(t, "<html")
}

func collapse(s string) string { return strings.TrimSpace(spaceRe.ReplaceAllString(s, " ")) }

func capRunes(s string) string {
	if utf8.RuneCountInString(s) <= maxRunes {
		return s
	}
	r := []rune(s)
	return string(r[:maxRunes-1]) + "…"
}

// Sanitize reduces a response body to a short, single-line, human-readable
// excerpt: an HTML page's <title> (or its tag-stripped text), otherwise the
// body with whitespace collapsed; capped at 500 runes.
func Sanitize(body []byte, contentType string) string {
	s := strings.ToValidUTF8(string(body), "�")
	if isHTML(s, contentType) {
		if m := titleRe.FindStringSubmatch(s); m != nil {
			if t := collapse(html.UnescapeString(m[1])); t != "" {
				return capRunes(t)
			}
		}
		s = commentRe.ReplaceAllString(s, " ")
		s = blockRe.ReplaceAllString(s, " ")
		s = tagRe.ReplaceAllString(s, " ")
		s = html.UnescapeString(s)
	}
	return capRunes(collapse(s))
}

// SanitizeMessage sanitizes an error message that may embed a raw HTML
// response body after a prefix (e.g. "...returned status 504: <!DOCTYPE html>...").
func SanitizeMessage(msg string) string {
	lower := strings.ToLower(msg)
	idx := -1
	for _, marker := range []string{"<!doctype", "<html"} {
		if i := strings.Index(lower, marker); i >= 0 && (idx < 0 || i < idx) {
			idx = i
		}
	}
	if idx < 0 {
		return capRunes(collapse(strings.ToValidUTF8(msg, "�")))
	}
	return capRunes(collapse(msg[:idx]) + " " + Sanitize([]byte(msg[idx:]), "text/html"))
}
```

Note: `collapse(msg[:idx])` trims the trailing space before the HTML, so `+ " " +` restores exactly one.

- [ ] **Step 4: Run sanitizer tests**

Run: `go test ./polllog -run 'Sanitize' -v`
Expected: PASS.

- [ ] **Step 5: Write failing transport tests** — `polllog/transport_test.go`:

```go
package polllog

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mturley/watcher"
	"github.com/mturley/watcher/db"
	"github.com/mturley/watcher/testutil"
)

var quiet = log.New(io.Discard, "", 0)

func server(t *testing.T) *httptest.Server {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/fail" {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(504)
			io.WriteString(w, githubUnicorn)
			return
		}
		io.WriteString(w, `{"ok":true}`)
	}))
	t.Cleanup(ts.Close)
	return ts
}

func TestTransport_LogsSuccessAndFailureWithTags(t *testing.T) {
	conn := testutil.NewTestDB(t)
	ts := server(t)
	hc := NewClient(conn, "github", 5*time.Second, quiet)
	pr := watcher.Resource{Type: "pr", ID: "o/r#1"}
	ctx, stats := WithStats(WithResources(context.Background(), pr))

	req, _ := http.NewRequestWithContext(ctx, "POST", ts.URL+"/ok?token=SECRET", nil)
	resp, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.ReadAll(resp.Body)
	resp.Body.Close()

	req, _ = http.NewRequestWithContext(ctx, "POST", ts.URL+"/fail", nil)
	resp, err = hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	got, _, err := db.QueryPollLog(conn, db.PollLogQuery{})
	if err != nil || len(got) != 2 {
		t.Fatalf("got %d entries err=%v", len(got), err)
	}
	fail, ok := got[0], got[1]
	if ok.Level != "info" || ok.HTTPStatus != 200 || ok.Bytes != int64(len(`{"ok":true}`)) || ok.Kind != "http" || ok.Method != "POST" {
		t.Fatalf("ok row: %+v", ok)
	}
	if strings.Contains(ok.Endpoint, "SECRET") || strings.Contains(ok.Message, "SECRET") || !strings.HasSuffix(ok.Endpoint, "/ok") {
		t.Fatalf("query string leaked or bad endpoint: %q / %q", ok.Endpoint, ok.Message)
	}
	if fail.Level != "error" || fail.HTTPStatus != 504 || fail.ErrorBody != "Unicorn! · GitHub" {
		t.Fatalf("fail row: %+v", fail)
	}
	if len(fail.Resources) != 1 || fail.Resources[0] != (watcher.Resource{Type: "pr", ID: "o/r#1"}) {
		t.Fatalf("tags: %+v", fail.Resources)
	}
	if stats.Status != 504 {
		t.Fatalf("stats.Status = %d, want 504 (last call)", stats.Status)
	}
}

func TestTransport_BodyStillReadable(t *testing.T) {
	conn := testutil.NewTestDB(t)
	ts := server(t)
	hc := NewClient(conn, "github", 5*time.Second, quiet)
	for _, path := range []string{"/ok", "/fail"} {
		resp, err := hc.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if path == "/ok" && string(b) != `{"ok":true}` {
			t.Fatalf("ok body = %q", b)
		}
		if path == "/fail" && !strings.Contains(string(b), "Unicorn!") {
			t.Fatalf("fail body not passed through intact")
		}
	}
}

func TestTransport_TransportErrorLogged(t *testing.T) {
	conn := testutil.NewTestDB(t)
	hc := NewClient(conn, "jira", time.Second, quiet)
	if _, err := hc.Get("http://127.0.0.1:1/unreachable"); err == nil {
		t.Fatal("expected dial error")
	}
	got, _, _ := db.QueryPollLog(conn, db.PollLogQuery{})
	if len(got) != 1 || got[0].Level != "error" || got[0].HTTPStatus != 0 || got[0].Source != "jira" {
		t.Fatalf("got %+v", got)
	}
}

func TestTransport_LogWriteFailureDoesNotFailRequest(t *testing.T) {
	conn := testutil.NewTestDB(t)
	ts := server(t)
	hc := NewClient(conn, "github", time.Second, quiet)
	conn.Close() // every log write now fails
	resp, err := hc.Get(ts.URL + "/ok")
	if err != nil {
		t.Fatalf("request failed because logging failed: %v", err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(b) != `{"ok":true}` {
		t.Fatalf("body = %q", b)
	}
}

func TestWrite_KindFromResources(t *testing.T) {
	conn := testutil.NewTestDB(t)
	if err := Write(conn, "github", "info", "github poll started: 2 resources"); err != nil {
		t.Fatal(err)
	}
	if err := Write(conn, "github", "error", "no data returned", watcher.Resource{Type: "pr", ID: "o/r#2"}); err != nil {
		t.Fatal(err)
	}
	got, _, _ := db.QueryPollLog(conn, db.PollLogQuery{})
	if got[0].Kind != "resource" || got[1].Kind != "poll" {
		t.Fatalf("kinds: %q %q", got[0].Kind, got[1].Kind)
	}
}
```

Confirm `testutil.NewTestDB` runs `db.Migrate`; if it does not, call `db.Migrate(conn)` after it.

- [ ] **Step 6: Run to verify failure**

Run: `go test ./polllog -run 'Transport|Write' -v`
Expected: FAIL (undefined `NewClient`).

- [ ] **Step 7: Implement** `polllog/transport.go`:

```go
package polllog

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/mturley/watcher"
	"github.com/mturley/watcher/db"
)

type resourcesKey struct{}
type statsKey struct{}

// WithResources tags every request made with ctx with the given resources.
func WithResources(ctx context.Context, rs ...watcher.Resource) context.Context {
	return context.WithValue(ctx, resourcesKey{}, rs)
}

func ResourcesFrom(ctx context.Context) []watcher.Resource {
	rs, _ := ctx.Value(resourcesKey{}).([]watcher.Resource)
	return rs
}

// CallStats receives the status and duration of the most recent instrumented
// call made with its context, so a poller can put them in a resource's detail.
type CallStats struct {
	mu         sync.Mutex
	Status     int
	DurationMS int
}

func (s *CallStats) set(status, ms int) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.Status, s.DurationMS = status, ms
	s.mu.Unlock()
}

func WithStats(ctx context.Context) (context.Context, *CallStats) {
	s := &CallStats{}
	return context.WithValue(ctx, statsKey{}, s), s
}

func statsFrom(ctx context.Context) *CallStats {
	s, _ := ctx.Value(statsKey{}).(*CallStats)
	return s
}

// Transport writes one kind=http watcher log row per request. Logging never
// fails or alters the request: on a log write error it logs to Logger.
type Transport struct {
	Base   http.RoundTripper
	Conn   *sql.DB
	Source string
	Logger *log.Logger
}

func NewClient(conn *sql.DB, source string, timeout time.Duration, logger *log.Logger) *http.Client {
	return &http.Client{Timeout: timeout, Transport: &Transport{Conn: conn, Source: source, Logger: logger}}
}

func (t *Transport) logger() *log.Logger {
	if t.Logger != nil {
		return t.Logger
	}
	return log.Default()
}

func (t *Transport) write(e db.PollLogEntry) {
	if _, err := db.InsertPollLog(t.Conn, e); err != nil {
		t.logger().Printf("WARNING: watcher log write failed: %v", err)
	}
}

func (t *Transport) RoundTrip(req *http.Request) (*http.Response, error) {
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	endpoint := req.URL.Host + req.URL.Path
	e := db.PollLogEntry{
		Source: t.Source, Kind: "http", Method: req.Method, Endpoint: endpoint,
		Resources: ResourcesFrom(req.Context()),
	}
	stats := statsFrom(req.Context())
	start := time.Now()
	resp, err := base.RoundTrip(req)
	elapsed := func() int { return int(time.Since(start).Milliseconds()) }
	if err != nil {
		e.Level, e.DurationMS = "error", elapsed()
		e.Message = fmt.Sprintf("%s %s failed: %s", req.Method, endpoint, SanitizeMessage(err.Error()))
		t.write(e)
		stats.set(0, e.DurationMS)
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		resp.Body = io.NopCloser(bytes.NewReader(body))
		e.Level, e.HTTPStatus, e.Bytes, e.DurationMS = "error", resp.StatusCode, int64(len(body)), elapsed()
		e.ErrorBody = Sanitize(body, resp.Header.Get("Content-Type"))
		e.Message = fmt.Sprintf("%s %s → %d", req.Method, endpoint, resp.StatusCode)
		t.write(e)
		stats.set(resp.StatusCode, e.DurationMS)
		return resp, nil
	}
	status := resp.StatusCode
	resp.Body = &countingBody{rc: resp.Body, done: func(n int64) {
		e.Level, e.HTTPStatus, e.Bytes, e.DurationMS = "info", status, n, elapsed()
		e.Message = fmt.Sprintf("%s %s → %d", req.Method, endpoint, status)
		t.write(e)
		stats.set(status, e.DurationMS)
	}}
	return resp, nil
}

// countingBody counts bytes read and logs the call once, on Close, so the
// duration covers reading the body and the size is known even when chunked.
type countingBody struct {
	rc   io.ReadCloser
	n    int64
	once sync.Once
	done func(int64)
}

func (c *countingBody) Read(p []byte) (int, error) {
	n, err := c.rc.Read(p)
	c.n += int64(n)
	return n, err
}

func (c *countingBody) Close() error {
	err := c.rc.Close()
	c.once.Do(func() { c.done(c.n) })
	return err
}
```

And `polllog/write.go`:

```go
package polllog

import (
	"database/sql"
	"log"
	"time"

	"github.com/mturley/watcher"
	"github.com/mturley/watcher/db"
)

const (
	retention = 7 * 24 * time.Hour
	maxRows   = 50_000
)

// Write records a poll-lifecycle (no resources) or per-resource row.
func Write(conn *sql.DB, source, level, message string, rs ...watcher.Resource) error {
	kind := "poll"
	if len(rs) > 0 {
		kind = "resource"
	}
	_, err := db.InsertPollLog(conn, db.PollLogEntry{
		Source: source, Level: level, Kind: kind, Message: SanitizeMessage(message), Resources: rs,
	})
	return err
}

// Prune applies the watcher log's retention policy (7 days, 50k rows).
func Prune(conn *sql.DB, logger *log.Logger) {
	if err := db.PrunePollLog(conn, retention, maxRows); err != nil && logger != nil {
		logger.Printf("WARNING: %v", err)
	}
}
```

- [ ] **Step 8: Run all polllog tests**

Run: `go test ./polllog -v`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add polllog/
git commit --signoff -m "feat(polllog): sanitizer, resource tagging, and instrumented HTTP transport

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: GitHub poller — instrumentation and per-resource outcomes

**Files:**
- Modify: `github/graphql.go` (`FetchPRs`, `FetchRemainingCheckContexts` → thin wrappers over ctx/client-taking internals)
- Modify: `github/poller.go` (`Poll` → `pollWith`; `processPR` → wrapper over `processPRWith`)
- Test: `github/poll_status_test.go` (new)

**Interfaces:**
- Consumes: `polllog.NewClient`, `WithResources`, `WithStats`, `Write`, `Prune`, `SanitizeMessage`; `db.RecordResourcePoll`, `db.ResourcePollDetail`.
- Produces (unexported, test-visible):

```go
type ghHTTP struct {
	ctx      context.Context
	hc       *http.Client
	endpoint string // GraphQL endpoint
}
func fetchPRs(h ghHTTP, token string, prs []PRRef) ([]PRData, *RateLimit, error)
func fetchRemainingCheckContexts(h ghHTTP, token, owner, repo string, prNumber int, cursor string) ([]CheckRun, []StatusContext, error)
func processPRWith(conn *sql.DB, h ghHTTP, prData PRData, resource watcher.Resource, token string, backfill bool, logger *log.Logger) (int, error)
func pollWith(conn *sql.DB, token string, resources []watcher.Resource, logger *log.Logger, endpoint string) error
```

Public signatures `Poll`, `FetchPRs`, `FetchRemainingCheckContexts`, `processPR` are unchanged.

- [ ] **Step 1: Write the failing tests** — `github/poll_status_test.go`:

```go
package github

import (
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mturley/watcher"
	"github.com/mturley/watcher/db"
	"github.com/mturley/watcher/testutil"
)

var quietLog = log.New(io.Discard, "", 0)

func TestPoll_BatchFailureRecordsEveryPR(t *testing.T) {
	conn := testutil.NewTestDB(t)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(504)
		io.WriteString(w, "<!DOCTYPE html><html><head><title>Unicorn! &middot; GitHub</title></head></html>")
	}))
	defer ts.Close()
	prs := []watcher.Resource{{Type: "pr", ID: "o/r#1"}, {Type: "pr", ID: "o/r#2"}}

	if err := pollWith(conn, "tok", prs, quietLog, ts.URL); err == nil {
		t.Fatal("expected error from 504")
	}
	st, _ := db.GetResourcePollStatuses(conn, prs)
	for _, r := range prs {
		s := st[db.ResourceKey{Type: r.Type, ID: r.ID}]
		if !s.Failing() || s.Detail == nil || s.Detail.HTTPStatus != 504 {
			t.Fatalf("%s: %+v", r.ID, s)
		}
		if strings.Contains(s.LastErrorMessage, "<") || !strings.Contains(s.LastErrorMessage, "Unicorn! · GitHub") {
			t.Fatalf("message not sanitized: %q", s.LastErrorMessage)
		}
	}
	ps, _ := db.GetPollerStatus(conn, "github")
	if strings.Contains(ps.LastErrorMessage, "<html") {
		t.Fatalf("poller status message not sanitized: %q", ps.LastErrorMessage)
	}
	rows, _, _ := db.QueryPollLog(conn, db.PollLogQuery{})
	var kinds []string
	for _, e := range rows {
		kinds = append(kinds, e.Kind+":"+e.Level)
	}
	// newest first: finish(poll:error), resource:error (tagged both), http:error, start(poll:info)
	want := "poll:error,resource:error,http:error,poll:info"
	if got := strings.Join(kinds, ","); got != want {
		t.Fatalf("log kinds = %s, want %s", got, want)
	}
	if len(rows[1].Resources) != 2 {
		t.Fatalf("resource row tags = %+v", rows[1].Resources)
	}
}

func TestPoll_MissingPRRecordedAsError(t *testing.T) {
	conn := testutil.NewTestDB(t)
	// GraphQL nulls the alias of an unresolvable repo; the batch succeeds.
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"data":{"rateLimit":{"limit":5000,"remaining":4999,"resetAt":"2026-10-13T00:00:00Z"},"pr0":null}}`)
	}))
	defer ts.Close()
	pr := watcher.Resource{Type: "pr", ID: "o/gone#1"}
	if err := pollWith(conn, "tok", []watcher.Resource{pr}, quietLog, ts.URL); err != nil {
		t.Fatalf("partial batch should not fail the poll: %v", err)
	}
	st, _ := db.GetResourcePollStatuses(conn, []watcher.Resource{pr})
	s := st[db.ResourceKey{Type: "pr", ID: "o/gone#1"}]
	if !s.Failing() || !strings.Contains(s.LastErrorMessage, "no data returned") {
		t.Fatalf("missing PR: %+v", s)
	}
}

func TestPoll_InvalidResourceIDRecorded(t *testing.T) {
	conn := testutil.NewTestDB(t)
	bad := watcher.Resource{Type: "pr", ID: "not-a-pr"}
	_ = pollWith(conn, "tok", []watcher.Resource{bad}, quietLog, "http://127.0.0.1:1")
	st, _ := db.GetResourcePollStatuses(conn, []watcher.Resource{bad})
	if !st[db.ResourceKey{Type: "pr", ID: "not-a-pr"}].Failing() {
		t.Fatal("invalid resource id not recorded as error")
	}
}
```

The alias name (`pr0`) and rate-limit field names in `TestPoll_MissingPRRecordedAsError` must match `buildBatchedPRQuery` and the `rateLimitData` struct in `github/graphql.go`; check both and adjust the fixture JSON so the response parses with zero PRs returned. Also add a success-path test by reusing an existing PR JSON fixture from `github/graphql_test.go` (search it for the batched-response fixture used by `FetchPRs` tests), served from the httptest server; assert `!Failing()`, `Detail.OK`, `Detail.HTTPStatus == 200`, and a finish row whose message contains `rate limit`.

- [ ] **Step 2: Run to verify failure**

Run: `go test ./github -run 'TestPoll_' -v`
Expected: FAIL (undefined `pollWith`).

- [ ] **Step 3: Refactor the fetch functions** in `github/graphql.go`.

Add `"context"` to imports. Add the type and a default:

```go
const graphqlEndpoint = "https://api.github.com/graphql"

// ghHTTP carries the context (resource tags, call stats), client, and
// endpoint for one poll's GitHub calls.
type ghHTTP struct {
	ctx      context.Context
	hc       *http.Client
	endpoint string
}

func defaultGHHTTP(endpoint string) ghHTTP {
	if endpoint == "" {
		endpoint = graphqlEndpoint
	}
	return ghHTTP{ctx: context.Background(), hc: &http.Client{}, endpoint: endpoint}
}
```

Rename the body of `FetchPRs` into `fetchPRs(h ghHTTP, token string, prs []PRRef)`, replacing `http.NewRequest("POST", endpoint, …)` with `http.NewRequestWithContext(h.ctx, "POST", h.endpoint, …)` and `client := &http.Client{}; resp, err := client.Do(req)` with `resp, err := h.hc.Do(req)`. Then:

```go
func FetchPRs(token string, prs []PRRef, apiURL ...string) ([]PRData, *RateLimit, error) {
	ep := ""
	if len(apiURL) > 0 {
		ep = apiURL[0]
	}
	return fetchPRs(defaultGHHTTP(ep), token, prs)
}
```

Do the same for `FetchRemainingCheckContexts` → `fetchRemainingCheckContexts(h ghHTTP, token, owner, repo, prNumber, cursor)`, using `h.endpoint` instead of the hard-coded URL and `h.hc.Do`; keep `FetchRemainingCheckContexts(token, …)` as a wrapper over `defaultGHHTTP("")`.

- [ ] **Step 4: Thread `ghHTTP` through `processPR`** in `github/poller.go`.

Rename `processPR`'s body to `processPRWith(conn, h ghHTTP, prData, resource, token, backfill, logger)` and replace its call to `FetchRemainingCheckContexts(token, …)` with `fetchRemainingCheckContexts(h, token, …)`, where `h.ctx` is `polllog.WithResources(h.ctx, resource)` so follow-up pages are tagged with that one PR. Keep:

```go
func processPR(conn *sql.DB, prData PRData, resource watcher.Resource, token string, backfill bool, logger *log.Logger) (int, error) {
	return processPRWith(conn, defaultGHHTTP(""), prData, resource, token, backfill, logger)
}
```

so the existing `TestProcessPR_*` tests compile unchanged.

- [ ] **Step 5: Rewrite `Poll` as `pollWith`** in `github/poller.go`:

```go
func Poll(conn *sql.DB, token string, resources []watcher.Resource, logger *log.Logger) error {
	return pollWith(conn, token, resources, logger, graphqlEndpoint)
}

func pollWith(conn *sql.DB, token string, resources []watcher.Resource, logger *log.Logger, endpoint string) error {
	defer polllog.Prune(conn, logger)
	logRow := func(level, msg string, rs ...watcher.Resource) {
		if err := polllog.Write(conn, "github", level, msg, rs...); err != nil {
			logger.Printf("WARNING: watcher log write failed: %v", err)
		}
	}
	record := func(r watcher.Resource, ok bool, msg string, d db.ResourcePollDetail) {
		if err := db.RecordResourcePoll(conn, r, ok, polllog.SanitizeMessage(msg), d); err != nil {
			logger.Printf("WARNING: record resource poll %s: %v", r.ID, err)
		}
	}
	logRow("info", fmt.Sprintf("github poll started: %d resources", len(resources)))
```

Then keep the existing body with these changes:

- On a parse error: also `record(r, false, "Invalid PR resource ID: "+err.Error(), db.ResourcePollDetail{Note: "invalid resource ID"})` and `logRow("error", "Invalid PR resource ID "+r.ID, r)`.
- `valid` = the resources whose IDs parsed. Build `ctx, stats := polllog.WithStats(polllog.WithResources(context.Background(), valid...))` and `h := ghHTTP{ctx: ctx, hc: polllog.NewClient(conn, "github", 60*time.Second, logger), endpoint: endpoint}`; call `fetchPRs(h, token, prRefs)`.
- On fetch failure: `errBody := polllog.SanitizeMessage(fmt.Sprintf("Failed to fetch PR data: %v", err))`; use `errBody` for `emitError` and `RecordPollerError` (sanitizing both); for each valid resource `record(r, false, errBody, db.ResourcePollDetail{HTTPStatus: stats.Status, DurationMS: stats.DurationMS, Note: "GitHub API error"})`; `logRow("error", errBody, valid...)` (one row tagged with all); `logRow("error", "github poll failed: "+errBody)`; return `err`.
- In the "no data returned" loop, for each missing ref: find its resource in `resourceMap` and `record(r, false, "no data returned (unresolvable repo, deleted PR, or no access)", db.ResourcePollDetail{HTTPStatus: stats.Status, DurationMS: stats.DurationMS})` plus `logRow("error", "no data returned for "+id, r)`.
- Per PR: call `processPRWith(conn, h, prData, resource, token, backfill, logger)` (where `h.ctx` is the batch ctx; `processPRWith` re-tags per PR). On error: sanitize `errBody`, `record(resource, false, errBody, db.ResourcePollDetail{HTTPStatus: stats.Status, DurationMS: stats.DurationMS})`, `logRow("error", errBody, resource)`. On success: `record(resource, true, "", db.ResourcePollDetail{HTTPStatus: stats.Status, DurationMS: stats.DurationMS, EventsEmitted: count})`.

  Capture `batchStatus, batchMS := stats.Status, stats.DurationMS` immediately after `fetchPRs` returns, and use those (not `stats.*`) in the per-PR details — follow-up calls inside `processPRWith` use a derived ctx that shares the same `*CallStats` and would overwrite it.
- Before the success return: `logRow("info", fmt.Sprintf("github poll finished: %d events, rate limit %d/%d", eventCount, rateLimit.Remaining, rateLimit.Limit))`. Guard `rateLimit == nil` (omit the rate-limit part).

Add imports `context`, `time`, and `github.com/mturley/watcher/polllog`.

- [ ] **Step 6: Run the github suite**

Run: `go test ./github/... -v 2>&1 | tail -40`
Expected: PASS, including all pre-existing `TestProcessPR_*` and `FetchPRs` tests.

- [ ] **Step 7: Commit**

```bash
git add github/graphql.go github/poller.go github/poll_status_test.go
git commit --signoff -m "feat(github): log poll HTTP activity and record per-PR poll outcomes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Jira poller — instrumentation and per-resource outcomes

**Files:**
- Modify: `jira/client.go` (`Client` gains `HTTP *http.Client` and `Ctx context.Context`; `get` uses them)
- Modify: `jira/poller.go` (`Poll`)
- Test: `jira/poll_status_test.go` (new)

**Interfaces:**
- Consumes: Task 4 `polllog` API; Task 3 `db.RecordResourcePoll`.
- Produces: `jira.Client.HTTP`, `jira.Client.Ctx` (both optional; nil → previous behavior).

- [ ] **Step 1: Write the failing test** — `jira/poll_status_test.go`:

```go
package jira

import (
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mturley/watcher"
	"github.com/mturley/watcher/db"
	"github.com/mturley/watcher/testutil"
)

func TestPoll_PerIssueOutcomesAndTaggedHTTPRows(t *testing.T) {
	conn := testutil.NewTestDB(t)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "BAD-1"):
			w.WriteHeader(503)
			io.WriteString(w, `{"message":"","status":503}`)
		case strings.HasSuffix(r.URL.Path, "/changelog"):
			io.WriteString(w, `{"values":[],"isLast":true,"startAt":0,"maxResults":100,"total":0}`)
		default:
			io.WriteString(w, goodIssueJSON)
		}
	}))
	defer ts.Close()
	good := watcher.Resource{Type: "jira", ID: "GOOD-1"}
	bad := watcher.Resource{Type: "jira", ID: "BAD-1"}
	auth := JiraAuth{URL: ts.URL, Email: "e", Token: "t"}

	if err := Poll(conn, auth, []watcher.Resource{good, bad}, log.New(io.Discard, "", 0)); err != nil {
		t.Fatal(err)
	}
	st, _ := db.GetResourcePollStatuses(conn, []watcher.Resource{good, bad})
	if g := st[db.ResourceKey{Type: "jira", ID: "GOOD-1"}]; g.Failing() || g.Detail == nil || !g.Detail.OK {
		t.Fatalf("good: %+v", g)
	}
	if b := st[db.ResourceKey{Type: "jira", ID: "BAD-1"}]; !b.Failing() || b.Detail.HTTPStatus != 503 {
		t.Fatalf("bad: %+v detail %+v", b, b.Detail)
	}
	rows, _, _ := db.QueryPollLog(conn, db.PollLogQuery{ResourceScoped: true, Resources: []watcher.Resource{bad}})
	var sawHTTP bool
	for _, e := range rows {
		if e.Kind == "http" && e.HTTPStatus == 503 {
			sawHTTP = true
		}
		if e.Kind == "http" && len(e.Resources) == 1 && e.Resources[0].ID != "BAD-1" {
			t.Fatalf("http row mis-tagged: %+v", e)
		}
	}
	if !sawHTTP {
		t.Fatalf("no tagged 503 http row in %+v", rows)
	}
}
```

Define `goodIssueJSON` in the same file by copying the issue JSON served in `TestFetchIssue_Reporter` (`jira/poller_test.go:477`), changing its `"key"` to `"GOOD-1"`. If that test serves the changelog from a different path shape, mirror its routing instead of the `HasSuffix("/changelog")` check.

- [ ] **Step 2: Run to verify failure**

Run: `go test ./jira -run TestPoll_PerIssue -v`
Expected: FAIL (no resource status rows).

- [ ] **Step 3: Implement.** In `jira/client.go` add fields to `Client`:

```go
	// HTTP, when set, is used for every request (the poller passes an
	// instrumented client). Nil keeps the 30s default client.
	HTTP *http.Client
	// Ctx, when set, is attached to every request (resource tags for the
	// watcher log). Nil means context.Background().
	Ctx context.Context
```

In `get`:

```go
	ctx := c.Ctx
	if ctx == nil {
		ctx = context.Background()
	}
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	...
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
```

In `jira/poller.go` `Poll`, after building `client`:

```go
	defer polllog.Prune(conn, logger)
	client.HTTP = polllog.NewClient(conn, "jira", 30*time.Second, logger)
	logRow := func(level, msg string, rs ...watcher.Resource) {
		if err := polllog.Write(conn, "jira", level, msg, rs...); err != nil {
			logger.Printf("WARNING: watcher log write failed: %v", err)
		}
	}
	record := func(r watcher.Resource, ok bool, msg string, d db.ResourcePollDetail) {
		if err := db.RecordResourcePoll(conn, r, ok, polllog.SanitizeMessage(msg), d); err != nil {
			logger.Printf("WARNING: record resource poll %s: %v", r.ID, err)
		}
	}
	logRow("info", fmt.Sprintf("jira poll started: %d resources", len(resources)))
	failed := 0
```

Inside the loop, before `FetchIssue`:

```go
		ctx, stats := polllog.WithStats(polllog.WithResources(context.Background(), resource))
		client.Ctx = ctx
```

- Fetch failure: sanitize `errBody` (use it for `emitError` and `RecordPollerError`), `record(resource, false, errBody, db.ResourcePollDetail{HTTPStatus: stats.Status, DurationMS: stats.DurationMS})`, `logRow("error", errBody, resource)`, `failed++`.
- `processIssue` failure: same with the process error, `failed++`.
- Success (after `UpsertResourceState`): `record(resource, true, "", db.ResourcePollDetail{HTTPStatus: stats.Status, DurationMS: stats.DurationMS, EventsEmitted: count})`.
- Before return: `logRow(level, fmt.Sprintf("jira poll finished: %d events, %d of %d resources failed", eventCount, failed, len(resources)))` with `level` = `"warn"` if `failed > 0` else `"info"`.

Add imports `context` and `github.com/mturley/watcher/polllog`.

- [ ] **Step 4: Run the jira suite**

Run: `go test ./jira/... -v 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add jira/client.go jira/poller.go jira/poll_status_test.go
git commit --signoff -m "feat(jira): log poll HTTP activity and record per-issue poll outcomes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Slack poller — opt-in instrumentation and per-thread outcomes

**Files:**
- Modify: `slack/client.go` (add `WithTransport`)
- Modify: `slack/poller.go` (`Poll` → builds instrumented client, delegates to `pollWith`)
- Test: `slack/poll_status_test.go` (new), `slack/client_test.go` (WithTransport)

**Interfaces:**
- Consumes: Task 4 `polllog` API.
- Produces: `func (c *HTTPClient) WithTransport(rt http.RoundTripper) *HTTPClient`; unexported `pollWith(conn *sql.DB, client Client, resources []watcher.Resource, logger *log.Logger) error`.

- [ ] **Step 1: Write the failing tests.**

`slack/poll_status_test.go`:

```go
package slack

import (
	"errors"
	"testing"

	"github.com/mturley/watcher"
	"github.com/mturley/watcher/db"
	"github.com/mturley/watcher/testutil"
)

func TestPollWith_RecordsPerThreadOutcomes(t *testing.T) {
	conn := testutil.NewTestDB(t)
	ok := slackResource
	if err := db.Subscribe(conn, "test-sub", ok, db.SubscribeOpts{}); err != nil {
		t.Fatal(err)
	}
	client := &fakeClient{
		thread: Thread{Channel: "C1", ThreadTS: "1699000000.000100",
			Messages: []Message{{TS: "1699000000.000100", UserID: "U1", Text: "hi"}}},
		users: map[string]User{"U1": {ID: "U1", DisplayName: "Alice"}},
	}
	if err := pollWith(conn, client, []watcher.Resource{ok}, testLogger()); err != nil {
		t.Fatal(err)
	}
	st, _ := db.GetResourcePollStatuses(conn, []watcher.Resource{ok})
	if s := st[db.ResourceKey{Type: ok.Type, ID: ok.ID}]; s.Failing() || s.Detail == nil || !s.Detail.OK {
		t.Fatalf("ok thread: %+v", s)
	}

	gone := watcher.Resource{Type: "slack", ID: "C2:1699000000.000200"}
	failing := &fakeClient{repliesErr: errors.New("slack error: thread_not_found")}
	_ = pollWith(conn, failing, []watcher.Resource{gone}, testLogger())
	st, _ = db.GetResourcePollStatuses(conn, []watcher.Resource{gone})
	s := st[db.ResourceKey{Type: gone.Type, ID: gone.ID}]
	if !s.Failing() || s.LastErrorMessage != "Failed to fetch thread: slack error: thread_not_found" {
		t.Fatalf("gone thread: %+v", s)
	}
	rows, _, _ := db.QueryPollLog(conn, db.PollLogQuery{ResourceScoped: true, Resources: []watcher.Resource{gone}})
	if len(rows) == 0 || rows[0].Kind != "poll" {
		t.Fatalf("expected finish poll row first, got %+v", rows)
	}
}

func TestPollWith_EmptyThreadRecordedAsError(t *testing.T) {
	conn := testutil.NewTestDB(t)
	empty := &fakeClient{thread: Thread{Channel: "C1", ThreadTS: "1699000000.000100"}}
	_ = pollWith(conn, empty, []watcher.Resource{slackResource}, testLogger())
	st, _ := db.GetResourcePollStatuses(conn, []watcher.Resource{slackResource})
	if s := st[db.ResourceKey{Type: "slack", ID: slackResource.ID}]; !s.Failing() {
		t.Fatalf("empty thread not recorded as error: %+v", s)
	}
}
```

Append to `slack/client_test.go`:

```go
func TestWithTransport_UsesGivenRoundTripper(t *testing.T) {
	var called bool
	rt := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		called = true
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true}`)), Header: http.Header{}}, nil
	})
	c := NewWithBaseURL("xoxc-t", "xoxd-c", "http://example.invalid/api").WithTransport(rt)
	if err := c.AuthTest(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("custom transport not used")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
```

(Add any missing imports: `context`, `io`, `net/http`, `strings`. If `roundTripFunc` already exists in the package's tests, reuse it.)

- [ ] **Step 2: Run to verify failure**

Run: `go test ./slack -run 'TestPollWith|TestWithTransport' -v`
Expected: FAIL (undefined `pollWith`, `WithTransport`).

- [ ] **Step 3: Implement.** In `slack/client.go`:

```go
// WithTransport swaps the client's RoundTripper, keeping its timeout. Used by
// the poller to log its own traffic; interactive callers never set it.
func (c *HTTPClient) WithTransport(rt http.RoundTripper) *HTTPClient {
	c.hc = &http.Client{Timeout: c.hc.Timeout, Transport: rt}
	return c
}
```

In `slack/poller.go`:

```go
func Poll(conn *sql.DB, cfg SlackAuth, resources []watcher.Resource, logger *log.Logger) error {
	if cfg.Token == "" || cfg.Cookie == "" {
		return fmt.Errorf("slack not configured")
	}
	client := New(cfg.Token, cfg.Cookie).WithTransport(&polllog.Transport{Conn: conn, Source: "slack", Logger: logger})
	return pollWith(conn, client, resources, logger)
}
```

`pollWith(conn, client Client, resources, logger)` holds the former loop body, with:

- `defer polllog.Prune(conn, logger)`, `logRow`/`record` helpers identical to Task 6 but with source `"slack"`, a start row `"slack poll started: %d resources"`, and a `failed` counter.
- Per resource: `ctx, stats := polllog.WithStats(polllog.WithResources(context.Background(), resource))`; pass `ctx` to `client.Replies(ctx, …)` instead of `context.Background()`.
- Bad resource ID: `record(resource, false, "invalid slack resource id", db.ResourcePollDetail{})`, `logRow("error", "invalid slack resource id "+resource.ID, resource)`, `failed++`.
- Replies error: sanitize `errBody` (use it for `emitError`/`RecordPollerError`), record + logRow + `failed++`, detail `{HTTPStatus: stats.Status, DurationMS: stats.DurationMS}`.
- Empty thread: `record(resource, false, "thread has no messages (root deleted?)", …)`, `logRow("warn", …, resource)`, `failed++`.
- processThread error: record + logRow + `failed++`.
- Success (after `UpsertResourceState`): `record(resource, true, "", db.ResourcePollDetail{HTTPStatus: stats.Status, DurationMS: stats.DurationMS, EventsEmitted: count})`.
- Finish row as in Task 6 (`slack poll finished: …`), then the existing `RecordPollerSuccess`.

`resolveAuthors`/`resolveChannelName`/`resolvedRootText` still use their own contexts, so those calls are logged untagged (visible in the unscoped view only). That is accepted; do not change their signatures.

Slack reports API errors as HTTP 200 with `"ok": false`, so their http rows are `info`; the per-thread `resource` error row carries the failure. Add a one-line comment saying so above the `Replies` error branch.

Add imports `context` (already present), `github.com/mturley/watcher/polllog`.

- [ ] **Step 4: Run the slack suite**

Run: `go test ./slack/... -v 2>&1 | tail -20`
Expected: PASS (existing `pollOnce`-based tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add slack/client.go slack/client_test.go slack/poller.go slack/poll_status_test.go
git commit --signoff -m "feat(slack): log poller HTTP activity and record per-thread poll outcomes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Library docs and v0.13.0 release

**Files:**
- Modify: `README.md` (and `CHANGELOG.md` if the repo has one)

- [ ] **Step 1: Document.** Add a "Watcher log" section to `README.md` covering: the three new tables; `polllog` (`NewClient`/`Transport`, `WithResources`, `WithStats`, `Write`, `Prune`, `Sanitize`, `SanitizeMessage`); retention (7 days / 50k rows, pruned at the end of every `Poll`); what is never recorded (query strings, headers, full bodies); `db.RecordResourcePoll`/`GetResourcePollStatuses`/`QueryPollLog`; and that interactive Slack clients are not instrumented unless `WithTransport` is used. If `CHANGELOG.md` exists, add a `v0.13.0` entry listing the same.

- [ ] **Step 2: Full test + vet**

Run: `go vet ./... && go test ./... 2>&1 | tail -20`
Expected: all `ok`.

- [ ] **Step 3: Commit and tag**

```bash
git add README.md   # plus CHANGELOG.md if modified
git commit --signoff -m "docs: watcher log and per-resource poll status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git tag v0.13.0
```

- [ ] **Step 4: STOP — ask Mike to approve pushing.** Show `git log --oneline origin/main..main` and the tag. Only after explicit approval:

```bash
git push origin main
git push origin v0.13.0
```

---

## Part B — worktree (`~/git/worktree`)

All commands in Part B run from `~/git/worktree`, on a branch: `git checkout -b watcher-log-modal` (before Task 9).

### Task 9: Re-pin watcher v0.13.0 and log unconfigured sources

**Files:**
- Modify: `go.mod`, `go.sum`
- Modify: `internal/webui/poller.go` (`pollAll` "not configured" branches)
- Modify: `docs/superpowers/specs/2026-10-13-watcher-log-modal-design.md` (summaries.go correction)
- Test: `internal/webui/poller_test.go`

**Interfaces:**
- Consumes: `polllog.Write`, `watcherdb.QueryPollLog` (v0.13.0).

- [ ] **Step 1: Re-pin**

Run: `go get github.com/mturley/watcher@v0.13.0 && go mod tidy && go build ./...`
Expected: builds cleanly.

- [ ] **Step 2: Write the failing test** — append to `internal/webui/poller_test.go`:

```go
func TestPollAll_UnconfiguredSourceWritesWarnRow(t *testing.T) {
	t.Setenv("WATCHER_HOME", t.TempDir()) // no auth.yaml → nothing configured
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := watcherdb.Subscribe(conn, "worktree:/x", watcher.Resource{Type: "pr", ID: "o/r#1"}, watcherdb.SubscribeOpts{}); err != nil {
		t.Fatal(err)
	}
	srv := &Server{DB: conn, Logger: log.New(io.Discard, "", 0)}
	if err := srv.pollAll(); err != nil {
		t.Fatal(err)
	}
	rows, _, err := watcherdb.QueryPollLog(conn, watcherdb.PollLogQuery{MinLevel: "warn"})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Source != "github" || rows[0].Kind != "poll" || !strings.Contains(rows[0].Message, "not configured") {
		t.Fatalf("rows = %+v", rows)
	}
}
```

(Add imports as needed: `io`, `log`, `path/filepath`, `strings`, `github.com/mturley/watcher`, `watcherdb "github.com/mturley/watcher/db"`, `wdb "github.com/mturley/worktree/internal/db"`. If `wconfig.Load` errors on a missing file rather than returning an empty config, look at `TestPollOne_NoCredsIsNoOp` for how it arranges a creds-less config and mirror it.)

- [ ] **Step 3: Run to verify failure**

Run: `go test ./internal/webui -run TestPollAll_Unconfigured -v`
Expected: FAIL (no rows).

- [ ] **Step 4: Implement.** In `pollAll`, in each of the three `else` branches, after the existing `Printf`:

```go
			s.logPollWarn("github", fmt.Sprintf("github not configured; skipping %d pr resources", len(prs)))
```

(`"jira"`/`"slack"` respectively, with the matching message), and add:

```go
// logPollWarn records a poll-level warning in the watcher log so it shows in
// the web UI's watcher log modal, not only on stderr.
func (s *Server) logPollWarn(source, msg string) {
	if err := polllog.Write(s.DB, source, "warn", msg); err != nil {
		s.logger().Printf("watcher log write: %v", err)
	}
}
```

Import `github.com/mturley/watcher/polllog` (and `fmt` if not present).

- [ ] **Step 5: Correct the spec.** In the spec's "Poller changes" section, change the call-site list to drop `github/summaries.go` and add: "`github/summaries.go` (`FetchPRSummaries`) is the linked-resources fetch, not polling, and is not instrumented."

- [ ] **Step 6: Run the Go suite**

Run: `make test 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add go.mod go.sum internal/webui/poller.go internal/webui/poller_test.go docs/superpowers/specs/2026-10-13-watcher-log-modal-design.md
git commit --signoff -m "chore: pin watcher v0.13.0; log unconfigured poll sources to the watcher log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Watcher scope resolution + `GET /api/watchers/resources`

**Files:**
- Create: `internal/webui/watcher_log_api.go`
- Modify: `internal/webui/server.go` (route table near line 179)
- Test: `internal/webui/watcher_log_api_test.go`

**Interfaces:**
- Consumes: `watcherdb.GetResourcePollStatuses`, `watcherdb.ResourceKey`, `watcherdb.ResourcePollDetail`; `wdb.Subscriber`, `wdb.WorktreePathFromSubscriber`; `s.enrichResourceDTO`, `watcherdb.GetResourceMeta`.
- Produces:

```go
type watchedResource struct {
	watcher.Resource          // Type, ID, URL
	Name      string
	Worktrees []string
	UpdatedAt string          // resource_updated_at from enrichment
}
// resolveWatcherScope returns the scope's resources and whether a scope applied.
func (s *Server) resolveWatcherScope(r *http.Request) (rs []watchedResource, scoped bool, err error)
func (s *Server) allWatched() ([]watchedResource, error)
func (s *Server) handleWatchedResources(w http.ResponseWriter, r *http.Request)

type watchedResourceDTO struct {
	Type              string                        `json:"type"`
	ID                string                        `json:"id"`
	URL               string                        `json:"url,omitempty"`
	Name              string                        `json:"name"`
	Worktrees         []string                      `json:"worktrees"`
	Status            string                        `json:"status"` // ok | error | never
	LastAttempt       string                        `json:"last_attempt,omitempty"`
	LastSuccess       string                        `json:"last_success,omitempty"`
	LastError         string                        `json:"last_error,omitempty"`
	ErrorMessage      string                        `json:"error_message,omitempty"`
	Detail            *watcherdb.ResourcePollDetail `json:"detail,omitempty"`
	ResourceUpdatedAt string                        `json:"resource_updated_at,omitempty"`
}
```

Route: `{"GET /api/watchers/resources", s.handleWatchedResources}`.

- [ ] **Step 1: Write the failing tests** — `internal/webui/watcher_log_api_test.go`:

```go
package webui

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
)

type watcherLogFixture struct {
	srv          *Server
	url          string
	wtA, wtALink string // wtALink is a symlink to wtA
	wtB          string
	prA, slackB  watcher.Resource
}

func newWatcherLogFixture(t *testing.T) watcherLogFixture {
	t.Helper()
	srv, ts := watchersTestServer(t)
	root := t.TempDir()
	f := watcherLogFixture{srv: srv, url: ts.URL,
		wtA: filepath.Join(root, "a"), wtB: filepath.Join(root, "b"), wtALink: filepath.Join(root, "a-link"),
		prA:    watcher.Resource{Type: "pr", ID: "o/r#1", URL: "https://github.com/o/r/pull/1"},
		slackB: watcher.Resource{Type: "slack", ID: "C1:1699000000.000100"},
	}
	for _, d := range []string{f.wtA, f.wtB} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(f.wtA, f.wtALink); err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(watcherdb.Subscribe(srv.DB, wdb.Subscriber(f.wtA), f.prA, watcherdb.SubscribeOpts{}))
	must(watcherdb.Subscribe(srv.DB, wdb.Subscriber(f.wtB), f.prA, watcherdb.SubscribeOpts{}))
	must(watcherdb.Subscribe(srv.DB, wdb.Subscriber(f.wtB), f.slackB, watcherdb.SubscribeOpts{}))
	must(watcherdb.SetResourceMeta(srv.DB, f.prA, "My PR", ""))
	must(watcherdb.RecordResourcePoll(srv.DB, f.slackB, false, "Failed to fetch thread: slack error: thread_not_found", watcherdb.ResourcePollDetail{}))
	return f
}

func getWatched(t *testing.T, base string, q url.Values) []watchedResourceDTO {
	t.Helper()
	resp, err := http.Get(base + "/api/watchers/resources?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var out struct{ Resources []watchedResourceDTO }
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out.Resources
}

func TestWatchedResources_Unscoped(t *testing.T) {
	f := newWatcherLogFixture(t)
	got := getWatched(t, f.url, nil)
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	if got[0].ID != f.slackB.ID || got[0].Status != "error" || got[0].ErrorMessage == "" {
		t.Fatalf("errors must sort first: %+v", got[0])
	}
	if got[1].Name != "My PR" || got[1].Status != "never" || len(got[1].Worktrees) != 2 {
		t.Fatalf("pr row: %+v", got[1])
	}
}

func TestWatchedResources_WorktreeScopeViaSymlink(t *testing.T) {
	f := newWatcherLogFixture(t)
	got := getWatched(t, f.url, url.Values{"worktree": {f.wtALink}})
	if len(got) != 1 || got[0].ID != f.prA.ID {
		t.Fatalf("scoped via symlink = %+v", got)
	}
}

func TestWatchedResources_SlackIDWithColon(t *testing.T) {
	f := newWatcherLogFixture(t)
	got := getWatched(t, f.url, url.Values{"resource": {"slack:" + f.slackB.ID}, "worktree": {f.wtA}})
	if len(got) != 1 || got[0].Type != "slack" || got[0].ID != f.slackB.ID {
		t.Fatalf("resource wins over worktree; got %+v", got)
	}
}

func TestWatchedResources_BadResourceParam(t *testing.T) {
	f := newWatcherLogFixture(t)
	resp, _ := http.Get(f.url + "/api/watchers/resources?resource=nocolon")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", resp.StatusCode)
	}
}
```

If `watchersTestServer`'s `Server` lacks fields `handleWatchedResources` needs (e.g. `Logger`), set them in the fixture.

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/webui -run TestWatchedResources -v`
Expected: FAIL (404 / undefined).

- [ ] **Step 3: Implement** `internal/webui/watcher_log_api.go`:

```go
package webui

import (
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
)

// Watcher log endpoints. Both are read-only and are called only by the
// watcher log modal while it is open — never on ordinary page loads.

type watchedResource struct {
	watcher.Resource
	Name      string
	Worktrees []string
	UpdatedAt string
}

var errBadScope = errors.New("resource must be <type>:<id>")

// allWatched returns every resource with a live worktree subscription, with
// the worktrees tracking it and its display name (custom → title → id).
func (s *Server) allWatched() ([]watchedResource, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	rows, err := s.DB.Query(`SELECT subscriber, resource_type, resource_id, COALESCE(resource_url,'')
		FROM watcher_subscriptions
		WHERE subscriber LIKE 'worktree:%' AND deleted_at IS NULL
		  AND (expires_at IS NULL OR expires_at > ?)
		ORDER BY resource_type, resource_id, subscriber`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byKey := map[watcherdb.ResourceKey]*watchedResource{}
	var order []watcherdb.ResourceKey
	for rows.Next() {
		var sub string
		var r watcher.Resource
		if err := rows.Scan(&sub, &r.Type, &r.ID, &r.URL); err != nil {
			return nil, err
		}
		k := watcherdb.ResourceKey{Type: r.Type, ID: r.ID}
		wr, ok := byKey[k]
		if !ok {
			wr = &watchedResource{Resource: r}
			byKey[k] = wr
			order = append(order, k)
		}
		if p, ok := wdb.WorktreePathFromSubscriber(sub); ok {
			wr.Worktrees = append(wr.Worktrees, p)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]watchedResource, 0, len(order))
	for _, k := range order {
		wr := byKey[k]
		dto := resourceDTO{Type: wr.Type, ID: wr.ID, URL: wr.URL}
		if meta, err := watcherdb.GetResourceMeta(s.DB, wr.Type, wr.ID); err == nil && meta != nil {
			dto.CustomName = meta.CustomName
		}
		s.enrichResourceDTO(&dto)
		wr.Name = firstNonEmpty(dto.CustomName, dto.Title, wr.ID)
		wr.UpdatedAt = dto.UpdatedAt
		out = append(out, *wr)
	}
	return out, nil
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

// resolveWatcherScope applies ?resource=<type>:<id> (wins) or ?worktree=<path>.
func (s *Server) resolveWatcherScope(r *http.Request) ([]watchedResource, bool, error) {
	all, err := s.allWatched()
	if err != nil {
		return nil, false, err
	}
	q := r.URL.Query()
	if res := q.Get("resource"); res != "" {
		typ, id, ok := strings.Cut(res, ":")
		if !ok || typ == "" || id == "" {
			return nil, false, errBadScope
		}
		for _, wr := range all {
			if wr.Type == typ && wr.ID == id {
				return []watchedResource{wr}, true, nil
			}
		}
		return []watchedResource{{Resource: watcher.Resource{Type: typ, ID: id}, Name: id}}, true, nil
	}
	if wt := q.Get("worktree"); wt != "" {
		want, _ := wdb.WorktreePathFromSubscriber(wdb.Subscriber(wt))
		var out []watchedResource
		for _, wr := range all {
			for _, p := range wr.Worktrees {
				if p == want {
					out = append(out, wr)
					break
				}
			}
		}
		return out, true, nil
	}
	return all, false, nil
}

type watchedResourceDTO struct {
	Type              string                        `json:"type"`
	ID                string                        `json:"id"`
	URL               string                        `json:"url,omitempty"`
	Name              string                        `json:"name"`
	Worktrees         []string                      `json:"worktrees"`
	Status            string                        `json:"status"`
	LastAttempt       string                        `json:"last_attempt,omitempty"`
	LastSuccess       string                        `json:"last_success,omitempty"`
	LastError         string                        `json:"last_error,omitempty"`
	ErrorMessage      string                        `json:"error_message,omitempty"`
	Detail            *watcherdb.ResourcePollDetail `json:"detail,omitempty"`
	ResourceUpdatedAt string                        `json:"resource_updated_at,omitempty"`
}

// handleWatchedResources: GET /api/watchers/resources — per-resource last
// poll status for the requested scope, failing resources first.
func (s *Server) handleWatchedResources(w http.ResponseWriter, r *http.Request) {
	scope, _, err := s.resolveWatcherScope(r)
	if errors.Is(err, errBadScope) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	rs := make([]watcher.Resource, len(scope))
	for i, wr := range scope {
		rs[i] = wr.Resource
	}
	statuses, err := watcherdb.GetResourcePollStatuses(s.DB, rs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]watchedResourceDTO, 0, len(scope))
	for _, wr := range scope {
		dto := watchedResourceDTO{Type: wr.Type, ID: wr.ID, URL: wr.URL, Name: wr.Name,
			Worktrees: wr.Worktrees, Status: "never", ResourceUpdatedAt: wr.UpdatedAt}
		if dto.Worktrees == nil {
			dto.Worktrees = []string{}
		}
		if st, ok := statuses[watcherdb.ResourceKey{Type: wr.Type, ID: wr.ID}]; ok {
			dto.LastAttempt, dto.LastSuccess, dto.LastError = st.LastAttempt, st.LastSuccess, st.LastError
			dto.ErrorMessage, dto.Detail = st.LastErrorMessage, st.Detail
			dto.Status = "ok"
			if st.Failing() {
				dto.Status = "error"
			}
		}
		out = append(out, dto)
	}
	rank := map[string]int{"error": 0, "ok": 1, "never": 2}
	sort.SliceStable(out, func(i, j int) bool {
		if rank[out[i].Status] != rank[out[j].Status] {
			return rank[out[i].Status] < rank[out[j].Status]
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	writeJSON(w, http.StatusOK, map[string]any{"resources": out})
}
```

Note the test `TestWatchedResources_Unscoped` expects the never-polled PR after the erroring Slack thread, which this rank order satisfies. If `GetResourceMeta`'s signature differs from `(conn, type, id)`, follow the one in the pinned library (it is used in `internal/resources`).

Register the route in `server.go` after `{"POST /api/watchers/poll", s.handleWatchersPoll},`:

```go
		{"GET /api/watchers/resources", s.handleWatchedResources},
```

- [ ] **Step 4: Run tests**

Run: `go test ./internal/webui -run 'TestWatchedResources|TestWatchers' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/webui/watcher_log_api.go internal/webui/watcher_log_api_test.go internal/webui/server.go
git commit --signoff -m "feat(webui): GET /api/watchers/resources with per-resource poll status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: `GET /api/watchers/log`

**Files:**
- Modify: `internal/webui/watcher_log_api.go`
- Modify: `internal/webui/server.go`
- Test: `internal/webui/watcher_log_api_test.go`

**Interfaces:**
- Consumes: `resolveWatcherScope`, `allWatched` (Task 10); `watcherdb.QueryPollLog`, `watcherdb.PollLogQuery`.
- Produces:

```go
type taggedResourceDTO struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Name string `json:"name"`
}
type pollLogEntryDTO struct {
	ID         int64               `json:"id"`
	TS         string              `json:"ts"`
	Source     string              `json:"source"`
	Level      string              `json:"level"`
	Kind       string              `json:"kind"`
	Message    string              `json:"message"`
	Method     string              `json:"method,omitempty"`
	Endpoint   string              `json:"endpoint,omitempty"`
	HTTPStatus int                 `json:"http_status,omitempty"`
	DurationMS int                 `json:"duration_ms,omitempty"`
	Bytes      int64               `json:"bytes,omitempty"`
	ErrorBody  string              `json:"error_body,omitempty"`
	Resources  []taggedResourceDTO `json:"resources"`
}
func (s *Server) handleWatcherLog(w http.ResponseWriter, r *http.Request)
```

Response: `{"entries": [...], "has_more": bool}`. Route: `{"GET /api/watchers/log", s.handleWatcherLog}`.

- [ ] **Step 1: Write the failing tests** — append to `watcher_log_api_test.go`:

```go
type logResp struct {
	Entries []pollLogEntryDTO `json:"entries"`
	HasMore bool              `json:"has_more"`
}

func getLog(t *testing.T, base string, q url.Values, wantStatus int) logResp {
	t.Helper()
	resp, err := http.Get(base + "/api/watchers/log?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != wantStatus {
		t.Fatalf("status %d, want %d", resp.StatusCode, wantStatus)
	}
	var out logResp
	if wantStatus == 200 {
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
	}
	return out
}

func seedLog(t *testing.T, f watcherLogFixture) (ghStart, prRow, slackRow, jiraStart int64) {
	t.Helper()
	ins := func(e watcherdb.PollLogEntry) int64 {
		id, err := watcherdb.InsertPollLog(f.srv.DB, e)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	ghStart = ins(watcherdb.PollLogEntry{Source: "github", Level: "info", Kind: "poll", Message: "github poll started"})
	prRow = ins(watcherdb.PollLogEntry{Source: "github", Level: "error", Kind: "http", Message: "POST → 504",
		HTTPStatus: 504, ErrorBody: "Unicorn! · GitHub", Resources: []watcher.Resource{f.prA}})
	slackRow = ins(watcherdb.PollLogEntry{Source: "slack", Level: "error", Kind: "resource", Message: "thread_not_found",
		Resources: []watcher.Resource{f.slackB}})
	jiraStart = ins(watcherdb.PollLogEntry{Source: "jira", Level: "info", Kind: "poll", Message: "jira poll started"})
	return
}

func entryIDs(r logResp) []int64 {
	var out []int64
	for _, e := range r.Entries {
		out = append(out, e.ID)
	}
	return out
}

func TestWatcherLog_UnscopedNewestFirstWithNames(t *testing.T) {
	f := newWatcherLogFixture(t)
	gh, pr, sl, ji := seedLog(t, f)
	got := getLog(t, f.url, nil, 200)
	if want := []int64{ji, sl, pr, gh}; fmt.Sprint(entryIDs(got)) != fmt.Sprint(want) {
		t.Fatalf("ids %v want %v", entryIDs(got), want)
	}
	if got.Entries[2].Resources[0].Name != "My PR" || got.Entries[2].ErrorBody != "Unicorn! · GitHub" {
		t.Fatalf("pr row: %+v", got.Entries[2])
	}
}

func TestWatcherLog_ResourceScopeIncludesOwnSourcePollRowsOnly(t *testing.T) {
	f := newWatcherLogFixture(t)
	gh, pr, _, _ := seedLog(t, f)
	got := getLog(t, f.url, url.Values{"resource": {"pr:" + f.prA.ID}}, 200)
	if want := []int64{pr, gh}; fmt.Sprint(entryIDs(got)) != fmt.Sprint(want) {
		t.Fatalf("ids %v want %v", entryIDs(got), want)
	}
}

func TestWatcherLog_FiltersAndCursors(t *testing.T) {
	f := newWatcherLogFixture(t)
	gh, pr, sl, ji := seedLog(t, f)
	got := getLog(t, f.url, url.Values{"level": {"warn"}}, 200)
	if want := []int64{sl, pr}; fmt.Sprint(entryIDs(got)) != fmt.Sprint(want) {
		t.Fatalf("warn ids %v", entryIDs(got))
	}
	got = getLog(t, f.url, url.Values{"source": {"github", "jira"}}, 200)
	if want := []int64{ji, pr, gh}; fmt.Sprint(entryIDs(got)) != fmt.Sprint(want) {
		t.Fatalf("source ids %v", entryIDs(got))
	}
	got = getLog(t, f.url, url.Values{"after_id": {fmt.Sprint(pr)}}, 200)
	if want := []int64{ji, sl}; fmt.Sprint(entryIDs(got)) != fmt.Sprint(want) {
		t.Fatalf("after ids %v", entryIDs(got))
	}
	got = getLog(t, f.url, url.Values{"limit": {"1"}}, 200)
	if len(got.Entries) != 1 || !got.HasMore {
		t.Fatalf("limit 1: %+v", got)
	}
}

func TestWatcherLog_BadParams(t *testing.T) {
	f := newWatcherLogFixture(t)
	for _, q := range []url.Values{
		{"level": {"loud"}}, {"source": {"bitbucket"}}, {"after_id": {"x"}},
		{"limit": {"0"}}, {"limit": {"501"}}, {"resource": {"nocolon"}},
	} {
		getLog(t, f.url, q, http.StatusBadRequest)
	}
}
```

(Add `"fmt"` to the test imports.)

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/webui -run TestWatcherLog -v`
Expected: FAIL.

- [ ] **Step 3: Implement** — append to `watcher_log_api.go` (add `"fmt"`, `"strconv"` imports):

```go
type taggedResourceDTO struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Name string `json:"name"`
}

type pollLogEntryDTO struct {
	ID         int64               `json:"id"`
	TS         string              `json:"ts"`
	Source     string              `json:"source"`
	Level      string              `json:"level"`
	Kind       string              `json:"kind"`
	Message    string              `json:"message"`
	Method     string              `json:"method,omitempty"`
	Endpoint   string              `json:"endpoint,omitempty"`
	HTTPStatus int                 `json:"http_status,omitempty"`
	DurationMS int                 `json:"duration_ms,omitempty"`
	Bytes      int64               `json:"bytes,omitempty"`
	ErrorBody  string              `json:"error_body,omitempty"`
	Resources  []taggedResourceDTO `json:"resources"`
}

var validSources = map[string]bool{"github": true, "jira": true, "slack": true}

func parseID(q string) (int64, error) {
	if q == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(q, 10, 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("invalid id %q", q)
	}
	return n, nil
}

// handleWatcherLog: GET /api/watchers/log — watcher log entries, newest first.
func (s *Server) handleWatcherLog(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	bad := func(msg string) { writeError(w, http.StatusBadRequest, msg) }

	pq := watcherdb.PollLogQuery{Limit: 200}
	switch lv := q.Get("level"); lv {
	case "", "info":
	case "warn", "error":
		pq.MinLevel = lv
	default:
		bad("level must be info, warn, or error")
		return
	}
	for _, src := range q["source"] {
		if !validSources[src] {
			bad("unknown source " + src)
			return
		}
		pq.Sources = append(pq.Sources, src)
	}
	var err error
	if pq.AfterID, err = parseID(q.Get("after_id")); err != nil {
		bad(err.Error())
		return
	}
	if pq.BeforeID, err = parseID(q.Get("before_id")); err != nil {
		bad(err.Error())
		return
	}
	if l := q.Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > 500 {
			bad("limit must be 1..500")
			return
		}
		pq.Limit = n
	}

	scope, scoped, err := s.resolveWatcherScope(r)
	if errors.Is(err, errBadScope) {
		bad(err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	names := map[watcherdb.ResourceKey]string{}
	for _, wr := range scope {
		names[watcherdb.ResourceKey{Type: wr.Type, ID: wr.ID}] = wr.Name
	}
	if scoped {
		pq.ResourceScoped = true
		for _, wr := range scope {
			pq.Resources = append(pq.Resources, wr.Resource)
		}
		// Tags on scoped rows can name resources outside the scope (a GitHub
		// batch row lists every PR); resolve those names too.
		if all, err := s.allWatched(); err == nil {
			for _, wr := range all {
				names[watcherdb.ResourceKey{Type: wr.Type, ID: wr.ID}] = wr.Name
			}
		}
	}

	entries, more, err := watcherdb.QueryPollLog(s.DB, pq)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]pollLogEntryDTO, 0, len(entries))
	for _, e := range entries {
		dto := pollLogEntryDTO{ID: e.ID, TS: e.TS, Source: e.Source, Level: e.Level, Kind: e.Kind,
			Message: e.Message, Method: e.Method, Endpoint: e.Endpoint, HTTPStatus: e.HTTPStatus,
			DurationMS: e.DurationMS, Bytes: e.Bytes, ErrorBody: e.ErrorBody,
			Resources: make([]taggedResourceDTO, 0, len(e.Resources))}
		for _, tr := range e.Resources {
			name := names[watcherdb.ResourceKey{Type: tr.Type, ID: tr.ID}]
			dto.Resources = append(dto.Resources, taggedResourceDTO{Type: tr.Type, ID: tr.ID, Name: firstNonEmpty(name, tr.ID)})
		}
		out = append(out, dto)
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": out, "has_more": more})
}
```

Register after the resources route:

```go
		{"GET /api/watchers/log", s.handleWatcherLog},
```

- [ ] **Step 4: Run tests**

Run: `go test ./internal/webui -run 'TestWatcherLog|TestWatchedResources' -v && make test 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/webui/watcher_log_api.go internal/webui/watcher_log_api_test.go internal/webui/server.go
git commit --signoff -m "feat(webui): GET /api/watchers/log with scope, level, source and cursor filters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: UI types, API client, and log merge helper

**Files:**
- Modify: `ui/src/api/types.ts`, `ui/src/api/client.ts`
- Create: `ui/src/lib/watcherLog.ts`
- Test: `ui/src/lib/watcherLog.test.ts`

**Interfaces:**
- Consumes: Task 10/11 JSON shapes.
- Produces:

```ts
// types.ts
export interface WatcherLogScope {
  worktree?: string
  resource?: { type: string; id: string; name: string }
}
export interface ResourcePollDetail { ok: boolean; duration_ms?: number; http_status?: number; events_emitted: number; note?: string }
export interface WatchedResourceStatus {
  type: string; id: string; url?: string; name: string; worktrees: string[]
  status: "ok" | "error" | "never"
  last_attempt?: string; last_success?: string; last_error?: string; error_message?: string
  detail?: ResourcePollDetail; resource_updated_at?: string
}
export interface PollLogEntry {
  id: number; ts: string; source: "github" | "jira" | "slack"
  level: "info" | "warn" | "error"; kind: "poll" | "http" | "resource"
  message: string; method?: string; endpoint?: string; http_status?: number
  duration_ms?: number; bytes?: number; error_body?: string
  resources: { type: string; id: string; name: string }[]
}
export interface PollLogResponse { entries: PollLogEntry[]; has_more: boolean }
export interface WatcherLogQuery { source?: string; level?: "info" | "warn"; after_id?: number; before_id?: number; limit?: number }

// client.ts (on `api`)
watchedResources: (scope: WatcherLogScope) => Promise<{ resources: WatchedResourceStatus[] }>
watcherLog: (scope: WatcherLogScope, q: WatcherLogQuery) => Promise<PollLogResponse>

// lib/watcherLog.ts
export function scopeParams(scope: WatcherLogScope): URLSearchParams
export function mergeNewer(current: PollLogEntry[], incoming: PollLogEntry[]): PollLogEntry[]
export function appendOlder(current: PollLogEntry[], older: PollLogEntry[]): PollLogEntry[]
export function formatBytes(n: number): string
export function httpSummary(e: PollLogEntry): string | null
```

- [ ] **Step 1: Write the failing test** — `ui/src/lib/watcherLog.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import type { PollLogEntry } from "../api/types"
import { appendOlder, formatBytes, httpSummary, mergeNewer, scopeParams } from "./watcherLog"

const e = (id: number, over: Partial<PollLogEntry> = {}): PollLogEntry => ({
  id, ts: "2026-10-13T13:18:32.000000Z", source: "github", level: "info", kind: "poll",
  message: `m${id}`, resources: [], ...over,
})

describe("scopeParams", () => {
  it("resource wins over worktree", () => {
    const p = scopeParams({ worktree: "/w", resource: { type: "slack", id: "C1:1.2", name: "t" } })
    expect(p.get("resource")).toBe("slack:C1:1.2")
    expect(p.has("worktree")).toBe(false)
  })
  it("worktree only", () => expect(scopeParams({ worktree: "/w" }).get("worktree")).toBe("/w"))
  it("unscoped is empty", () => expect(scopeParams({}).toString()).toBe(""))
})

describe("mergeNewer / appendOlder", () => {
  it("prepends newer rows without duplicates, newest first", () => {
    expect(mergeNewer([e(3), e(2)], [e(5), e(4), e(3)]).map((x) => x.id)).toEqual([5, 4, 3, 2])
  })
  it("appends older rows without duplicates", () => {
    expect(appendOlder([e(5), e(4)], [e(4), e(2), e(1)]).map((x) => x.id)).toEqual([5, 4, 2, 1])
  })
})

describe("httpSummary", () => {
  it("formats an http row", () => {
    const row = e(1, { kind: "http", method: "POST", endpoint: "api.github.com/graphql", http_status: 504, duration_ms: 12300, bytes: 1229 })
    expect(httpSummary(row)).toBe("POST api.github.com/graphql → 504 · 12.3 s · 1.2 KB")
  })
  it("transport failure has no status", () => {
    expect(httpSummary(e(1, { kind: "http", method: "GET", endpoint: "x/y", duration_ms: 40 }))).toBe("GET x/y → failed · 40 ms")
  })
  it("non-http rows return null", () => expect(httpSummary(e(1))).toBeNull())
})

describe("formatBytes", () => {
  it.each([[512, "512 B"], [1229, "1.2 KB"], [3_400_000, "3.2 MB"]])("%d → %s", (n, s) => expect(formatBytes(n)).toBe(s))
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/lib/watcherLog.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Add the types above to `ui/src/api/types.ts` (next to `WatchersResponse`). Implement `ui/src/lib/watcherLog.ts`:

```ts
import type { PollLogEntry, WatcherLogScope } from "../api/types"

/** Query params for a watcher log scope. A resource scope wins over a worktree. */
export function scopeParams(scope: WatcherLogScope): URLSearchParams {
  const p = new URLSearchParams()
  if (scope.resource) p.set("resource", `${scope.resource.type}:${scope.resource.id}`)
  else if (scope.worktree) p.set("worktree", scope.worktree)
  return p
}

function dedupeDesc(rows: PollLogEntry[]): PollLogEntry[] {
  const seen = new Set<number>()
  return rows
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .sort((a, b) => b.id - a.id)
}

/** Merge rows fetched with after_id into the newest-first list. */
export function mergeNewer(current: PollLogEntry[], incoming: PollLogEntry[]): PollLogEntry[] {
  return dedupeDesc([...incoming, ...current])
}

/** Merge rows fetched with before_id onto the end of the list. */
export function appendOlder(current: PollLogEntry[], older: PollLogEntry[]): PollLogEntry[] {
  return dedupeDesc([...current, ...older])
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** "POST api.github.com/graphql → 504 · 12.3 s · 1.2 KB", or null for non-http rows. */
export function httpSummary(e: PollLogEntry): string | null {
  if (e.kind !== "http") return null
  const parts = [`${e.method ?? ""} ${e.endpoint ?? ""} → ${e.http_status ?? "failed"}`]
  if (e.duration_ms) parts.push(formatDuration(e.duration_ms))
  if (e.bytes) parts.push(formatBytes(e.bytes))
  return parts.join(" · ")
}
```

Add to `api` in `ui/src/api/client.ts` (after `pollWatchers`), importing the new types and `scopeParams`:

```ts
  watchedResources: (scope: WatcherLogScope) =>
    fetchJSON<{ resources: WatchedResourceStatus[] }>(`/api/watchers/resources?${scopeParams(scope)}`),
  watcherLog: (scope: WatcherLogScope, q: WatcherLogQuery) => {
    const p = scopeParams(scope)
    if (q.source) p.set("source", q.source)
    if (q.level && q.level !== "info") p.set("level", q.level)
    if (q.after_id) p.set("after_id", String(q.after_id))
    if (q.before_id) p.set("before_id", String(q.before_id))
    if (q.limit) p.set("limit", String(q.limit))
    return fetchJSON<PollLogResponse>(`/api/watchers/log?${p}`)
  },
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd ui && npx vitest run src/lib/watcherLog.test.ts && npx tsc --noEmit -p .`
Expected: PASS, no type errors. (Check `ui/package.json` for a `typecheck` script and prefer it if present.)

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/types.ts ui/src/api/client.ts ui/src/lib/watcherLog.ts ui/src/lib/watcherLog.test.ts
git commit --signoff -m "feat(ui): watcher log API client, types, and merge helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: `WatcherLogButton` + modal shell + placements

**Files:**
- Create: `ui/src/components/WatcherLogButton.tsx`, `ui/src/components/watcherlog/WatcherLogModal.tsx`
- Modify: `ui/src/pages/HomePage.tsx:140`, `ui/src/pages/WorktreeDetailPage.tsx:229`, `ui/src/components/ResourceDetailPane.tsx:149`
- Test: `ui/src/components/WatcherLogButton.test.tsx`

**Interfaces:**
- Consumes: `WatcherLogScope`, `api.watchedResources`, `api.watcherLog` (Task 12).
- Produces: `WatcherLogButton({ scope }: { scope: WatcherLogScope })`; `WatcherLogModal({ scope, onClose }: { scope: WatcherLogScope; onClose: () => void })` rendering tabs `log` and `status` whose panels are `LogTab` / `ResourceStatusTab` with props `{ scope: WatcherLogScope }` (built in Tasks 14–15; this task creates them as minimal stubs rendering `null` so the shell compiles, and Tasks 14–15 replace the stub bodies).

- [ ] **Step 1: Write the failing test** — `ui/src/components/WatcherLogButton.test.tsx` (copy the `matchMedia` polyfill block from `AddResourceModal.test.tsx` to the top):

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WatcherLogButton } from "./WatcherLogButton"

const watchedResources = vi.fn()
const watcherLog = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return {
    api: {
      ...actual.api,
      watchedResources: (...a: unknown[]) => watchedResources(...a),
      watcherLog: (...a: unknown[]) => watcherLog(...a),
    },
  }
})

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MantineProvider>{ui}</MantineProvider>
    </QueryClientProvider>,
  )

beforeEach(() => {
  watchedResources.mockResolvedValue({ resources: [] })
  watcherLog.mockResolvedValue({ entries: [], has_more: false })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  watchedResources.mockReset()
  watcherLog.mockReset()
})

describe("WatcherLogButton", () => {
  it("fetches nothing until opened", () => {
    wrap(<WatcherLogButton scope={{}} />)
    expect(watcherLog).not.toHaveBeenCalled()
    expect(watchedResources).not.toHaveBeenCalled()
  })

  it("opens scoped to a resource and can widen to all", async () => {
    const user = userEvent.setup()
    wrap(<WatcherLogButton scope={{ worktree: "/w", resource: { type: "pr", id: "o/r#1", name: "Fix it" } }} />)
    await user.click(screen.getByRole("button", { name: "Watcher log" }))
    expect(await screen.findByText("This PR: Fix it")).toBeTruthy()
    expect(watcherLog).toHaveBeenCalledWith({ worktree: "/w", resource: { type: "pr", id: "o/r#1", name: "Fix it" } }, expect.anything())
    await user.click(screen.getByRole("button", { name: "Show all" }))
    expect(await screen.findByText("All resources")).toBeTruthy()
    expect(watcherLog).toHaveBeenLastCalledWith({}, expect.anything())
  })

  it("labels a worktree scope", async () => {
    const user = userEvent.setup()
    wrap(<WatcherLogButton scope={{ worktree: "/w" }} />)
    await user.click(screen.getByRole("button", { name: "Watcher log" }))
    expect(await screen.findByText("This worktree")).toBeTruthy()
  })

  it("stops requesting after close", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    wrap(<WatcherLogButton scope={{}} />)
    await user.click(screen.getByRole("button", { name: "Watcher log" }))
    await screen.findByText("All resources")
    await user.keyboard("{Escape}")
    const calls = watcherLog.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    expect(watcherLog.mock.calls.length).toBe(calls)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/components/WatcherLogButton.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.**

`ui/src/components/WatcherLogButton.tsx`:

```tsx
import { useState } from "react"
import { ActionIcon, Tooltip } from "@mantine/core"
import { IconListDetails } from "@tabler/icons-react"
import type { WatcherLogScope } from "../api/types"
import { WatcherLogModal } from "./watcherlog/WatcherLogModal"

/**
 * Opens the watcher log. The modal is mounted only while open, so the log and
 * status queries — and their polling — exist only then. Nothing here costs a
 * request on an ordinary page view.
 */
export function WatcherLogButton({ scope }: { scope: WatcherLogScope }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tooltip label="Watcher log">
        <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Watcher log" onClick={() => setOpen(true)}>
          <IconListDetails size={16} />
        </ActionIcon>
      </Tooltip>
      {open && <WatcherLogModal scope={scope} onClose={() => setOpen(false)} />}
    </>
  )
}
```

`ui/src/components/watcherlog/WatcherLogModal.tsx`:

```tsx
import { useState } from "react"
import { Badge, Button, Group, Modal, Tabs } from "@mantine/core"
import type { WatcherLogScope } from "../../api/types"
import { LogTab } from "./LogTab"
import { ResourceStatusTab } from "./ResourceStatusTab"

const RESOURCE_LABEL: Record<string, string> = { pr: "This PR", jira: "This issue", slack: "This thread" }

export function scopeLabel(scope: WatcherLogScope): string {
  if (scope.resource) return `${RESOURCE_LABEL[scope.resource.type] ?? "This resource"}: ${scope.resource.name}`
  if (scope.worktree) return "This worktree"
  return "All resources"
}

export function WatcherLogModal({ scope: initial, onClose }: { scope: WatcherLogScope; onClose: () => void }) {
  const [scope, setScope] = useState<WatcherLogScope>(initial)
  const scoped = !!(scope.resource || scope.worktree)
  return (
    <Modal
      opened
      onClose={onClose}
      size="xl"
      title={
        <Group gap="xs">
          <span>Watcher log</span>
          <Badge variant="light" color="gray" tt="none">{scopeLabel(scope)}</Badge>
          {scoped && (
            <Button size="compact-xs" variant="subtle" onClick={() => setScope({})}>
              Show all
            </Button>
          )}
        </Group>
      }
    >
      <Tabs defaultValue="log" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="log">Log</Tabs.Tab>
          <Tabs.Tab value="status">Resource Status</Tabs.Tab>
        </Tabs.List>
        {/* key: widening the scope resets each tab's state and cursors. */}
        <Tabs.Panel value="log" pt="sm">
          <LogTab key={JSON.stringify(scope)} scope={scope} />
        </Tabs.Panel>
        <Tabs.Panel value="status" pt="sm">
          <ResourceStatusTab key={JSON.stringify(scope)} scope={scope} />
        </Tabs.Panel>
      </Tabs>
    </Modal>
  )
}
```

Temporary stubs (replaced in Tasks 14–15) so this compiles and the test can observe calls:

`ui/src/components/watcherlog/LogTab.tsx`:

```tsx
import { useEffect } from "react"
import { api } from "../../api/client"
import type { WatcherLogScope } from "../../api/types"

export function LogTab({ scope }: { scope: WatcherLogScope }) {
  useEffect(() => {
    void api.watcherLog(scope, { limit: 200 })
    const t = setInterval(() => void api.watcherLog(scope, { limit: 200 }), 3000)
    return () => clearInterval(t)
  }, [scope])
  return null
}
```

`ui/src/components/watcherlog/ResourceStatusTab.tsx`:

```tsx
import type { WatcherLogScope } from "../../api/types"

export function ResourceStatusTab(_: { scope: WatcherLogScope }) {
  return null
}
```

Placements — immediately after each `<RefreshWatchersButton />`:

- `HomePage.tsx`: `<WatcherLogButton scope={{}} />`
- `WorktreeDetailPage.tsx`: `<WatcherLogButton scope={{ worktree: path }} />` (use the page's existing worktree path variable — the same one passed to its timeline query)
- `ResourceDetailPane.tsx`: `<WatcherLogButton scope={{ worktree: path, resource: { type: resource.type, id: resource.id, name: resource.custom_name || resource.title || resource.id } }} />`

Import `WatcherLogButton` in each file.

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run src/components/WatcherLogButton.test.tsx src/components/RefreshWatchersButton.test.tsx`
Expected: PASS. Also run the existing page/pane tests that render these headers (`npx vitest run src/pages src/components/ResourceDetailPane`) — if any assert an exact button count in the header, update them to include the new button.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/WatcherLogButton.tsx ui/src/components/WatcherLogButton.test.tsx ui/src/components/watcherlog/ ui/src/pages/HomePage.tsx ui/src/pages/WorktreeDetailPage.tsx ui/src/components/ResourceDetailPane.tsx
git commit --signoff -m "feat(ui): watcher log button and scoped modal shell

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: Log tab

**Files:**
- Modify: `ui/src/components/watcherlog/LogTab.tsx` (replace stub)
- Test: `ui/src/components/watcherlog/LogTab.test.tsx`

**Interfaces:**
- Consumes: `api.watcherLog`, `mergeNewer`, `appendOlder`, `httpSummary` (Task 12).
- Produces: `LogTab({ scope })`.

Behavior: initial fetch (limit 200); every 3 s fetch `after_id = entries[0]?.id` and `mergeNewer`; if the scroll viewport's `scrollTop > 0` when new rows arrive, count them into a "N new" pill (click → scroll to top, reset). Source `SegmentedControl` (All/GitHub/Jira/Slack) and an "Errors & warnings only" `Switch` (level `warn`); changing either resets entries and refetches. "Load older" (shown while `hasMore`) fetches `before_id = last id` and `appendOlder`. Rows: `HH:mm:ss` time (full ts in `title`), source label, level dot (gray/yellow/red), and the `httpSummary` or the message. Rows with `error_body` or `resources.length` are clickable and toggle a detail block showing the body (monospace) and resource names. Empty state "No watcher activity recorded yet."

- [ ] **Step 1: Write the failing test** — `LogTab.test.tsx` (same mock + `wrap` + `matchMedia` setup as Task 13's test, mocking only `watcherLog`):

```tsx
const row = (id: number, over: Partial<PollLogEntry> = {}): PollLogEntry => ({
  id, ts: "2026-10-13T13:18:32.000000Z", source: "github", level: "info", kind: "poll",
  message: `row ${id}`, resources: [], ...over,
})

it("renders http summaries and expands an error row", async () => {
  watcherLog.mockResolvedValue({
    entries: [row(2, { kind: "http", level: "error", method: "POST", endpoint: "api.github.com/graphql", http_status: 504,
      duration_ms: 12300, error_body: "Unicorn! · GitHub", resources: [{ type: "pr", id: "o/r#1", name: "Fix it" }] }), row(1)],
    has_more: false,
  })
  const user = userEvent.setup()
  wrap(<LogTab scope={{}} />)
  expect(await screen.findByText("POST api.github.com/graphql → 504 · 12.3 s")).toBeTruthy()
  expect(screen.queryByText("Unicorn! · GitHub")).toBeNull()
  await user.click(screen.getByText("POST api.github.com/graphql → 504 · 12.3 s"))
  expect(screen.getByText("Unicorn! · GitHub")).toBeTruthy()
  expect(screen.getByText("Fix it")).toBeTruthy()
})

it("polls with after_id and prepends without duplicates", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  watcherLog.mockResolvedValueOnce({ entries: [row(2), row(1)], has_more: false })
  watcherLog.mockResolvedValue({ entries: [row(3), row(2)], has_more: false })
  wrap(<LogTab scope={{}} />)
  await screen.findByText("row 2")
  await act(async () => { vi.advanceTimersByTime(3000) })
  expect(watcherLog).toHaveBeenLastCalledWith({}, expect.objectContaining({ after_id: 2 }))
  expect(await screen.findByText("row 3")).toBeTruthy()
  expect(screen.getAllByText("row 2")).toHaveLength(1)
})

it("filter change resets and refetches with level warn", async () => {
  watcherLog.mockResolvedValue({ entries: [row(1)], has_more: false })
  const user = userEvent.setup()
  wrap(<LogTab scope={{}} />)
  await screen.findByText("row 1")
  await user.click(screen.getByRole("switch", { name: "Errors & warnings only" }))
  expect(watcherLog).toHaveBeenLastCalledWith({}, expect.objectContaining({ level: "warn" }))
})

it("load older uses before_id", async () => {
  watcherLog.mockResolvedValueOnce({ entries: [row(5), row(4)], has_more: true })
  watcherLog.mockResolvedValue({ entries: [row(3)], has_more: false })
  const user = userEvent.setup()
  wrap(<LogTab scope={{}} />)
  await user.click(await screen.findByRole("button", { name: "Load older" }))
  expect(watcherLog).toHaveBeenLastCalledWith({}, expect.objectContaining({ before_id: 4 }))
  expect(await screen.findByText("row 3")).toBeTruthy()
})

it("shows empty state", async () => {
  watcherLog.mockResolvedValue({ entries: [], has_more: false })
  wrap(<LogTab scope={{}} />)
  expect(await screen.findByText("No watcher activity recorded yet.")).toBeTruthy()
})
```

(The "N new" pill depends on real scroll geometry jsdom doesn't provide; it is exercised manually in Task 16's verification.)

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/components/watcherlog/LogTab.test.tsx`
Expected: FAIL (stub renders nothing).

- [ ] **Step 3: Implement** `LogTab.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react"
import { Box, Button, Code, Group, ScrollArea, SegmentedControl, Stack, Switch, Text, UnstyledButton } from "@mantine/core"
import { api } from "../../api/client"
import type { PollLogEntry, WatcherLogScope } from "../../api/types"
import { appendOlder, httpSummary, mergeNewer } from "../../lib/watcherLog"

const POLL_MS = 3000
const PAGE = 200
const LEVEL_COLOR: Record<PollLogEntry["level"], string> = {
  info: "var(--mantine-color-gray-6)",
  warn: "var(--mantine-color-yellow-6)",
  error: "var(--mantine-color-red-6)",
}
const SOURCE_LABEL: Record<string, string> = { github: "GitHub", jira: "Jira", slack: "Slack" }

function clock(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString([], { hour12: false })
}

export function LogTab({ scope }: { scope: WatcherLogScope }) {
  const [source, setSource] = useState("all")
  const [warnOnly, setWarnOnly] = useState(false)
  const [entries, setEntries] = useState<PollLogEntry[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [newCount, setNewCount] = useState(0)
  const viewport = useRef<HTMLDivElement>(null)
  const newest = useRef(0)

  const query = useCallback(
    (extra: { after_id?: number; before_id?: number }) =>
      api.watcherLog(scope, {
        source: source === "all" ? undefined : source,
        level: warnOnly ? "warn" : undefined,
        limit: PAGE,
        ...extra,
      }),
    [scope, source, warnOnly],
  )

  useEffect(() => {
    let cancelled = false
    setEntries([])
    setLoaded(false)
    setNewCount(0)
    newest.current = 0
    void query({}).then((r) => {
      if (cancelled) return
      setEntries(r.entries)
      setHasMore(r.has_more)
      setLoaded(true)
      newest.current = r.entries[0]?.id ?? 0
    })
    const t = setInterval(() => {
      void query({ after_id: newest.current || undefined }).then((r) => {
        if (cancelled || r.entries.length === 0) return
        const fresh = r.entries.filter((e) => e.id > newest.current).length
        newest.current = Math.max(newest.current, r.entries[0].id)
        setEntries((cur) => mergeNewer(cur, r.entries))
        if ((viewport.current?.scrollTop ?? 0) > 0) setNewCount((n) => n + fresh)
      })
    }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [query])

  const loadOlder = () => {
    const last = entries[entries.length - 1]
    if (!last) return
    void query({ before_id: last.id }).then((r) => {
      setEntries((cur) => appendOlder(cur, r.entries))
      setHasMore(r.has_more)
    })
  }

  const toggle = (id: number) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <SegmentedControl
          size="xs"
          value={source}
          onChange={setSource}
          data={[
            { value: "all", label: "All" },
            { value: "github", label: "GitHub" },
            { value: "jira", label: "Jira" },
            { value: "slack", label: "Slack" },
          ]}
        />
        <Switch size="xs" label="Errors & warnings only" checked={warnOnly} onChange={(e) => setWarnOnly(e.currentTarget.checked)} />
      </Group>
      {newCount > 0 && (
        <Button
          size="compact-xs"
          variant="light"
          style={{ alignSelf: "center" }}
          onClick={() => {
            viewport.current?.scrollTo({ top: 0 })
            setNewCount(0)
          }}
        >
          {newCount} new
        </Button>
      )}
      <ScrollArea h="60vh" viewportRef={viewport} onScrollPositionChange={({ y }) => y === 0 && setNewCount(0)}>
        {loaded && entries.length === 0 && (
          <Text size="sm" c="dimmed" ta="center" py="lg">
            No watcher activity recorded yet.
          </Text>
        )}
        <Stack gap={2}>
          {entries.map((e) => {
            const expandable = !!e.error_body || e.resources.length > 0
            const line = (
              <Group gap="xs" wrap="nowrap" align="baseline">
                <Text size="xs" c="dimmed" ff="monospace" title={e.ts} style={{ flex: "none" }}>
                  {clock(e.ts)}
                </Text>
                <Box w={8} h={8} style={{ borderRadius: 4, background: LEVEL_COLOR[e.level], flex: "none" }} aria-label={e.level} />
                <Text size="xs" c="dimmed" w={48} style={{ flex: "none" }}>
                  {SOURCE_LABEL[e.source] ?? e.source}
                </Text>
                <Text size="xs" ff={e.kind === "http" ? "monospace" : undefined} style={{ wordBreak: "break-word" }}>
                  {httpSummary(e) ?? e.message}
                </Text>
              </Group>
            )
            return (
              <Box key={e.id}>
                {expandable ? <UnstyledButton onClick={() => toggle(e.id)} w="100%">{line}</UnstyledButton> : line}
                {expanded.has(e.id) && (
                  <Stack gap={4} pl={96} py={4}>
                    {e.error_body && <Code block>{e.error_body}</Code>}
                    {e.resources.length > 0 && (
                      <Text size="xs" c="dimmed">
                        {e.resources.map((r) => r.name).join(", ")}
                      </Text>
                    )}
                  </Stack>
                )}
              </Box>
            )
          })}
        </Stack>
        {hasMore && (
          <Group justify="center" py="xs">
            <Button size="compact-xs" variant="subtle" onClick={loadOlder}>
              Load older
            </Button>
          </Group>
        )}
      </ScrollArea>
    </Stack>
  )
}
```

The resource names in the expanded block render as one joined string; the test's `getByText("Fix it")` matches because only one resource is tagged. If Mantine's `Switch` does not expose `role="switch"` with the label as its accessible name in this Mantine version, query it with `getByLabelText("Errors & warnings only")` instead.

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run src/components/watcherlog src/components/WatcherLogButton.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/watcherlog/LogTab.tsx ui/src/components/watcherlog/LogTab.test.tsx
git commit --signoff -m "feat(ui): live watcher log tab with filters, expansion, and paging

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: Resource Status tab

**Files:**
- Modify: `ui/src/components/watcherlog/ResourceStatusTab.tsx` (replace stub)
- Test: `ui/src/components/watcherlog/ResourceStatusTab.test.tsx`

**Interfaces:**
- Consumes: `api.watchedResources` (Task 12); `relativeTime` from `ui/src/lib/relativeTime.ts` (check its export name and signature before use).
- Produces: `ResourceStatusTab({ scope })`.

- [ ] **Step 1: Write the failing test** — `ResourceStatusTab.test.tsx` (same setup as Task 13, mocking `watchedResources`):

```tsx
const res = (over: Partial<WatchedResourceStatus>): WatchedResourceStatus => ({
  type: "pr", id: "o/r#1", name: "Fix it", worktrees: ["/w"], status: "ok", ...over,
})

it("renders rows in server order with status icons and names linked", async () => {
  watchedResources.mockResolvedValue({
    resources: [
      res({ type: "slack", id: "C1:1.2", name: "Thread", status: "error", error_message: "Failed to fetch thread: slack error: thread_not_found",
        last_error: "2026-10-13T06:04:23.000000Z", url: "https://x.slack.com/archives/C1/p12" }),
      res({ last_success: new Date().toISOString(), url: "https://github.com/o/r/pull/1" }),
      res({ type: "jira", id: "ABC-1", name: "ABC-1", status: "never" }),
    ],
  })
  wrap(<ResourceStatusTab scope={{}} />)
  const rows = await screen.findAllByRole("row")
  expect(rows.slice(1).map((r) => r.textContent)).toEqual([
    expect.stringContaining("Thread"),
    expect.stringContaining("Fix it"),
    expect.stringContaining("ABC-1"),
  ])
  expect(screen.getByLabelText("error")).toBeTruthy()
  expect(screen.getByLabelText("ok")).toBeTruthy()
  expect(screen.getByLabelText("never polled")).toBeTruthy()
  expect(screen.getByText("Never")).toBeTruthy()
  expect(screen.getByRole("link", { name: "Fix it" }).getAttribute("href")).toBe("https://github.com/o/r/pull/1")
})

it("tooltip shows last poll details", async () => {
  watchedResources.mockResolvedValue({
    resources: [res({ status: "error", error_message: "GitHub API error: Unicorn! · GitHub", last_attempt: "2026-10-13T13:18:32.000000Z",
      detail: { ok: false, http_status: 504, duration_ms: 12300, events_emitted: 0 } })],
  })
  const user = userEvent.setup()
  wrap(<ResourceStatusTab scope={{}} />)
  await user.hover(await screen.findByLabelText("error"))
  expect(await screen.findByText(/GitHub API error: Unicorn! · GitHub/)).toBeTruthy()
  expect(screen.getByText(/HTTP 504/)).toBeTruthy()
  expect(screen.getByText(/12.3 s/)).toBeTruthy()
})

it("empty state", async () => {
  watchedResources.mockResolvedValue({ resources: [] })
  wrap(<ResourceStatusTab scope={{}} />)
  expect(await screen.findByText("No resources are being watched.")).toBeTruthy()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/components/watcherlog/ResourceStatusTab.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** `ResourceStatusTab.tsx`:

```tsx
import { Anchor, Stack, Table, Text, Tooltip } from "@mantine/core"
import { IconAlertTriangleFilled, IconCircleCheckFilled, IconMinus } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { WatchedResourceStatus, WatcherLogScope } from "../../api/types"
import { relativeTime } from "../../lib/relativeTime"

const SOURCE_LABEL: Record<string, string> = { pr: "GitHub", jira: "Jira", slack: "Slack" }

function fmtTime(ts?: string): string {
  if (!ts) return "—"
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString()
}

function StatusIcon({ r }: { r: WatchedResourceStatus }) {
  const d = r.detail
  const lines = [
    `Last attempt: ${fmtTime(r.last_attempt)}`,
    `Outcome: ${r.status === "never" ? "never polled" : d?.ok ? "success" : "failed"}`,
    d?.duration_ms ? `Duration: ${(d.duration_ms / 1000).toFixed(1)} s` : null,
    d?.http_status ? `HTTP ${d.http_status}` : null,
    d ? `Events emitted: ${d.events_emitted}` : null,
    r.status === "error" && r.error_message ? `Error: ${r.error_message}` : null,
    r.status !== "error" && r.last_error ? `Last failed: ${fmtTime(r.last_error)}` : null,
    d?.note ? `Note: ${d.note}` : null,
    r.resource_updated_at ? `Resource last changed: ${fmtTime(r.resource_updated_at)}` : null,
  ].filter(Boolean) as string[]
  const icon =
    r.status === "error" ? (
      <Text span c="red" aria-label="error" style={{ display: "inline-flex" }}><IconAlertTriangleFilled size={14} /></Text>
    ) : r.status === "ok" ? (
      <Text span c="green" aria-label="ok" style={{ display: "inline-flex" }}><IconCircleCheckFilled size={14} /></Text>
    ) : (
      <Text span c="dimmed" aria-label="never polled" style={{ display: "inline-flex" }}><IconMinus size={14} /></Text>
    )
  return (
    <Tooltip multiline w={320} withArrow label={<Stack gap={2}>{lines.map((l) => <Text key={l} size="xs">{l}</Text>)}</Stack>}>
      {icon}
    </Tooltip>
  )
}

export function ResourceStatusTab({ scope }: { scope: WatcherLogScope }) {
  const { data, isLoading } = useQuery({
    queryKey: ["watcher-resources", scope],
    queryFn: () => api.watchedResources(scope),
    refetchInterval: 10_000,
  })
  const rows = data?.resources ?? []
  if (!isLoading && rows.length === 0) {
    return <Text size="sm" c="dimmed" ta="center" py="lg">No resources are being watched.</Text>
  }
  return (
    <Table.ScrollContainer minWidth={480} mah="60vh">
      <Table striped highlightOnHover verticalSpacing={4} fz="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Source</Table.Th>
            <Table.Th>Resource</Table.Th>
            <Table.Th>Updated</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r) => (
            <Table.Tr key={`${r.type}:${r.id}`}>
              <Table.Td>{SOURCE_LABEL[r.type] ?? r.type}</Table.Td>
              <Table.Td>
                {r.url ? <Anchor href={r.url} target="_blank" rel="noreferrer" size="xs">{r.name}</Anchor> : r.name}
              </Table.Td>
              <Table.Td>{r.last_success ? relativeTime(r.last_success) : "Never"}</Table.Td>
              <Table.Td><StatusIcon r={r} /></Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  )
}
```

The query key includes `scope`, so the tab caches per scope; because the modal is unmounted on close and TanStack Query's interval only runs while an observer is mounted, polling stops on close.

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run src/components/watcherlog src/components/WatcherLogButton.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/watcherlog/ResourceStatusTab.tsx ui/src/components/watcherlog/ResourceStatusTab.test.tsx
git commit --signoff -m "feat(ui): watcher resource status tab with last-poll tooltips

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 16: Docs, full verification, install

**Files:**
- Modify: `docs/web-ui-architecture.md`, `.claude/CLAUDE.md`

- [ ] **Step 1: Document.** In `docs/web-ui-architecture.md`, add a "Watcher log" section: the two routes and their query params, both DTOs, the scoping rule (resource wins over worktree; worktree canonicalized via `wdb.Subscriber`; scoped log views include untagged poll rows of the scope's sources), the "only while the modal is open" constraint (3 s / 10 s polling, nothing on page load), and that data comes from watcher ≥ v0.13.0 tables written by the library. In `.claude/CLAUDE.md`'s `webui` bullet, add: "also serves the watcher log modal's read-only `/api/watchers/resources` and `/api/watchers/log` (see `docs/web-ui-architecture.md` "Watcher log"; requires watcher ≥ v0.13.0)."

- [ ] **Step 2: Full verification**

Run: `make test && (cd ui && npx vitest run) && make build`
Expected: all pass; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add docs/web-ui-architecture.md .claude/CLAUDE.md
git commit --signoff -m "docs: watcher log modal architecture notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Install and check in the real app.** Run `NONINTERACTIVE=1 make install` (the UI restarts itself within ~5 s). Wait for one poll cycle, then open the UI and verify:
  - home page: the Watcher log button opens "All resources"; the Log tab shows `github/jira/slack poll started/finished` rows and http rows; the Resource Status tab lists every watched resource;
  - a resource's Activity tab: the modal opens scoped ("This PR: …") and shows only that PR's rows plus GitHub lifecycle rows; Show all widens it;
  - scroll down in the Log tab and wait 3 s: an "N new" pill appears and jumps to the top;
  - the browser network panel shows no `/api/watchers/log` or `/api/watchers/resources` requests with the modal closed.

  Report the results to Mike. Do not merge or push the branch; use superpowers:finishing-a-development-branch for that decision.
