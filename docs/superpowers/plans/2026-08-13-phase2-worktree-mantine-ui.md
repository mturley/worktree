# Phase 2 — Worktree Mantine Web UI Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web UI for the `worktree` CLI — a worktree **list + global timeline** view and a per-worktree **detail** view (resource list + scoped timeline) for pr/jira — served by a `worktree ui` command from a Go-embedded Vite/Mantine/React 19 frontend, with the UI-server process owning the pr/jira polling loop.

**Architecture:** Mirror the delivery model proven in agent-handler and slack-mini: a `ui/` Vite project (Mantine + React 19) builds to `ui/dist`, embedded into the Go binary via `//go:embed all:ui/dist` in a root `web_embed.go` handed to the `cmd` package through a `SetWebFS` setter. A `worktree ui` cobra command starts an `http.ServeMux` serving `/api/*` JSON endpoints + an SSE `/api/stream` cache-invalidation signal + an SPA static handler. The server reads the Phase-1 SQLite DB (worktrees/ports/resources + `watcher_events`) and runs an in-process polling loop (interval + poll-on-view-if-stale) using the watcher library's `github.Poll`/`jira.Poll`. No background scheduler; a stale DB while the server is down is acceptable (CC-1).

**Tech Stack:** Go 1.26 + `net/http` ServeMux (Go 1.22 method patterns) + `//go:embed`; `github.com/mturley/watcher` (v0.2.4, read API + pollers); Vite 6 + React 19 + `@mantine/core`/`@mantine/hooks` 7 + `@tanstack/react-query` 5; SSE via `EventSource`.

## Global Constraints

- **Ports:** UI server prod default **8475** (flag `--port`); Vite dev server **5175** (proxies `/api` → `http://localhost:8475`). MUST avoid: 8420/5173 (agent-handler), 8473/5174 (slack-mini), 4010 (odh-dashboard default), and the 4020+ worktree allocation range. Auto-open the browser on start; `--no-open` suppresses it.
- **Scope: pr/jira ONLY.** No Slack, no slack-mini fold-in (that is Phase 3). Do not add slack resource types, tabs, or dependencies.
- **DB is read via the Phase-1 `internal/db` package** (`db.Open() (*sql.DB, error)`), which opens `${XDG_DATA_HOME:-~/.local/share}/worktree/worktree.db` and runs migrations. The UI server opens ONE `*sql.DB` and shares it (SQLite with `busy_timeout(5000)` already set by `db.Open`). Reads and the poll loop share this handle.
- **Polling model (CC-1):** the UI-server process owns polling. A background goroutine polls ALL active pr/jira resources every **2 minutes** while the server runs. Additionally, opening a worktree detail view triggers an on-demand poll of THAT worktree's resources **only if** its newest event/state is older than **1 minute** (poll-on-view-if-stale). No launchd/cron/scheduler. DB going stale while the server is down is acceptable.
- **Global timeline** shows events across all managed worktrees, newest-first, each event attributed to the worktree(s) whose subscriptions include its resource. A **"Show archived"** toggle (default OFF) additionally includes events for resources no longer watched by any worktree; its tooltip text is exactly: `Show past events for resources no longer being watched by a worktree`.
- **watcher library is unmodified.** No global-events helper exists in the library; the server queries `watcher_events`/`watcher_event_resources` directly, replicating the library's bookkeeping-type exclusion (`type NOT IN ('watch_started','watcher_error')`) and RFC3339 `ts` ordering. Per-worktree scoped reads use `watcherdb.EventsForSubscriberSince`.
- **Frontend embed placeholder:** commit `ui/dist/.gitkeep`, gitignore the rest of `ui/dist`; Vite config sets `emptyOutDir: false` so the placeholder survives builds. `//go:embed all:ui/dist` must compile on a fresh checkout.
- **Go build stays green throughout** (`go build ./...`, `go test ./...`). The frontend build (`make build-web`) is a separate step; `go build` embeds whatever is in `ui/dist` at compile time (the `.gitkeep` makes it always compile).
- **JSON field naming:** all API response structs use explicit lowercase `json:"..."` tags on every field (avoid Go's default PascalCase — a documented slack-mini wire-format wart to not repeat). Empty lists serialize as `[]`, never `null`.

---

## File Structure

**Go (server) — new package `internal/webui` + a `cmd/ui.go` command + root embed:**
- `web_embed.go` (repo root, `package main`) — `//go:embed all:ui/dist` → `embed.FS`; passed to `cmd` via setter.
- `cmd/ui.go` — cobra `worktree ui` command: flags, DB open, browser-open, start server.
- `internal/webui/server.go` — `Server` struct, `Start()`, mux wiring, SPA static handler, `writeJSON`/`writeError` helpers.
- `internal/webui/timeline.go` — global + per-worktree timeline queries (raw SQL for global, library helper for scoped), the `TimelineEvent` DTO, resource-state title enrichment.
- `internal/webui/worktrees.go` — worktree list endpoint (registry + per-worktree resource/last-event summary).
- `internal/webui/resources_api.go` — per-worktree resource list endpoint (reuses `internal/resources`).
- `internal/webui/poller.go` — in-process poll loop (interval) + poll-on-view-if-stale helper; wraps `github.Poll`/`jira.Poll` with creds from watcher config.
- `internal/webui/stream.go` — SSE `/api/stream` handler (poll `MAX(ts)`, emit `events_new`/`heartbeat`).
- `internal/webui/server_test.go`, `timeline_test.go`, `poller_test.go` — Go tests (httptest + a seeded temp DB).

**Frontend — new `ui/` Vite project:**
- `ui/package.json`, `ui/vite.config.ts`, `ui/tsconfig*.json`, `ui/index.html`, `ui/dist/.gitkeep`.
- `ui/src/main.tsx` — MantineProvider + QueryClientProvider + router.
- `ui/src/theme.ts` — Mantine theme.
- `ui/src/api/client.ts`, `ui/src/api/types.ts` — typed fetch client + response types.
- `ui/src/hooks/useSSE.ts`, `useWorktrees.ts`, `useTimeline.ts`, `useWorktreeDetail.ts`.
- `ui/src/pages/HomePage.tsx` (list + global timeline), `ui/src/pages/WorktreeDetailPage.tsx` (resource list + scoped timeline).
- `ui/src/components/TimelineFeed.tsx`, `WorktreeList.tsx`, `ResourceList.tsx`, `EventRow.tsx`, `ArchivedToggle.tsx`.

**Build:**
- `Makefile` — add `build-web`, wire `build: build-web build-cli`, add `dev`, update `clean`.
- `.gitignore` — `ui/dist/*` + `!ui/dist/.gitkeep`, `ui/node_modules`.

Task ordering: Go server skeleton + embed + command first (so there's a running server), then each API endpoint with Go tests, then the poll loop, then SSE, then the frontend scaffold, then the two pages, then build integration + docs. The frontend can't be meaningfully unit-tested per-task here (no vitest infra in worktree yet); frontend tasks are verified by `tsc` typecheck + `vite build` success + a manual smoke against the real server. The Go API tasks carry the real automated test coverage.

---

### Task 1: Root embed + `worktree ui` command skeleton + server that serves a placeholder

**Files:**
- Create: `web_embed.go`
- Create: `cmd/ui.go`
- Create: `internal/webui/server.go`
- Create: `ui/dist/.gitkeep`
- Modify: `.gitignore`
- Modify: `cmd/root.go` (wire the embed FS setter — check how main→cmd is structured first)
- Test: `internal/webui/server_test.go`

**Interfaces:**
- Produces:
  - `webui.Server` struct: `type Server struct { DB *sql.DB; WebFS fs.FS; Port int; DevMode bool; Logger *log.Logger }`
  - `func (s *Server) Start() error` — builds the mux, starts `http.ListenAndServe`.
  - `func (s *Server) Handler() http.Handler` — returns the mux (for tests via httptest, no real listen).
  - `cmd`: `func SetWebFS(f embed.FS)` + package var `globalWebFS embed.FS`.

- [ ] **Step 1: Inspect how `main`/`cmd` are wired**

Run: `sed -n '1,40p' main.go` and `sed -n '1,60p' cmd/root.go`
Note whether `main.go` exists at repo root (it must, for `//go:embed` relative to `package main`) and how `cmd.Execute()` is called. worktree's entrypoint is `main.go` at root calling `cmd.Execute()` (confirm). You'll add `cmd.SetWebFS(EmbeddedWeb)` in `main.go` before `cmd.Execute()`.

- [ ] **Step 2: Create the embed placeholder + gitignore**

Create empty `ui/dist/.gitkeep`. Add to `.gitignore`:
```
ui/dist/*
!ui/dist/.gitkeep
ui/node_modules
```

- [ ] **Step 3: Create `web_embed.go`**

```go
package main

import "embed"

//go:embed all:ui/dist
var EmbeddedWeb embed.FS
```

- [ ] **Step 4: Wire the setter in `cmd` + `main.go`**

In `cmd/root.go` add:
```go
import "embed"

var globalWebFS embed.FS

// SetWebFS receives the embedded web UI assets from main.
func SetWebFS(f embed.FS) { globalWebFS = f }
```
In `main.go`, before `cmd.Execute()`:
```go
cmd.SetWebFS(EmbeddedWeb)
```

- [ ] **Step 5: Write the failing test for the server's static + not-found behavior**

Create `internal/webui/server_test.go`:
```go
package webui

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func testServer(t *testing.T, webFS fs.FS) *Server {
	t.Helper()
	return &Server{WebFS: webFS}
}

func TestServesIndexFallbackForSPARoutes(t *testing.T) {
	webFS := fstest.MapFS{
		"index.html":       {Data: []byte("<!doctype html><title>worktree</title>")},
		"assets/app.js":    {Data: []byte("console.log(1)")},
	}
	srv := testServer(t, webFS)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// A client-side route with no matching file -> index.html
	resp, err := http.Get(ts.URL + "/worktrees/some-branch")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("SPA route: got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct == "" || ct[:9] != "text/html" {
		t.Fatalf("SPA route content-type: %q", ct)
	}

	// A real asset -> served directly
	resp2, _ := http.Get(ts.URL + "/assets/app.js")
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Fatalf("asset: got %d", resp2.StatusCode)
	}
}
```

- [ ] **Step 6: Run it to verify failure**

Run: `go test ./internal/webui/ -run TestServesIndex -v`
Expected: FAIL to compile (`Server`/`Handler` undefined).

- [ ] **Step 7: Implement `internal/webui/server.go`**

```go
package webui

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
)

type Server struct {
	DB      *sql.DB
	WebFS   fs.FS // rooted at the dist dir (index.html at top level)
	Port    int
	DevMode bool
	Logger  *log.Logger
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	// API routes are registered by later tasks via registerAPI(mux).
	s.registerAPI(mux)
	if !s.DevMode && s.WebFS != nil {
		mux.HandleFunc("/", s.serveStatic)
	}
	return mux
}

// registerAPI is extended in later tasks. Kept separate so tests can add routes.
func (s *Server) registerAPI(mux *http.ServeMux) {
	// (endpoints added in Tasks 2-6)
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		if _, err := fs.Stat(s.WebFS, r.URL.Path[1:]); err == nil {
			http.FileServer(http.FS(s.WebFS)).ServeHTTP(w, r)
			return
		}
	}
	indexData, err := fs.ReadFile(s.WebFS, "index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(indexData)
}

func (s *Server) Start() error {
	addr := fmt.Sprintf("127.0.0.1:%d", s.Port)
	if s.Logger != nil {
		s.Logger.Printf("worktree UI listening on http://%s", addr)
	}
	return http.ListenAndServe(addr, s.Handler())
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
```

- [ ] **Step 8: Run to verify pass**

Run: `go test ./internal/webui/ -v`
Expected: PASS.

- [ ] **Step 9: Implement `cmd/ui.go`**

```go
package cmd

import (
	"database/sql"
	"fmt"
	"io/fs"
	"log"
	"net"
	"os"
	"os/exec"
	"runtime"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/webui"
	"github.com/spf13/cobra"
)

var (
	uiPort   int
	uiNoOpen bool
	uiAPIOnly bool
)

var uiCmd = &cobra.Command{
	Use:     "ui",
	Short:   "Start the worktree web UI",
	GroupID: "worktree",
	RunE:    runUI,
}

func init() {
	uiCmd.Flags().IntVar(&uiPort, "port", 8475, "HTTP server port")
	uiCmd.Flags().BoolVar(&uiNoOpen, "no-open", false, "do not open the browser")
	uiCmd.Flags().BoolVar(&uiAPIOnly, "api-only", false, "serve API only (for use with the Vite dev server)")
	rootCmd.AddCommand(uiCmd)
}

func runUI(cmd *cobra.Command, args []string) error {
	conn, err := wdb.Open()
	if err != nil {
		return fmt.Errorf("opening worktree db: %w", err)
	}
	defer conn.Close()

	var webFS fs.FS
	if !uiAPIOnly {
		sub, err := fs.Sub(globalWebFS, "ui/dist")
		if err != nil {
			return fmt.Errorf("locating embedded web assets: %w", err)
		}
		if !hasBuiltUI(sub) {
			return fmt.Errorf("web UI not built. Run 'make build-web' first")
		}
		webFS = sub
	}

	logger := log.New(os.Stderr, "[worktree-ui] ", log.LstdFlags)
	srv := &webui.Server{DB: conn, WebFS: webFS, Port: uiPort, DevMode: uiAPIOnly, Logger: logger}

	// Start the in-process poll loop (Task 4 provides StartPolling).
	stop := srv.StartPolling(2 * time.Minute)
	defer stop()

	if !uiNoOpen && !uiAPIOnly {
		go openBrowserWhenUp(uiPort)
	}
	return srv.Start()
}

// hasBuiltUI reports whether the embedded dist has real content (not just .gitkeep).
func hasBuiltUI(sub fs.FS) bool {
	entries, err := fs.ReadDir(sub, ".")
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.Name() != ".gitkeep" {
			return true
		}
	}
	return false
}

func openBrowserWhenUp(port int) {
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	for i := 0; i < 50; i++ {
		c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 100*time.Millisecond)
		if err == nil {
			c.Close()
			openBrowser(url)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func openBrowser(url string) {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = exec.Command("open", url)
	case "linux":
		c = exec.Command("xdg-open", url)
	default:
		return
	}
	_ = c.Start()
}

var _ = sql.ErrNoRows // (placeholder import anchor; remove if unused after Task 4)
```
NOTE: `srv.StartPolling` is implemented in Task 4. To keep the build green in THIS task, add a temporary no-op `StartPolling` to `internal/webui/poller.go` now:
```go
package webui

import "time"

// StartPolling is fully implemented in Task 4; this no-op keeps cmd/ui.go
// compiling until then. Returns a stop func.
func (s *Server) StartPolling(interval time.Duration) (stop func()) {
	return func() {}
}
```
Remove the `sql.ErrNoRows` anchor line once real usage exists.

- [ ] **Step 10: Build + verify the command exists**

Run: `go build ./... && ./bin/worktree ui --help 2>&1 | head` (after `make build` or `go build -o bin/worktree .`)
Expected: builds clean; `ui` help shows `--port`, `--no-open`, `--api-only`. Running `worktree ui` without a built frontend should print "Web UI not built. Run 'make build-web' first." (verify manually: `go run . ui`).

- [ ] **Step 11: Commit**

```bash
git add web_embed.go cmd/ui.go internal/webui/server.go internal/webui/poller.go ui/dist/.gitkeep .gitignore cmd/root.go main.go
git commit --signoff -m "feat(ui): worktree ui command + embedded server skeleton with SPA fallback"
```

---

### Task 2: Worktree list API (`GET /api/worktrees`)

**Files:**
- Create: `internal/webui/worktrees.go`
- Modify: `internal/webui/server.go` (register the route in `registerAPI`)
- Test: `internal/webui/worktrees_test.go`

**Interfaces:**
- Consumes: `registry.List(conn)` → `[]registry.Entry{Path,Repo,RepoRoot,Branch,CreatedAt}`; `resources.Load(conn, path)` → `[]resources.Resource{Type,ID,URL,Related}`.
- Produces: `GET /api/worktrees` → JSON `[]worktreeSummary`:
```go
type worktreeSummary struct {
	Path          string `json:"path"`
	Repo          string `json:"repo"`
	Branch        string `json:"branch"`
	OnDisk        bool   `json:"on_disk"`
	ResourceCount int    `json:"resource_count"`
	PrimaryCount  int    `json:"primary_count"`
	LatestEventTS string `json:"latest_event_ts"` // RFC3339, "" if none
}
```

- [ ] **Step 1: Write the failing test**

Create `internal/webui/worktrees_test.go`. Use a seeded temp DB via the Phase-1 packages:
```go
package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

func seededDB(t *testing.T) *sql.DB { // import database/sql
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func TestWorktreesEndpoint(t *testing.T) {
	conn := seededDB(t)
	wtPath := t.TempDir() // exists on disk
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})               // primary
	resources.Add(conn, wtPath, resources.Resource{Type: "jira", ID: "J-1", URL: "u2", Related: true}) // related

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
	if len(got) != 1 {
		t.Fatalf("want 1 worktree, got %d", len(got))
	}
	w := got[0]
	if w.Branch != "b1" || !w.OnDisk || w.ResourceCount != 2 || w.PrimaryCount != 1 {
		t.Fatalf("summary wrong: %+v", w)
	}
}
```
(Add `"database/sql"` import.)

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/webui/ -run TestWorktrees -v`
Expected: FAIL (route 404 / `worktreeSummary` undefined).

- [ ] **Step 3: Implement `internal/webui/worktrees.go`**

```go
package webui

import (
	"net/http"
	"os"

	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

type worktreeSummary struct {
	Path          string `json:"path"`
	Repo          string `json:"repo"`
	Branch        string `json:"branch"`
	OnDisk        bool   `json:"on_disk"`
	ResourceCount int    `json:"resource_count"`
	PrimaryCount  int    `json:"primary_count"`
	LatestEventTS string `json:"latest_event_ts"`
}

func (s *Server) handleWorktrees(w http.ResponseWriter, r *http.Request) {
	entries, err := registry.List(s.DB)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]worktreeSummary, 0, len(entries))
	for _, e := range entries {
		rs, _ := resources.Load(s.DB, e.Path)
		primary := 0
		for _, res := range rs {
			if !res.Related {
				primary++
			}
		}
		_, statErr := os.Stat(e.Path)
		out = append(out, worktreeSummary{
			Path:          e.Path,
			Repo:          e.Repo,
			Branch:        e.Branch,
			OnDisk:        statErr == nil,
			ResourceCount: len(rs),
			PrimaryCount:  primary,
			LatestEventTS: latestEventTSForSubscriber(s.DB, "worktree:"+e.Path),
		})
	}
	writeJSON(w, http.StatusOK, out)
}
```
For `latestEventTSForSubscriber`, add it in `timeline.go` in Task 3; for THIS task, add a temporary local helper at the bottom of `worktrees.go` that returns `""` and a `// TODO(Task 3)` comment, OR (cleaner) fold Task 3 first. To keep tasks independent, add this minimal helper now in `worktrees.go`:
```go
// latestEventTSForSubscriber returns the RFC3339 ts of the newest event for
// any resource this subscriber watches, or "" if none. Full timeline reads
// live in timeline.go (Task 3); this focused query is used by the list summary.
func latestEventTSForSubscriber(db *sql.DB, subscriber string) string {
	const q = `
SELECT COALESCE(MAX(e.ts), '')
FROM watcher_events e
JOIN watcher_event_resources er ON er.event_id = e.id
JOIN watcher_subscriptions s ON s.resource_type = er.resource_type AND s.resource_id = er.resource_id
WHERE s.subscriber = ? AND s.deleted_at IS NULL
  AND e.type NOT IN ('watch_started','watcher_error')`
	var ts string
	_ = db.QueryRow(q, subscriber).Scan(&ts)
	return ts
}
```
(Add `"database/sql"` import to worktrees.go.)

- [ ] **Step 4: Register the route**

In `server.go` `registerAPI`:
```go
mux.HandleFunc("GET /api/worktrees", s.handleWorktrees)
```

- [ ] **Step 5: Run to verify pass**

Run: `go test ./internal/webui/ -run TestWorktrees -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/webui/worktrees.go internal/webui/worktrees_test.go internal/webui/server.go
git commit --signoff -m "feat(ui): GET /api/worktrees list endpoint with resource + latest-event summary"
```

---

### Task 3: Timeline API (global + per-worktree) with title enrichment

**Files:**
- Create: `internal/webui/timeline.go`
- Modify: `internal/webui/server.go` (register routes)
- Modify: `internal/webui/worktrees.go` (remove the temp `latestEventTSForSubscriber`; move it here)
- Test: `internal/webui/timeline_test.go`

**Interfaces:**
- Consumes: raw `watcher_events`/`watcher_event_resources`/`watcher_subscriptions` schema; `watcherdb.EventsForSubscriberSince(conn, subscriber, since)`; `watcherdb.GetResourceState(conn, type, id)` (unmarshal `StateJSON` for a `title`).
- Produces:
  - `GET /api/timeline?archived=<bool>&limit=<n>&before=<ts>` → `{ "events": []TimelineEvent, "next_cursor": "<ts>" }`
  - `GET /api/worktrees/{path...}/timeline?limit=&before=` → same shape, scoped to that worktree's subscriber.
  - `type TimelineEvent`:
```go
type TimelineEvent struct {
	ID            string   `json:"id"`
	TS            string   `json:"ts"`
	ExternalTS    string   `json:"external_ts"` // "" if nil
	Source        string   `json:"source"`      // github|jira
	Type          string   `json:"type"`
	TypeLabel     string   `json:"type_label"`  // EventType.DisplayName()
	Title         string   `json:"title"`
	Body          string   `json:"body"`
	Author        string   `json:"author"`
	ResourceType  string   `json:"resource_type"`
	ResourceID    string   `json:"resource_id"`
	ResourceURL   string   `json:"resource_url"`
	ResourceTitle string   `json:"resource_title"` // from resource_state; "" if none
	Worktrees     []string `json:"worktrees"`      // branch names watching this resource ([] if archived/none)
}
```
  - `func latestEventTSForSubscriber(db *sql.DB, subscriber string) string` (moved here).

- [ ] **Step 1: Write the failing test** (global + archived behavior)

Create `internal/webui/timeline_test.go`:
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
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
)

// insertEvent is a test helper writing directly to the watcher tables.
func insertEvent(t *testing.T, db *sql.DB, id, ts, source, typ, title, rtype, rid, rurl string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO watcher_events (id, ts, source, type, title) VALUES (?,?,?,?,?)`,
		id, ts, source, typ, title); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id, resource_url) VALUES (?,?,?,?)`,
		id, rtype, rid, rurl); err != nil {
		t.Fatal(err)
	}
}

func TestGlobalTimelineArchivedToggle(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	wtPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})

	now := time.Now().UTC()
	// watched resource event
	insertEvent(t, conn, "e1", now.Format(time.RFC3339), "github", "pr_comment", "watched comment", "pr", "o/r#1", "u1")
	// event for a resource NOT watched by anyone (archived)
	insertEvent(t, conn, "e2", now.Add(-time.Minute).Format(time.RFC3339), "github", "pr_comment", "orphan comment", "pr", "o/r#999", "u9")
	// bookkeeping event must always be excluded
	insertEvent(t, conn, "e3", now.Add(time.Minute).Format(time.RFC3339), "github", "watch_started", "noise", "pr", "o/r#1", "u1")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	get := func(archived bool) []TimelineEvent {
		u := ts.URL + "/api/timeline?limit=50&archived=" + url.QueryEscape(boolStr(archived))
		resp, err := http.Get(u)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body struct {
			Events []TimelineEvent `json:"events"`
		}
		json.NewDecoder(resp.Body).Decode(&body)
		return body.Events
	}

	notArchived := get(false)
	if len(notArchived) != 1 || notArchived[0].ID != "e1" {
		t.Fatalf("archived=false should show only watched non-bookkeeping events, got %+v", notArchived)
	}
	if len(notArchived[0].Worktrees) != 1 || notArchived[0].Worktrees[0] != "b1" {
		t.Fatalf("event should be attributed to worktree b1, got %+v", notArchived[0].Worktrees)
	}
	withArchived := get(true)
	if len(withArchived) != 2 {
		t.Fatalf("archived=true should include the orphan event too, got %d", len(withArchived))
	}
	// newest first
	if withArchived[0].ID != "e1" {
		t.Fatalf("expected newest-first ordering, got %+v", withArchived)
	}
}

func boolStr(b bool) string { if b { return "true" }; return "false" }

var _ = watcher.Resource{}
var _ = watcherdb.EventsForSubscriberSince
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/webui/ -run TestGlobalTimeline -v`
Expected: FAIL (route/type undefined).

- [ ] **Step 3: Implement `internal/webui/timeline.go`**

```go
package webui

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
)

type TimelineEvent struct {
	ID            string   `json:"id"`
	TS            string   `json:"ts"`
	ExternalTS    string   `json:"external_ts"`
	Source        string   `json:"source"`
	Type          string   `json:"type"`
	TypeLabel     string   `json:"type_label"`
	Title         string   `json:"title"`
	Body          string   `json:"body"`
	Author        string   `json:"author"`
	ResourceType  string   `json:"resource_type"`
	ResourceID    string   `json:"resource_id"`
	ResourceURL   string   `json:"resource_url"`
	ResourceTitle string   `json:"resource_title"`
	Worktrees     []string `json:"worktrees"`
}

type timelineResponse struct {
	Events     []TimelineEvent `json:"events"`
	NextCursor string          `json:"next_cursor"`
}

const defaultTimelineLimit = 100

func parseLimit(r *http.Request) int {
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			return n
		}
	}
	return defaultTimelineLimit
}

// handleGlobalTimeline: GET /api/timeline?archived=&limit=&before=
func (s *Server) handleGlobalTimeline(w http.ResponseWriter, r *http.Request) {
	archived := r.URL.Query().Get("archived") == "true"
	limit := parseLimit(r)
	before := r.URL.Query().Get("before") // RFC3339 ts; "" = newest

	var (
		rows *sql.Rows
		err  error
	)
	base := `
SELECT DISTINCT e.id, e.ts, COALESCE(e.external_ts,''), e.source, e.type,
       COALESCE(e.title,''), COALESCE(e.body,''), COALESCE(e.author,''),
       er.resource_type, er.resource_id, COALESCE(er.resource_url,'')
FROM watcher_events e
JOIN watcher_event_resources er ON er.event_id = e.id `
	watchedJoin := `JOIN watcher_subscriptions s
       ON s.resource_type = er.resource_type AND s.resource_id = er.resource_id
       AND s.deleted_at IS NULL `
	filter := `WHERE e.type NOT IN ('watch_started','watcher_error') `
	order := `ORDER BY e.ts DESC LIMIT ?`

	beforeClause := ""
	args := []any{}
	if before != "" {
		beforeClause = "AND e.ts < ? "
	}

	if archived {
		q := base + filter + beforeClause + order
		if before != "" {
			args = append(args, before)
		}
		args = append(args, limit)
		rows, err = s.DB.Query(q, args...)
	} else {
		q := base + watchedJoin + filter + beforeClause + order
		if before != "" {
			args = append(args, before)
		}
		args = append(args, limit)
		rows, err = s.DB.Query(q, args...)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	s.writeTimelineRows(w, rows, limit)
}

// handleWorktreeTimeline: GET /api/worktree-timeline?path=<path>&limit=&before=
// A query param (not a path segment) is used because worktree paths contain
// slashes, which the Go 1.22 mux {wildcard} would split awkwardly.
func (s *Server) handleWorktreeTimeline(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	subscriber := "worktree:" + path
	// Full history reverse-chron: read ascending from epoch, reverse.
	evs, err := watcherdb.EventsForSubscriberSince(s.DB, subscriber, "1970-01-01T00:00:00Z")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	limit := parseLimit(r)
	out := make([]TimelineEvent, 0, len(evs))
	// reverse (EventsForSubscriberSince returns ASC)
	for i := len(evs) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, s.enrichEvent(evs[i]))
	}
	writeJSON(w, http.StatusOK, timelineResponse{Events: out, NextCursor: cursorOf(out)})
}

func (s *Server) writeTimelineRows(w http.ResponseWriter, rows *sql.Rows, limit int) {
	out := make([]TimelineEvent, 0, limit)
	for rows.Next() {
		var te TimelineEvent
		if err := rows.Scan(&te.ID, &te.TS, &te.ExternalTS, &te.Source, &te.Type,
			&te.Title, &te.Body, &te.Author, &te.ResourceType, &te.ResourceID, &te.ResourceURL); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		te.TypeLabel = watcher.EventType(te.Type).DisplayName()
		te.ResourceTitle = s.resourceTitle(te.ResourceType, te.ResourceID)
		te.Worktrees = s.worktreesWatching(te.ResourceType, te.ResourceID)
		out = append(out, te)
	}
	writeJSON(w, http.StatusOK, timelineResponse{Events: out, NextCursor: cursorOf(out)})
}

// enrichEvent maps a watcher.Event (+ its single resource, looked up) to a DTO.
func (s *Server) enrichEvent(e watcher.Event) TimelineEvent {
	te := TimelineEvent{
		ID: e.ID, TS: e.TS, Source: e.Source, Type: string(e.Type),
		TypeLabel: e.Type.DisplayName(), Title: e.Title,
	}
	if e.ExternalTS != nil {
		te.ExternalTS = *e.ExternalTS
	}
	if e.Body != nil {
		te.Body = *e.Body
	}
	if e.Author != nil {
		te.Author = *e.Author
	}
	// Resolve the event's resource(s) for scoped view.
	s.DB.QueryRow(`SELECT resource_type, resource_id, COALESCE(resource_url,'')
		FROM watcher_event_resources WHERE event_id = ? LIMIT 1`, e.ID).
		Scan(&te.ResourceType, &te.ResourceID, &te.ResourceURL)
	te.ResourceTitle = s.resourceTitle(te.ResourceType, te.ResourceID)
	te.Worktrees = s.worktreesWatching(te.ResourceType, te.ResourceID)
	return te
}

func (s *Server) resourceTitle(rtype, rid string) string {
	if rtype == "" || rid == "" {
		return ""
	}
	st, err := watcherdb.GetResourceState(s.DB, rtype, rid)
	if err != nil || st == nil {
		return ""
	}
	var m map[string]any
	if json.Unmarshal([]byte(st.StateJSON), &m) == nil {
		if t, ok := m["title"].(string); ok {
			return t
		}
	}
	return ""
}

// worktreesWatching returns the branch names of worktrees currently watching
// the resource (empty slice if none / archived).
func (s *Server) worktreesWatching(rtype, rid string) []string {
	out := []string{}
	if rtype == "" || rid == "" {
		return out
	}
	rows, err := s.DB.Query(`
SELECT wt.branch
FROM watcher_subscriptions s
JOIN worktrees wt ON ('worktree:' || wt.path) = s.subscriber
WHERE s.resource_type = ? AND s.resource_id = ? AND s.deleted_at IS NULL
ORDER BY wt.branch`, rtype, rid)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var b string
		if rows.Scan(&b) == nil {
			out = append(out, b)
		}
	}
	return out
}

func cursorOf(evs []TimelineEvent) string {
	if len(evs) == 0 {
		return ""
	}
	return evs[len(evs)-1].TS
}

// latestEventTSForSubscriber moved here from worktrees.go.
func latestEventTSForSubscriber(db *sql.DB, subscriber string) string {
	const q = `
SELECT COALESCE(MAX(e.ts), '')
FROM watcher_events e
JOIN watcher_event_resources er ON er.event_id = e.id
JOIN watcher_subscriptions s ON s.resource_type = er.resource_type AND s.resource_id = er.resource_id
WHERE s.subscriber = ? AND s.deleted_at IS NULL
  AND e.type NOT IN ('watch_started','watcher_error')`
	var ts string
	_ = db.QueryRow(q, subscriber).Scan(&ts)
	return ts
}
```
Then DELETE the temporary `latestEventTSForSubscriber` from `worktrees.go` (and its `database/sql` import if now unused there).

- [ ] **Step 4: Register routes**

In `server.go` `registerAPI` (both use query params / no path wildcard, since worktree paths contain slashes):
```go
mux.HandleFunc("GET /api/timeline", s.handleGlobalTimeline)
mux.HandleFunc("GET /api/worktree-timeline", s.handleWorktreeTimeline)
```

- [ ] **Step 5: Run to verify pass**

Run: `go test ./internal/webui/ -v`
Expected: PASS (global archived-toggle test + prior worktrees test).

- [ ] **Step 6: Add a scoped-timeline test**

Append to `timeline_test.go`:
```go
func TestWorktreeScopedTimeline(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil { t.Fatal(err) }
	defer conn.Close()
	wtPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})
	now := time.Now().UTC()
	insertEvent(t, conn, "s1", now.Format(time.RFC3339), "github", "pr_comment", "mine", "pr", "o/r#1", "u1")
	insertEvent(t, conn, "s2", now.Format(time.RFC3339), "github", "pr_comment", "not mine", "pr", "o/r#2", "u2")

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, _ := http.Get(ts.URL + "/api/worktree-timeline?path=" + url.QueryEscape(wtPath))
	defer resp.Body.Close()
	var body struct{ Events []TimelineEvent `json:"events"` }
	json.NewDecoder(resp.Body).Decode(&body)
	if len(body.Events) != 1 || body.Events[0].ID != "s1" {
		t.Fatalf("scoped timeline should show only this worktree's resource events, got %+v", body.Events)
	}
}
```
Run: `go test ./internal/webui/ -run TestWorktreeScopedTimeline -v` → PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/webui/timeline.go internal/webui/timeline_test.go internal/webui/server.go internal/webui/worktrees.go
git commit --signoff -m "feat(ui): global + per-worktree timeline endpoints with archived toggle + title enrichment"
```

---

### Task 4: In-process poll loop + poll-on-view-if-stale

**Files:**
- Modify: `internal/webui/poller.go` (replace the Task-1 no-op)
- Modify: `internal/webui/server.go` (register `POST /api/worktrees/poll` / add poll-on-view route)
- Test: `internal/webui/poller_test.go`

**Interfaces:**
- Consumes: `watcherdb.ActiveResources(conn, type)`; `github.Poll(conn, token, resources, logger)`; `jira.Poll(conn, jira.JiraAuth{...}, resources, logger)`; `wconfig.Load(wconfig.DefaultPath())` → `.GitHub()`/`.Jira()`; `wconfig.LoadConfig(wconfig.ConfigDefaultPath())` → `.JiraBotUsernames()` (custom fields come through `JiraCreds.CustomFields`). This is the SAME wiring proven in Phase-1 `cmd/watcher.go` — read that file and reuse it.
- Produces:
  - `func (s *Server) StartPolling(interval time.Duration) (stop func())` — real implementation: immediately polls once, then every `interval` until stopped.
  - `func (s *Server) pollAll() error` — polls all active pr + jira resources once.
  - `func (s *Server) pollWorktreeIfStale(path string, staleAfter time.Duration) error` — polls a worktree's resources only if its latest event is older than `staleAfter`.
  - `POST /api/worktrees/poll?path=<path>` — triggers poll-on-view-if-stale (1 min), returns `{"polled": true|false}`.

- [ ] **Step 1: Read the Phase-1 poller wiring**

Run: `cat cmd/watcher.go`
Reuse its exact config-loading + JiraAuth-construction + github/jira Poll calls. Do NOT invent new accessor names.

- [ ] **Step 2: Write the failing test** (stale logic is unit-testable without network)

The network Poll calls need live creds, so test only the STALE-decision logic (pure, no network). Create `internal/webui/poller_test.go`:
```go
package webui

import (
	"path/filepath"
	"testing"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

func TestIsWorktreeStale(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil { t.Fatal(err) }
	defer conn.Close()
	wtPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})

	s := &Server{DB: conn}
	// No events at all -> stale (should poll).
	if !s.isWorktreeStale(wtPath, time.Minute) {
		t.Fatal("worktree with no events should be stale")
	}
	// Fresh event -> not stale.
	now := time.Now().UTC()
	insertEvent(t, conn, "e1", now.Format(time.RFC3339), "github", "pr_comment", "c", "pr", "o/r#1", "u1")
	if s.isWorktreeStale(wtPath, time.Minute) {
		t.Fatal("worktree with a fresh event should not be stale")
	}
	// Old event -> stale.
	conn.Exec(`UPDATE watcher_events SET ts = ? WHERE id = 'e1'`, now.Add(-5*time.Minute).Format(time.RFC3339))
	if !s.isWorktreeStale(wtPath, time.Minute) {
		t.Fatal("worktree whose newest event is 5m old should be stale (threshold 1m)")
	}
}
```

- [ ] **Step 3: Run to verify failure**

Run: `go test ./internal/webui/ -run TestIsWorktreeStale -v`
Expected: FAIL (`isWorktreeStale` undefined).

- [ ] **Step 4: Implement `internal/webui/poller.go`** (replace the no-op)

```go
package webui

import (
	"log"
	"net/http"
	"time"

	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	watcherdb "github.com/mturley/watcher/db"
	wconfig "github.com/mturley/watcher/config"
)

func (s *Server) StartPolling(interval time.Duration) (stop func()) {
	done := make(chan struct{})
	go func() {
		s.safePollAll()
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				s.safePollAll()
			}
		}
	}()
	return func() { close(done) }
}

func (s *Server) safePollAll() {
	if err := s.pollAll(); err != nil && s.Logger != nil {
		s.Logger.Printf("poll: %v", err)
	}
}

func (s *Server) logger() *log.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return log.Default()
}

// pollAll polls every active pr + jira resource once. Missing creds -> skip that
// source (logged), not an error.
func (s *Server) pollAll() error {
	cfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		return err
	}
	if prs, _ := watcherdb.ActiveResources(s.DB, "pr"); len(prs) > 0 {
		if gh, err := cfg.GitHub(); err == nil {
			if err := wgithub.Poll(s.DB, gh.Token, prs, s.logger()); err != nil {
				s.logger().Printf("github poll: %v", err)
			}
		} else {
			s.logger().Printf("github not configured; skipping %d pr resources", len(prs))
		}
	}
	if issues, _ := watcherdb.ActiveResources(s.DB, "jira"); len(issues) > 0 {
		if jc, err := cfg.Jira(); err == nil {
			auth := wjira.JiraAuth{URL: jc.Host, Email: jc.Email, Token: jc.Token, CustomFields: jc.CustomFields}
			if bcfg, err := wconfig.LoadConfig(wconfig.ConfigDefaultPath()); err == nil {
				auth.BotUsernames = bcfg.JiraBotUsernames()
			}
			if err := wjira.Poll(s.DB, auth, issues, s.logger()); err != nil {
				s.logger().Printf("jira poll: %v", err)
			}
		} else {
			s.logger().Printf("jira not configured; skipping %d jira resources", len(issues))
		}
	}
	return nil
}

// isWorktreeStale reports whether the worktree's newest event is older than
// staleAfter (or it has no events).
func (s *Server) isWorktreeStale(path string, staleAfter time.Duration) bool {
	ts := latestEventTSForSubscriber(s.DB, "worktree:"+path)
	if ts == "" {
		return true
	}
	parsed, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return true
	}
	return time.Since(parsed) > staleAfter
}

// handlePollWorktree: POST /api/worktrees/poll?path=<path> — poll-on-view-if-stale.
func (s *Server) handlePollWorktree(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	if !s.isWorktreeStale(path, time.Minute) {
		writeJSON(w, http.StatusOK, map[string]bool{"polled": false})
		return
	}
	// Poll just this worktree's resources by filtering active resources.
	s.safePollAll() // simplest correct behavior: poll all; per-resource filtering is an optimization
	writeJSON(w, http.StatusOK, map[string]bool{"polled": true})
}
```
NOTE: `handlePollWorktree` polls all resources when stale (simple + correct; the resource sets overlap heavily at single-user scale). A per-worktree-only poll is a possible optimization, not required.

- [ ] **Step 5: Register the route**

In `server.go` `registerAPI`:
```go
mux.HandleFunc("POST /api/worktrees/poll", s.handlePollWorktree)
```

- [ ] **Step 6: Run to verify pass + build**

Run: `go test ./internal/webui/ -run TestIsWorktreeStale -v && go build ./...`
Expected: PASS + clean build. Remove the `sql.ErrNoRows` anchor line from `cmd/ui.go` now (real code uses the DB).

- [ ] **Step 7: Manual smoke (needs live creds)**

Run: `go build -o bin/worktree . && ./bin/worktree ui --no-open --api-only` in one terminal (or with a built UI). In another: `curl -s localhost:8475/api/worktrees | head` and `curl -s -X POST 'localhost:8475/api/worktrees/poll?path=<a-real-worktree-path>'`. Confirm the poll writes events (check `/api/timeline`). If creds are absent, confirm it logs "not configured" and doesn't crash. Document what you ran.

- [ ] **Step 8: Commit**

```bash
git add internal/webui/poller.go internal/webui/poller_test.go internal/webui/server.go cmd/ui.go
git commit --signoff -m "feat(ui): in-process poll loop + poll-on-view-if-stale endpoint"
```

---

### Task 5: Per-worktree resource list API + SSE stream

**Files:**
- Create: `internal/webui/resources_api.go`
- Create: `internal/webui/stream.go`
- Modify: `internal/webui/server.go` (register routes)
- Test: `internal/webui/resources_api_test.go`

**Interfaces:**
- Consumes: `resources.Load(conn, path)`; `MAX(ts)` over `watcher_events`.
- Produces:
  - `GET /api/worktree-resources?path=<path>` → `[]resourceDTO{type,id,url,primary}` (reuses the CC-2 shape; primary = !Related).
  - `GET /api/stream` — SSE: emits `event: events_new` when `MAX(ts)` over `watcher_events` changes, `event: heartbeat` every tick. 5s ticker.

- [ ] **Step 1: Write the failing test for resources endpoint**

Create `internal/webui/resources_api_test.go`:
```go
package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
)

func TestWorktreeResourcesEndpoint(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil { t.Fatal(err) }
	defer conn.Close()
	wtPath := t.TempDir()
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})               // primary
	resources.Add(conn, wtPath, resources.Resource{Type: "jira", ID: "J-1", URL: "u2", Related: true}) // related

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, _ := http.Get(ts.URL + "/api/worktree-resources?path=" + url.QueryEscape(wtPath))
	defer resp.Body.Close()
	var got []resourceDTO
	json.NewDecoder(resp.Body).Decode(&got)
	if len(got) != 2 { t.Fatalf("want 2, got %d", len(got)) }
	var prPrimary, jiraPrimary bool
	for _, r := range got {
		if r.Type == "pr" { prPrimary = r.Primary }
		if r.Type == "jira" { jiraPrimary = r.Primary }
	}
	if !prPrimary || jiraPrimary {
		t.Fatalf("pr should be primary, jira related: %+v", got)
	}
}
```

- [ ] **Step 2: Run to verify failure** — `go test ./internal/webui/ -run TestWorktreeResources -v` → FAIL.

- [ ] **Step 3: Implement `internal/webui/resources_api.go`**

```go
package webui

import (
	"net/http"

	"github.com/mturley/worktree/internal/resources"
)

type resourceDTO struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	URL     string `json:"url"`
	Primary bool   `json:"primary"`
}

func (s *Server) handleWorktreeResources(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	rs, err := resources.Load(s.DB, path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]resourceDTO, 0, len(rs))
	for _, res := range rs {
		out = append(out, resourceDTO{Type: res.Type, ID: res.ID, URL: res.URL, Primary: !res.Related})
	}
	writeJSON(w, http.StatusOK, out)
}
```

- [ ] **Step 4: Implement `internal/webui/stream.go`**

```go
package webui

import (
	"fmt"
	"net/http"
	"time"
)

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher.Flush()

	var last string
	s.DB.QueryRow(`SELECT COALESCE(MAX(ts),'') FROM watcher_events`).Scan(&last)

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			var cur string
			s.DB.QueryRow(`SELECT COALESCE(MAX(ts),'') FROM watcher_events`).Scan(&cur)
			if cur != last {
				last = cur
				fmt.Fprintf(w, "event: events_new\ndata: {}\n\n")
			}
			fmt.Fprintf(w, "event: heartbeat\ndata: {}\n\n")
			flusher.Flush()
		}
	}
}
```

- [ ] **Step 5: Register routes**

In `server.go` `registerAPI`:
```go
mux.HandleFunc("GET /api/worktree-resources", s.handleWorktreeResources)
mux.HandleFunc("GET /api/stream", s.handleStream)
```

- [ ] **Step 6: Run to verify pass** — `go test ./internal/webui/ -v` → PASS (resources test; SSE isn't unit-tested — it's a long-lived stream, verified in manual smoke).

- [ ] **Step 7: Commit**

```bash
git add internal/webui/resources_api.go internal/webui/stream.go internal/webui/resources_api_test.go internal/webui/server.go
git commit --signoff -m "feat(ui): per-worktree resources endpoint + SSE stream (events_new/heartbeat)"
```

---

### Task 6: Frontend scaffold (Vite + Mantine + React 19 + React Query + router)

**Files:**
- Create: `ui/package.json`, `ui/vite.config.ts`, `ui/tsconfig.json`, `ui/tsconfig.node.json`, `ui/index.html`
- Create: `ui/src/main.tsx`, `ui/src/theme.ts`, `ui/src/App.tsx`
- Create: `ui/src/api/client.ts`, `ui/src/api/types.ts`
- Create: `ui/src/hooks/useSSE.ts`

**Interfaces:**
- Produces: a buildable Vite app (`npm run build` → `ui/dist`) with MantineProvider + QueryClientProvider + a router, a typed API client matching the Task 2-5 endpoints, and a global SSE hook that invalidates React Query caches. Talks to `/api/*` (same-origin in prod; dev proxy to 8475).

- [ ] **Step 1: Create `ui/package.json`**

```json
{
  "name": "worktree-ui",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@mantine/core": "^7.17.0",
    "@mantine/hooks": "^7.17.0",
    "@tanstack/react-query": "^5.101.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "wouter": "^3.10.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create `ui/vite.config.ts`** (dev port 5175, proxy to 8475, keep .gitkeep)

```ts
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  build: { emptyOutDir: false }, // preserve ui/dist/.gitkeep
  server: {
    port: 5175,
    proxy: { "/api": { target: "http://localhost:8475", changeOrigin: true, ws: false } },
  },
})
```

- [ ] **Step 3: Create tsconfig files**

`ui/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "useDefineForClassFields": true, "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext", "skipLibCheck": true, "moduleResolution": "bundler",
    "allowImportingTsExtensions": true, "noEmit": true, "jsx": "react-jsx",
    "strict": true, "noUnusedLocals": true, "noUnusedParameters": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```
`ui/tsconfig.node.json`:
```json
{
  "compilerOptions": { "composite": true, "skipLibCheck": true, "module": "ESNext", "moduleResolution": "bundler", "allowSyntheticDefaultImports": true, "strict": true },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: Create `ui/index.html`**

```html
<!doctype html>
<html lang="en" data-mantine-color-scheme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <title>worktree</title>
    <style>html,body{background-color:#1a1b1e;margin:0}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `ui/src/api/types.ts`** (match the Go DTOs exactly)

```ts
export interface WorktreeSummary {
  path: string; repo: string; branch: string;
  on_disk: boolean; resource_count: number; primary_count: number; latest_event_ts: string;
}
export interface TimelineEvent {
  id: string; ts: string; external_ts: string; source: string;
  type: string; type_label: string; title: string; body: string; author: string;
  resource_type: string; resource_id: string; resource_url: string; resource_title: string;
  worktrees: string[];
}
export interface TimelineResponse { events: TimelineEvent[]; next_cursor: string }
export interface ResourceDTO { type: string; id: string; url: string; primary: boolean }
```

- [ ] **Step 6: Create `ui/src/api/client.ts`**

```ts
import type { WorktreeSummary, TimelineResponse, ResourceDTO } from "./types"

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
  return data as T
}

export const api = {
  worktrees: () => fetchJSON<WorktreeSummary[]>("/api/worktrees"),
  globalTimeline: (archived: boolean, limit = 100, before?: string) =>
    fetchJSON<TimelineResponse>(
      `/api/timeline?archived=${archived}&limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`),
  worktreeTimeline: (path: string, limit = 100) =>
    fetchJSON<TimelineResponse>(`/api/worktree-timeline?path=${encodeURIComponent(path)}&limit=${limit}`),
  worktreeResources: (path: string) =>
    fetchJSON<ResourceDTO[]>(`/api/worktree-resources?path=${encodeURIComponent(path)}`),
  pollWorktree: (path: string) =>
    fetchJSON<{ polled: boolean }>(`/api/worktrees/poll?path=${encodeURIComponent(path)}`, { method: "POST" }),
}
```

- [ ] **Step 7: Create `ui/src/hooks/useSSE.ts`**

```ts
import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"

export function useSSE() {
  const qc = useQueryClient()
  useEffect(() => {
    let es: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const connect = () => {
      es = new EventSource("/api/stream")
      es.addEventListener("events_new", () => {
        qc.invalidateQueries({ queryKey: ["timeline"] })
        qc.invalidateQueries({ queryKey: ["worktrees"] })
      })
      es.onerror = () => { es?.close(); es = null; timer = setTimeout(connect, 3000) }
    }
    connect()
    return () => { es?.close(); if (timer) clearTimeout(timer) }
  }, [qc])
}
```

- [ ] **Step 8: Create `ui/src/theme.ts`, `ui/src/App.tsx`, `ui/src/main.tsx`**

`theme.ts`:
```ts
import { createTheme } from "@mantine/core"
export const theme = createTheme({ fontSizes: { md: "0.9375rem" } })
```
`App.tsx` (routes; pages come in Tasks 7-8 — stub them for now so it compiles):
```tsx
import { Route, Switch } from "wouter"
import { useSSE } from "./hooks/useSSE"
import { HomePage } from "./pages/HomePage"
import { WorktreeDetailPage } from "./pages/WorktreeDetailPage"

export function App() {
  useSSE()
  return (
    <Switch>
      <Route path="/" component={HomePage} />
      <Route path="/worktree/:path*" component={WorktreeDetailPage} />
      <Route>Not found</Route>
    </Switch>
  )
}
```
`main.tsx`:
```tsx
import React from "react"
import ReactDOM from "react-dom/client"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@mantine/core/styles.css"
import { theme } from "./theme"
import { App } from "./App"

const qc = new QueryClient()
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    </MantineProvider>
  </React.StrictMode>,
)
```
To keep this task's build green before Tasks 7-8, create minimal stub pages:
`ui/src/pages/HomePage.tsx`: `export function HomePage() { return <div>home</div> }`
`ui/src/pages/WorktreeDetailPage.tsx`: `export function WorktreeDetailPage() { return <div>detail</div> }`

- [ ] **Step 9: Install + typecheck + build**

Run: `cd ui && npm install && npm run build`
Expected: `tsc -b` passes, `vite build` writes `ui/dist/` (and preserves `.gitkeep`). Fix any type errors.

- [ ] **Step 10: Commit**

```bash
git add ui/package.json ui/package-lock.json ui/vite.config.ts ui/tsconfig.json ui/tsconfig.node.json ui/index.html ui/src
git commit --signoff -m "feat(ui): Vite + Mantine + React 19 frontend scaffold with API client + SSE hook"
```

---

### Task 7: Home page — worktree list + global timeline

**Files:**
- Create: `ui/src/hooks/useWorktrees.ts`, `ui/src/hooks/useTimeline.ts`
- Create: `ui/src/components/WorktreeList.tsx`, `ui/src/components/TimelineFeed.tsx`, `ui/src/components/EventRow.tsx`, `ui/src/components/ArchivedToggle.tsx`
- Modify: `ui/src/pages/HomePage.tsx`

**Interfaces:**
- Consumes: `api.worktrees()`, `api.globalTimeline(archived, limit, before)`.
- Produces: a two-pane home: left = worktree list (branch, repo, resource/primary counts, latest-event relative time, "(missing)" if `!on_disk`), each links to `/worktree/<path>`; right = global timeline feed with the "Show archived" toggle.

- [ ] **Step 1: Create data hooks**

`ui/src/hooks/useWorktrees.ts`:
```tsx
import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
export function useWorktrees() {
  return useQuery({ queryKey: ["worktrees"], queryFn: api.worktrees })
}
```
`ui/src/hooks/useTimeline.ts`:
```tsx
import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
export function useGlobalTimeline(archived: boolean) {
  return useQuery({ queryKey: ["timeline", "global", archived], queryFn: () => api.globalTimeline(archived) })
}
export function useWorktreeTimeline(path: string) {
  return useQuery({ queryKey: ["timeline", "worktree", path], queryFn: () => api.worktreeTimeline(path), enabled: !!path })
}
```

- [ ] **Step 2: Create `EventRow.tsx`** (one timeline event; reused by both views)

```tsx
import { Anchor, Badge, Group, Paper, Stack, Text } from "@mantine/core"
import type { TimelineEvent } from "../api/types"

function rel(ts: string): string {
  const d = new Date(ts).getTime()
  if (!d) return ts
  const s = Math.floor((Date.now() - d) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function EventRow({ e, showWorktrees }: { e: TimelineEvent; showWorktrees?: boolean }) {
  return (
    <Paper p="sm" withBorder>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={2}>
          <Group gap="xs">
            <Badge size="sm" variant="light">{e.type_label || e.type}</Badge>
            <Text size="sm" fw={600}>{e.title}</Text>
          </Group>
          {e.resource_title && (
            <Text size="xs" c="dimmed">
              {e.resource_url ? <Anchor href={e.resource_url} target="_blank" size="xs">{e.resource_title}</Anchor> : e.resource_title}
            </Text>
          )}
          {e.body && <Text size="xs" c="dimmed" lineClamp={3}>{e.body}</Text>}
          {showWorktrees && e.worktrees.length > 0 && (
            <Group gap={4}>{e.worktrees.map((w) => <Badge key={w} size="xs" variant="outline">{w}</Badge>)}</Group>
          )}
        </Stack>
        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
          {e.author && `${e.author} · `}{rel(e.external_ts || e.ts)}
        </Text>
      </Group>
    </Paper>
  )
}
```

- [ ] **Step 3: Create `ArchivedToggle.tsx`** (exact tooltip text)

```tsx
import { Switch, Tooltip } from "@mantine/core"

export function ArchivedToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Tooltip label="Show past events for resources no longer being watched by a worktree" multiline w={260}>
      <Switch checked={value} onChange={(e) => onChange(e.currentTarget.checked)} label="Show archived" size="sm" />
    </Tooltip>
  )
}
```

- [ ] **Step 4: Create `TimelineFeed.tsx`**

```tsx
import { Alert, Loader, Stack, Text } from "@mantine/core"
import type { TimelineEvent } from "../api/types"
import { EventRow } from "./EventRow"

export function TimelineFeed({ events, loading, error, showWorktrees }: {
  events: TimelineEvent[]; loading: boolean; error: unknown; showWorktrees?: boolean
}) {
  if (loading) return <Loader />
  if (error) return <Alert color="red">{String((error as Error).message || error)}</Alert>
  if (events.length === 0) return <Text c="dimmed" size="sm">No events yet.</Text>
  return <Stack gap="xs">{events.map((e) => <EventRow key={e.id} e={e} showWorktrees={showWorktrees} />)}</Stack>
}
```

- [ ] **Step 5: Create `WorktreeList.tsx`**

```tsx
import { Badge, Group, NavLink, Stack, Text } from "@mantine/core"
import { Link } from "wouter"
import type { WorktreeSummary } from "../api/types"

export function WorktreeList({ items }: { items: WorktreeSummary[] }) {
  if (items.length === 0) return <Text c="dimmed" size="sm">No worktrees. Create one with `worktree add`.</Text>
  return (
    <Stack gap={4}>
      {items.map((w) => (
        <NavLink
          key={w.path}
          component={Link}
          href={`/worktree/${encodeURIComponent(w.path)}`}
          label={<Group gap="xs"><Text size="sm" fw={600}>{w.branch}</Text>{!w.on_disk && <Badge size="xs" color="red">missing</Badge>}</Group>}
          description={<Text size="xs" c="dimmed">{w.repo} · {w.primary_count}/{w.resource_count} primary</Text>}
        />
      ))}
    </Stack>
  )
}
```

- [ ] **Step 6: Assemble `HomePage.tsx`**

```tsx
import { useState } from "react"
import { Grid, Group, Stack, Title } from "@mantine/core"
import { useWorktrees } from "../hooks/useWorktrees"
import { useGlobalTimeline } from "../hooks/useTimeline"
import { WorktreeList } from "../components/WorktreeList"
import { TimelineFeed } from "../components/TimelineFeed"
import { ArchivedToggle } from "../components/ArchivedToggle"

export function HomePage() {
  const [archived, setArchived] = useState(false)
  const wts = useWorktrees()
  const tl = useGlobalTimeline(archived)
  return (
    <Grid p="md" gutter="md">
      <Grid.Col span={4}>
        <Stack gap="sm">
          <Title order={4}>Worktrees</Title>
          <WorktreeList items={wts.data ?? []} />
        </Stack>
      </Grid.Col>
      <Grid.Col span={8}>
        <Stack gap="sm">
          <Group justify="space-between">
            <Title order={4}>Timeline</Title>
            <ArchivedToggle value={archived} onChange={setArchived} />
          </Group>
          <TimelineFeed events={tl.data?.events ?? []} loading={tl.isLoading} error={tl.error} showWorktrees />
        </Stack>
      </Grid.Col>
    </Grid>
  )
}
```

- [ ] **Step 7: Typecheck + build**

Run: `cd ui && npm run build`
Expected: passes. Fix type errors (esp. wouter `Link`/`NavLink` `component` prop typing — if Mantine's `NavLink component={Link}` types complain, use `renderRoot` or wrap with `<Link>` around a plain `NavLink`; adjust as needed to compile).

- [ ] **Step 8: Commit**

```bash
git add ui/src/hooks ui/src/components ui/src/pages/HomePage.tsx
git commit --signoff -m "feat(ui): home page — worktree list + global timeline with archived toggle"
```

---

### Task 8: Worktree detail page — resource list + scoped timeline + poll-on-view

**Files:**
- Create: `ui/src/hooks/useWorktreeDetail.ts`
- Create: `ui/src/components/ResourceList.tsx`
- Modify: `ui/src/pages/WorktreeDetailPage.tsx`

**Interfaces:**
- Consumes: `api.worktreeResources(path)`, `api.worktreeTimeline(path)`, `api.pollWorktree(path)`; wouter `useParams`/`useRoute` for the `:path*` segment.
- Produces: detail view showing the worktree's resources (primary badges) + its scoped timeline; on mount, fires `pollWorktree(path)` (poll-on-view-if-stale) then refetches.

- [ ] **Step 1: Create `ResourceList.tsx`**

```tsx
import { Anchor, Badge, Group, Paper, Stack, Text } from "@mantine/core"
import type { ResourceDTO } from "../api/types"

export function ResourceList({ items }: { items: ResourceDTO[] }) {
  if (items.length === 0) return <Text c="dimmed" size="sm">No resources tracked.</Text>
  return (
    <Stack gap={4}>
      {items.map((r) => (
        <Paper key={`${r.type}:${r.id}`} p="xs" withBorder>
          <Group gap="xs">
            <Badge size="xs" variant={r.primary ? "filled" : "outline"} color={r.primary ? "blue" : "gray"}>
              {r.primary ? "primary" : "related"}
            </Badge>
            <Badge size="xs" variant="light">{r.type}</Badge>
            {r.url ? <Anchor href={r.url} target="_blank" size="sm">{r.id}</Anchor> : <Text size="sm">{r.id}</Text>}
          </Group>
        </Paper>
      ))}
    </Stack>
  )
}
```

- [ ] **Step 2: Create `useWorktreeDetail.ts`** (fires poll-on-view, then reads)

```tsx
import { useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"

export function useWorktreeDetail(path: string) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!path) return
    // poll-on-view-if-stale, then refresh resources + timeline
    api.pollWorktree(path).then((res) => {
      if (res.polled) {
        qc.invalidateQueries({ queryKey: ["timeline", "worktree", path] })
        qc.invalidateQueries({ queryKey: ["resources", path] })
      }
    }).catch(() => {})
  }, [path, qc])

  const resources = useQuery({ queryKey: ["resources", path], queryFn: () => api.worktreeResources(path), enabled: !!path })
  const timeline = useQuery({ queryKey: ["timeline", "worktree", path], queryFn: () => api.worktreeTimeline(path), enabled: !!path })
  return { resources, timeline }
}
```

- [ ] **Step 3: Assemble `WorktreeDetailPage.tsx`**

```tsx
import { Anchor, Grid, Group, Stack, Title } from "@mantine/core"
import { Link, useRoute } from "wouter"
import { useWorktreeDetail } from "../hooks/useWorktreeDetail"
import { ResourceList } from "../components/ResourceList"
import { TimelineFeed } from "../components/TimelineFeed"

export function WorktreeDetailPage() {
  const [, params] = useRoute("/worktree/:path*")
  const path = params?.path ? decodeURIComponent(params.path) : ""
  const { resources, timeline } = useWorktreeDetail(path)
  const branch = path.split("/").pop() || path
  return (
    <Stack p="md" gap="md">
      <Group>
        <Anchor component={Link} href="/">← all worktrees</Anchor>
        <Title order={4}>{branch}</Title>
      </Group>
      <Grid gutter="md">
        <Grid.Col span={4}>
          <Stack gap="sm">
            <Title order={5}>Resources</Title>
            <ResourceList items={resources.data ?? []} />
          </Stack>
        </Grid.Col>
        <Grid.Col span={8}>
          <Stack gap="sm">
            <Title order={5}>Timeline</Title>
            <TimelineFeed events={timeline.data?.events ?? []} loading={timeline.isLoading} error={timeline.error} />
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
  )
}
```
NOTE: the home page links to `/worktree/${encodeURIComponent(path)}`, so `params.path` is a single encoded segment (no raw slashes) — `decodeURIComponent` restores the real path. Verify wouter's `:path*` captures the encoded segment intact (it should, since encoding removes slashes). If wouter still splits on `%2F`-decoded slashes, switch the link to a query param (`/worktree?path=...`) and read via `useSearch`. Confirm during Step 4 and adjust.

- [ ] **Step 4: Typecheck + build**

Run: `cd ui && npm run build`
Expected: passes. Verify the path round-trips (encode in link → decode in page).

- [ ] **Step 5: Commit**

```bash
git add ui/src/hooks/useWorktreeDetail.ts ui/src/components/ResourceList.tsx ui/src/pages/WorktreeDetailPage.tsx
git commit --signoff -m "feat(ui): worktree detail page — resources + scoped timeline + poll-on-view"
```

---

### Task 9: Build integration (Makefile) + end-to-end smoke + docs

**Files:**
- Modify: `Makefile`
- Modify: `.claude/CLAUDE.md`, `README.md`, `docs/design-proposal.md`

**Interfaces:** none (build + docs).

- [ ] **Step 1: Add Makefile targets**

Read the current `Makefile` first. Add:
```make
build-web:
	@if [ ! -f ui/package.json ]; then echo "Error: ui/package.json not found." && exit 1; fi
	@cd ui && npm install --silent && npm run build
	@echo "Built ui/dist/"
```
Change the existing `build` target to depend on `build-web` first, then the Go build (rename the current Go-build recipe to `build-cli` if not already, and make `build: build-web build-cli`). Add to `clean`: remove `ui/dist` contents (but recreate `ui/dist/.gitkeep`) and `ui/node_modules`. Add a `dev` target:
```make
dev:
	@command -v mprocs >/dev/null 2>&1 || { echo "install mprocs for dev mode, or run 'go run . ui --api-only' and 'cd ui && npm run dev' separately"; exit 1; }
	@mprocs "go run . ui --api-only" "cd ui && npm run dev"
```

- [ ] **Step 2: Full build**

Run: `make build`
Expected: builds the frontend into `ui/dist`, then the Go binary with real embedded assets. `ls ui/dist` shows `index.html` + `assets/`.

- [ ] **Step 3: End-to-end manual smoke**

Run: `./bin/worktree ui --no-open` (with the real seeded DB from Phase-1 cutover). Then in a browser (or curl):
- `http://localhost:8475/` loads the home page (worktree list on the left — should show your 11 real worktrees — and a global timeline).
- Toggle "Show archived" — confirm the tooltip text and that more/fewer events appear.
- Click a worktree → detail page shows its resources (primary/related badges) + scoped timeline; opening it triggers a poll-on-view (check server logs).
- `curl -s localhost:8475/api/worktrees | python3 -m json.tool | head` shows the summaries.
Document exactly what you ran and saw. If GitHub/Jira creds are configured, confirm the poll loop writes fresh events (watch the log line + timeline updating within the 5s SSE tick). If creds absent, confirm graceful "not configured" logging.

- [ ] **Step 4: Update docs**

- `.claude/CLAUDE.md`: add `webui` to the `internal/` package list; note the `worktree ui` command + `ui/` frontend + `make build-web`/`make dev`; note ports 8475 (prod) / 5175 (dev).
- `README.md`: add a "Web UI" section — `worktree ui` (default port 8475, `--port`, `--no-open`, `--api-only`), what it shows (list + global timeline + detail), that it polls pr/jira while running.
- `docs/design-proposal.md`: add a "Phase 2: Web UI" note describing the embed/SSE/poll model + the two views; mark Slack as Phase 3.

- [ ] **Step 5: Commit**

```bash
git add Makefile .claude/CLAUDE.md README.md docs/design-proposal.md
git commit --signoff -m "build(ui): wire build-web into make build; dev target; docs for the web UI"
```

---

## Phase 2 completion criteria

- `worktree ui` starts a server on 8475 (overridable), auto-opens the browser (unless `--no-open`), and serves the embedded Mantine UI.
- Home view lists all managed worktrees (from the DB registry) with resource/primary counts + missing markers, and a global timeline of all watched-resource events (newest-first, each attributed to its worktree(s)), with a working "Show archived" toggle (exact tooltip text).
- Detail view shows a worktree's resources (primary vs related) + a timeline scoped to that worktree's subscriptions; opening it triggers poll-on-view-if-stale (1 min).
- The UI-server process polls all active pr/jira resources every 2 minutes while running (in-process, no scheduler); SSE `/api/stream` drives near-live UI refresh.
- `make build` produces a single binary with the embedded frontend; `go build ./...` and `go test ./...` are green; all Go API endpoints have passing tests.
- No Slack code, no slack-mini fold-in.

## Out of scope (later phases)
- Slack tab / slack-mini fold-in (Phase 3), Slack timeline events (Phase 4).
- Handler↔worktree CLI integration (Phase 5).
- Actions from the UI (watch/unwatch/create/delete worktrees) — read-only UI this phase, except the implicit poll-on-view. Adding mutation endpoints is a later enhancement.
- Frontend unit tests (vitest) — deferred; Go API tests + typecheck + manual smoke cover Phase 2.
- Pagination UI (infinite scroll) — the API supports `before`/`next_cursor`, but the UI shows the first page only this phase.
