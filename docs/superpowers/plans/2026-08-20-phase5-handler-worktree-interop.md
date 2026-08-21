# Phase 5 — agent-handler ↔ worktree interop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace agent-handler's dead `.worktree-resources` file readers with
CLI-level interop with the `worktree` binary: auto-watch worktree **primary**
resources at session registration, and propagate an explicit `/watch` to
worktree — all best-effort, degrading gracefully when `worktree` is absent.

**Architecture:** A new `worktreeinterop` package (renamed from the existing
`worktree` file-reader package) shells out to `worktree resources list --json`
and `worktree resources add`, gated on `exec.LookPath("worktree")`. handler and
worktree keep entirely separate watcher DBs; there is no shared DB and no
watcher-library change. `/unwatch` stays handler-DB-only.

**Tech Stack:** Go, cobra CLI, `os/exec`, `encoding/json`, existing handler
`db`/`config` packages, watcher library (unchanged; already pinned).

**Spec:** `docs/superpowers/specs/2026-08-20-phase5-handler-worktree-interop-design.md`
(in the worktree repo; this plan is executed against the **agent-handler** repo
at `~/git/agent-ledger`).

## Global Constraints

- **Repo:** all work is in `~/git/agent-ledger` (module
  `github.com/mturley/agent-handler`). No worktree-repo or watcher-repo change.
- **No watcher-library change, no DB schema migration.** Single-repo phase.
- **Package name:** `worktreeinterop` (directory + package clause; import path
  `github.com/mturley/agent-handler/worktreeinterop`). Go identifiers can't have
  hyphens.
- **Graceful degradation:** every worktree interaction gates on
  `Available()` and is best-effort — an absent/broken `worktree` binary never
  fails registration or a `/watch`.
- **`/unwatch` never calls worktree.** It mutates only handler's own DB.
- **Tombstone-respecting auto-watch:** registration uses `SubscribeIfNew`
  (IfAbsent), which does not resurrect user-tombstoned subscriptions. Preserve
  this.
- **No empty-string URL fallbacks:** `ResourceURL` is `*string`; leave it `nil`
  (never `""`) when no URL is known.
- **Command seam for tests:** `worktreeinterop` gets overridable
  `execCommand`/`lookPath` package vars so tests inject fakes — no real
  `worktree` binary, no real DB, in unit tests.
- **Field mapping (worktree JSON → handler subscription):** `type→ResourceType`,
  `id→ResourceID`, `url→ResourceURL`; if `url` empty, backfill via
  `config.Read(...).DefaultResourceURL(type,id)`; if still empty, `nil`.
- Run tests with `go test ./...` from the repo root.
- Build/install gotcha: before any build/install that replaces the running
  handler binary, confirm with Mike and kill the running handler UI server
  first, then restart it. (Applies at finish/verify time, not per-task.)

---

## File Structure

- `worktree/` → **renamed** to `worktreeinterop/` (git mv, preserve history).
  - `worktreeinterop/cli.go` (new): `Available`, `ListPrimaryResources`,
    `AddResource`, `Resource`, command seam vars.
  - `worktreeinterop/parse.go` (new): keep `ParseResourceID` (still used by
    subscribe/unsubscribe to parse user `type:id` input).
  - `worktreeinterop/resources.go`: **deleted** (file I/O:
    `ReadResources`/`AppendResource`/`RemoveResource`).
  - `worktreeinterop/cli_test.go` (new): seam-based unit tests.
  - `worktreeinterop/parse_test.go` (new): `ParseResourceID` tests (moved from
    old `resources_test.go`).
  - `worktreeinterop/resources_test.go`: **deleted** (file-I/O tests).
- `cmd/autosubscribe.go` (new): shared `autoSubscribeWorktreePrimaries` helper
  used by the three read seams (DRY).
- `cmd/register.go`, `cmd/statusline.go`, `cmd/user_prompt_submit.go`: read
  seams → call the helper.
- `cmd/subscribe.go`: `/watch` write seam → `AddResource`; `--related` flag.
- `cmd/unsubscribe.go`: remove `--persist` file logic; handler-DB-only.

---

## Task 1: Rename package `worktree` → `worktreeinterop`; split parse from file-I/O

**Files:**
- Rename: `worktree/` → `worktreeinterop/` (git mv)
- Create: `worktreeinterop/parse.go` (move `ParseResourceID` + `Resource` type here)
- Create: `worktreeinterop/parse_test.go` (move `TestParseResourceID` here)
- Modify: importers `cmd/register.go`, `cmd/statusline.go`,
  `cmd/user_prompt_submit.go`, `cmd/subscribe.go`, `cmd/unsubscribe.go`
  (import path + package selector `worktree.` → `worktreeinterop.`)

**Interfaces:**
- Produces: package `worktreeinterop` with `func ParseResourceID(string) (resourceType, id string)`
  and `type Resource struct { Type, ID, URL string }` (NOTE: new shape — `Type`
  split out, no `Primary` field here; primary-ness is filtered in
  `ListPrimaryResources`, Task 2).

- [ ] **Step 1: git mv the directory and its test file**

```bash
cd ~/git/agent-ledger
git mv worktree worktreeinterop
```

- [ ] **Step 2: Rewrite the package clause and split parse out**

Edit `worktreeinterop/resources.go`: change `package worktree` →
`package worktreeinterop`. (File-I/O funcs get deleted in Task 5; leave them
for now so the build stays green — but move `ParseResourceID` and redefine
`Resource`.)

Create `worktreeinterop/parse.go`:

```go
package worktreeinterop

import "strings"

// Resource is a worktree-tracked resource as emitted by
// `worktree resources list --json`.
type Resource struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	URL  string `json:"url"`
}

// ParseResourceID splits a "type:id" resource identifier (e.g.
// "pr:owner/repo#42") into its parts. A missing colon yields ("", input).
func ParseResourceID(resourceID string) (resourceType, id string) {
	parts := strings.SplitN(resourceID, ":", 2)
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return "", resourceID
}
```

Remove the old `Resource` struct and `ParseResourceID` from `resources.go`
(the old `Resource` had `ID string; URL string; Primary bool` — delete it; the
file-I/O funcs referencing it are removed in Task 5, so also temporarily keep a
local shape if needed to compile — simplest: do Task 5's deletion here if the
build breaks. If keeping resources.go compiling is awkward, delete its file-I/O
now and fold Task 5 forward — see Task 5 note).

> Ruling if build can't stay green mid-rename: delete `resources.go`'s file-I/O
> in THIS task (i.e. merge Task 5 into Task 1). The file-I/O is dead once the
> seams move; keeping it compiling against the new `Resource` shape is wasted
> work. Record the ruling in the ledger and proceed.

- [ ] **Step 3: Move the parse test**

Create `worktreeinterop/parse_test.go` with `package worktreeinterop` and the
`TestParseResourceID` table test copied verbatim from the old
`resources_test.go`. Delete the other tests from `resources_test.go` only if
their target funcs still exist; otherwise delete the file in Task 5.

- [ ] **Step 4: Update importers**

In `cmd/register.go`, `cmd/statusline.go`, `cmd/user_prompt_submit.go`,
`cmd/subscribe.go`, `cmd/unsubscribe.go`: change import
`"github.com/mturley/agent-handler/worktree"` →
`"github.com/mturley/agent-handler/worktreeinterop"` and every `worktree.`
selector → `worktreeinterop.`.

- [ ] **Step 5: Build + test**

Run: `go build ./... && go test ./worktreeinterop/... -v`
Expected: PASS (`TestParseResourceID` green).

- [ ] **Step 6: Commit**

```bash
git add worktreeinterop cmd/register.go cmd/statusline.go cmd/user_prompt_submit.go cmd/subscribe.go cmd/unsubscribe.go
git commit --signoff -m "refactor: rename worktree pkg to worktreeinterop, split parse from file-I/O"
```

---

## Task 2: `worktreeinterop.ListPrimaryResources` + `Available` (CLI read client)

**Files:**
- Create: `worktreeinterop/cli.go`
- Test: `worktreeinterop/cli_test.go`

**Interfaces:**
- Consumes: `Resource` (Task 1).
- Produces:
  - `func Available() bool`
  - `func ListPrimaryResources(dir string) ([]Resource, error)`
  - command seam: package vars `execCommand func(string, ...string) *exec.Cmd`
    (default `exec.Command`) and `lookPath func(string) (string, error)`
    (default `exec.LookPath`).

- [ ] **Step 1: Write the failing test**

`worktreeinterop/cli_test.go`:

```go
package worktreeinterop

import (
	"os"
	"os/exec"
	"reflect"
	"testing"
)

// fakeExec replaces execCommand with one that runs the test binary's
// TestHelperProcess, feeding it canned stdout/exit via env.
func fakeExec(t *testing.T, stdout string, exitCode int) func() {
	t.Helper()
	orig := execCommand
	execCommand = func(name string, args ...string) *exec.Cmd {
		cs := []string{"-test.run=TestHelperProcess", "--", name}
		cs = append(cs, args...)
		cmd := exec.Command(os.Args[0], cs...)
		cmd.Env = append(os.Environ(),
			"GO_WANT_HELPER_PROCESS=1",
			"HELPER_STDOUT="+stdout,
			"HELPER_EXIT="+itoa(exitCode),
		)
		return cmd
	}
	return func() { execCommand = orig }
}

func TestListPrimaryResources_FiltersPrimaries(t *testing.T) {
	json := `[{"type":"pr","id":"o/r#1","url":"u1","primary":true},` +
		`{"type":"jira","id":"J-2","url":"u2","primary":false}]`
	defer fakeExec(t, json, 0)()

	got, err := ListPrimaryResources("/some/dir")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	want := []Resource{{Type: "pr", ID: "o/r#1", URL: "u1"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestListPrimaryResources_Empty(t *testing.T) {
	defer fakeExec(t, `[]`, 0)()
	got, err := ListPrimaryResources("/d")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected empty, got %+v", got)
	}
}

func TestListPrimaryResources_NonZeroExit(t *testing.T) {
	defer fakeExec(t, ``, 1)()
	if _, err := ListPrimaryResources("/d"); err == nil {
		t.Error("expected error on non-zero exit")
	}
}

func TestListPrimaryResources_BadJSON(t *testing.T) {
	defer fakeExec(t, `not json`, 0)()
	if _, err := ListPrimaryResources("/d"); err == nil {
		t.Error("expected error on malformed json")
	}
}

// TestHelperProcess is not a real test — it's the fake subprocess.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	os.Stdout.WriteString(os.Getenv("HELPER_STDOUT"))
	code := 0
	if os.Getenv("HELPER_EXIT") == "1" {
		code = 1
	}
	os.Exit(code)
}
```

Add a tiny `itoa` helper (or use `strconv.Itoa` inline).

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./worktreeinterop/... -run TestListPrimaryResources -v`
Expected: FAIL (undefined `execCommand`, `ListPrimaryResources`).

- [ ] **Step 3: Write minimal implementation**

`worktreeinterop/cli.go`:

```go
package worktreeinterop

import (
	"encoding/json"
	"fmt"
	"os/exec"
)

// Seams for testing.
var (
	execCommand = exec.Command
	lookPath    = exec.LookPath
)

// Available reports whether the `worktree` binary is on PATH.
func Available() bool {
	_, err := lookPath("worktree")
	return err == nil
}

type listItem struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	URL     string `json:"url"`
	Primary bool   `json:"primary"`
}

// ListPrimaryResources runs `worktree resources list --json` for dir and
// returns only the primary resources. Any error means "no worktree
// integration" — callers should proceed with their own state.
func ListPrimaryResources(dir string) ([]Resource, error) {
	cmd := execCommand("worktree", "resources", "list", "--json", "--worktree", dir)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("worktree resources list: %w", err)
	}
	var items []listItem
	if err := json.Unmarshal(out, &items); err != nil {
		return nil, fmt.Errorf("parse worktree resources json: %w", err)
	}
	var primaries []Resource
	for _, it := range items {
		if it.Primary {
			primaries = append(primaries, Resource{Type: it.Type, ID: it.ID, URL: it.URL})
		}
	}
	return primaries, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./worktreeinterop/... -run 'TestListPrimaryResources|TestHelperProcess' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worktreeinterop/cli.go worktreeinterop/cli_test.go
git commit --signoff -m "feat: worktreeinterop.ListPrimaryResources + Available (CLI read client)"
```

---

## Task 3: `worktreeinterop.AddResource` (CLI write client)

**Files:**
- Modify: `worktreeinterop/cli.go`
- Test: `worktreeinterop/cli_test.go`

**Interfaces:**
- Produces: `func AddResource(dir string, r Resource, related bool) error` —
  runs `worktree resources add <type> <id> [--url <u>] [--related] --worktree <dir>`.

- [ ] **Step 1: Write the failing test**

Add to `cli_test.go` a seam that captures argv (not just stdout). Extend the
fake to record the last command's args into a package-test var:

```go
func TestAddResource_ArgvPrimary(t *testing.T) {
	var gotArgs []string
	orig := execCommand
	execCommand = func(name string, args ...string) *exec.Cmd {
		gotArgs = append([]string{name}, args...)
		// return a command that exits 0 without doing anything
		return exec.Command(os.Args[0], "-test.run=TestHelperProcess", "--")
	}
	t.Cleanup(func() { execCommand = orig })
	os.Setenv("GO_WANT_HELPER_PROCESS", "1")
	os.Setenv("HELPER_EXIT", "0")
	t.Cleanup(func() { os.Unsetenv("GO_WANT_HELPER_PROCESS"); os.Unsetenv("HELPER_EXIT") })

	err := AddResource("/d", Resource{Type: "pr", ID: "o/r#1", URL: "u1"}, false)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := []string{"worktree", "resources", "add", "pr", "o/r#1", "--url", "u1", "--worktree", "/d"}
	if !reflect.DeepEqual(gotArgs, want) {
		t.Errorf("argv got %v want %v", gotArgs, want)
	}
}

func TestAddResource_ArgvRelatedNoURL(t *testing.T) {
	var gotArgs []string
	orig := execCommand
	execCommand = func(name string, args ...string) *exec.Cmd {
		gotArgs = append([]string{name}, args...)
		return exec.Command(os.Args[0], "-test.run=TestHelperProcess", "--")
	}
	t.Cleanup(func() { execCommand = orig })
	os.Setenv("GO_WANT_HELPER_PROCESS", "1"); os.Setenv("HELPER_EXIT", "0")
	t.Cleanup(func() { os.Unsetenv("GO_WANT_HELPER_PROCESS"); os.Unsetenv("HELPER_EXIT") })

	_ = AddResource("/d", Resource{Type: "jira", ID: "J-2"}, true)
	want := []string{"worktree", "resources", "add", "jira", "J-2", "--related", "--worktree", "/d"}
	if !reflect.DeepEqual(gotArgs, want) {
		t.Errorf("argv got %v want %v", gotArgs, want)
	}
}
```

- [ ] **Step 2: Run to verify fail**

Run: `go test ./worktreeinterop/... -run TestAddResource -v`
Expected: FAIL (undefined `AddResource`).

- [ ] **Step 3: Implement**

Add to `cli.go`:

```go
// AddResource runs `worktree resources add` for dir. Best-effort: the caller
// treats any error as a soft degradation.
func AddResource(dir string, r Resource, related bool) error {
	args := []string{"resources", "add", r.Type, r.ID}
	if r.URL != "" {
		args = append(args, "--url", r.URL)
	}
	if related {
		args = append(args, "--related")
	}
	args = append(args, "--worktree", dir)
	cmd := execCommand("worktree", args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("worktree resources add: %w (%s)", err, string(out))
	}
	return nil
}
```

> NOTE: argv order must match the tests: positional `<type> <id>`, then
> `--url` (if set), then `--related` (if set), then `--worktree <dir>`.

- [ ] **Step 4: Run to verify pass**

Run: `go test ./worktreeinterop/... -run TestAddResource -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worktreeinterop/cli.go worktreeinterop/cli_test.go
git commit --signoff -m "feat: worktreeinterop.AddResource (CLI write client)"
```

---

## Task 4: Shared `autoSubscribeWorktreePrimaries` helper + wire the 3 read seams

**Files:**
- Create: `cmd/autosubscribe.go`
- Test: `cmd/autosubscribe_test.go`
- Modify: `cmd/register.go` (~112-146), `cmd/statusline.go` (~1059-1087),
  `cmd/user_prompt_submit.go` (~184-211) — replace the triplicated
  `.worktree-resources` loop with a call to the helper.

**Interfaces:**
- Consumes: `worktreeinterop.Available`, `worktreeinterop.ListPrimaryResources`,
  `worktreeinterop.Resource`; `db.DB.SubscribeIfNew`; `config.Read`,
  `config.DefaultResourceURL`.
- Produces: `func autoSubscribeWorktreePrimaries(d *db.DB, sessionID, cwd, now string)`
  — best-effort; no return (errors swallowed/logged, must never block the caller).

- [ ] **Step 1: Write the failing test**

`cmd/autosubscribe_test.go` — use handler's existing temp-DB pattern (see other
`cmd/*_test.go` for `openTestDB`/`WATCHER_HOME` helper; reuse it). Seam
`worktreeinterop.ListPrimaryResources` via its `execCommand` var (fake returns
canned JSON). Assert:
  (a) primaries get subscribed;
  (b) a resource with a pre-existing user tombstone is NOT resurrected
      (subscribe → `d.Unsubscribe` → run helper → still unsubscribed);
  (c) empty `url` from worktree falls back to `DefaultResourceURL`.

```go
func TestAutoSubscribe_SubscribesPrimaries(t *testing.T) {
	d := openTestDB(t) // reuse handler's existing test-DB helper
	fakeWorktreeList(t, `[{"type":"pr","id":"o/r#1","url":"u1","primary":true}]`)
	fakeAvailable(t, true)

	now := time.Now().UTC().Format(time.RFC3339)
	autoSubscribeWorktreePrimaries(d, "sess-1", "/wt", now)

	subs, _ := d.ListSubscriptions("sess-1", false)
	if len(subs) != 1 || subs[0].ResourceID != "o/r#1" {
		t.Fatalf("expected pr o/r#1 subscribed, got %+v", subs)
	}
}

func TestAutoSubscribe_RespectsTombstone(t *testing.T) {
	d := openTestDB(t)
	// pre-subscribe then user-unsubscribe (tombstone)
	_ = d.Subscribe(db.Subscription{ID: "x", SessionID: "sess-1",
		ResourceType: "pr", ResourceID: "o/r#1", CreatedAt: "t"})
	_ = d.Unsubscribe("sess-1", "pr", "o/r#1")

	fakeWorktreeList(t, `[{"type":"pr","id":"o/r#1","url":"u1","primary":true}]`)
	fakeAvailable(t, true)
	autoSubscribeWorktreePrimaries(d, "sess-1", "/wt", "t2")

	subs, _ := d.ListSubscriptions("sess-1", false) // active only
	if len(subs) != 0 {
		t.Errorf("tombstoned resource must not be resurrected, got %+v", subs)
	}
}

func TestAutoSubscribe_NotAvailable(t *testing.T) {
	d := openTestDB(t)
	fakeAvailable(t, false)
	autoSubscribeWorktreePrimaries(d, "sess-1", "/wt", "t") // must not panic
	subs, _ := d.ListSubscriptions("sess-1", false)
	if len(subs) != 0 {
		t.Errorf("expected no subs when worktree absent")
	}
}
```

Add test helpers `fakeWorktreeList` (sets `worktreeinterop.execCommand` seam,
mirroring `cli_test.go`'s `TestHelperProcess` — extract that helper subprocess
so cmd tests can reuse it, OR add a `cmd`-package one) and `fakeAvailable` (sets
`worktreeinterop.lookPath`). Since `execCommand`/`lookPath` are unexported in
`worktreeinterop`, add exported test seams: `worktreeinterop` exposes
`SetExecCommandForTest`/`SetLookPathForTest` OR keep the fakes in the
`worktreeinterop` package and test the helper there. **Ruling:** put
`autoSubscribeWorktreePrimaries` and its test where the seam is reachable —
add small exported test-only setters in `worktreeinterop` (a `export_test.go`
won't help cross-package). Simplest clean approach: add
`func SetSeamsForTest(exec func(string, ...string) *exec.Cmd, look func(string)(string,error)) (restore func())`
to `worktreeinterop`, used by cmd tests. Record the ruling.

- [ ] **Step 2: Run to verify fail**

Run: `go test ./cmd/... -run TestAutoSubscribe -v`
Expected: FAIL (undefined helper).

- [ ] **Step 3: Implement the helper**

`cmd/autosubscribe.go`:

```go
package cmd

import (
	"github.com/google/uuid"
	"github.com/mturley/agent-handler/config"
	"github.com/mturley/agent-handler/db"
	"github.com/mturley/agent-handler/worktreeinterop"
)

// autoSubscribeWorktreePrimaries subscribes the session to the worktree's
// primary resources (from `worktree resources list --json`), if the worktree
// CLI is available. Best-effort: any failure is swallowed so it never blocks
// session registration. Uses SubscribeIfNew, so user-tombstoned resources are
// not resurrected.
func autoSubscribeWorktreePrimaries(d *db.DB, sessionID, cwd, now string) {
	if !worktreeinterop.Available() {
		return
	}
	resources, err := worktreeinterop.ListPrimaryResources(cwd)
	if err != nil || len(resources) == 0 {
		return
	}
	resCfg, _ := config.Read(config.DefaultPath())
	for _, r := range resources {
		if r.Type == "" || r.ID == "" {
			continue
		}
		resURL := r.URL
		if resURL == "" && resCfg != nil {
			resURL = resCfg.DefaultResourceURL(r.Type, r.ID)
		}
		var urlPtr *string
		if resURL != "" {
			urlPtr = &resURL
		}
		_ = d.SubscribeIfNew(db.Subscription{
			ID:           uuid.New().String(),
			SessionID:    sessionID,
			ResourceType: r.Type,
			ResourceID:   r.ID,
			ResourceURL:  urlPtr,
			CreatedAt:    now,
		})
	}
}
```

- [ ] **Step 4: Wire the three seams**

In `cmd/register.go`: replace lines ~112-146 (the `resourcesPath :=
filepath.Join(cwd, ".worktree-resources") ... }` block) with:

```go
	autoSubscribeWorktreePrimaries(d, regSessionID, cwd, now)
```

(register.go returns errors on subscribe today; the helper swallows them by
design — a broken worktree CLI must not fail registration. This is an
intentional behavior change: registration no longer errors out on a bad
resource. Record in ledger.)

In `cmd/statusline.go`: replace the block at ~1060-1086 (inside
`if isNewSession {`) with `autoSubscribeWorktreePrimaries(d, input.SessionID, cwd, now)`.

In `cmd/user_prompt_submit.go`: replace the block at ~184-211 with
`autoSubscribeWorktreePrimaries(d, input.SessionID, cwd, now)`.

Remove now-unused imports (`filepath`, `bufio`, `uuid` if unused, the old
`worktreeinterop.ReadResources`/`ParseResourceID` references) from those files.
Keep the "spawn catch-up watcher runs" blocks that follow (they read from the
DB via `ListSubscriptions`, unchanged).

- [ ] **Step 5: Run tests**

Run: `go test ./cmd/... -run TestAutoSubscribe -v && go build ./...`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add cmd/autosubscribe.go cmd/autosubscribe_test.go cmd/register.go cmd/statusline.go cmd/user_prompt_submit.go worktreeinterop
git commit --signoff -m "feat: auto-watch worktree primaries via CLI at registration (replaces .worktree-resources reads)"
```

---

## Task 5: Delete the `.worktree-resources` file-I/O + its tests

**Files:**
- Modify/delete: `worktreeinterop/resources.go` (delete `ReadResources`,
  `AppendResource`, `RemoveResource` and the old `Resource` shape if any
  remains)
- Modify/delete: `worktreeinterop/resources_test.go` (delete file-I/O tests)

> If Task 1's ruling already merged this deletion forward, mark this task
> complete with a ledger note and skip. Otherwise:

- [ ] **Step 1: Delete dead file-I/O**

Remove `ReadResources`, `AppendResource`, `RemoveResource` from
`worktreeinterop/resources.go`. If the file is then empty, `git rm` it.

- [ ] **Step 2: Delete their tests**

Remove `TestReadResources*`, `TestAppendResource*`, `TestRemoveResource*` from
`worktreeinterop/resources_test.go`. If empty, `git rm` it.

- [ ] **Step 3: Verify nothing references the deleted funcs**

Run: `grep -rn "ReadResources\|AppendResource\|RemoveResource\|\.worktree-resources" --include="*.go" .`
Expected: no matches (except possibly help text already removed in Task 6).

- [ ] **Step 4: Build + test**

Run: `go build ./... && go test ./worktreeinterop/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u worktreeinterop
git commit --signoff -m "chore: delete dead .worktree-resources file-I/O"
```

---

## Task 6: `/watch` propagates to worktree; `/unwatch` becomes handler-only

**Files:**
- Modify: `cmd/subscribe.go`
- Modify: `cmd/unsubscribe.go`
- Test: `cmd/subscribe_test.go` (add), `cmd/unsubscribe_test.go` (add)

**Interfaces:**
- Consumes: `worktreeinterop.Available`, `worktreeinterop.AddResource`,
  `worktreeinterop.Resource`, `worktreeinterop.ParseResourceID`.

- [ ] **Step 1: Write the failing tests**

`cmd/subscribe_test.go`: with the worktreeinterop seam faked to capture argv,
assert that after a successful subscribe, `AddResource` is invoked with the
parsed type/id, the resolved URL, and `related` matching the `--related` flag.
`cmd/unsubscribe_test.go`: assert that unsubscribe makes **zero** worktree
invocations (fake asserts the exec seam is never called).

```go
func TestSubscribe_PropagatesToWorktree(t *testing.T) {
	// fake seam captures argv; fake Available=true; run runSubscribe with
	// --resource pr:o/r#1 --url u1 (no --related)
	// assert argv == worktree resources add pr o/r#1 --url u1 --worktree <cwd>
}

func TestUnsubscribe_NoWorktreeCall(t *testing.T) {
	// fake seam records invocation count; run runUnsubscribe; assert count==0
}
```

(Flesh these out using handler's existing cmd-test scaffolding — set flags on a
fresh `*cobra.Command` or call the `runX` funcs with a test DB. Follow the
pattern in the nearest existing `cmd/*_test.go`.)

- [ ] **Step 2: Run to verify fail**

Run: `go test ./cmd/... -run 'TestSubscribe_Propagates|TestUnsubscribe_NoWorktree' -v`
Expected: FAIL.

- [ ] **Step 3: Rewrite subscribe.go's persist path**

In `cmd/subscribe.go`:
- Replace the `--primary`/`--persist` flags with a single `--related` flag:
  `subscribeCmd.Flags().Bool("related", false, "propagate to worktree as a related (not primary) resource")`
  Remove the `--primary` and `--persist` flag registrations.
- Replace the "Persist to .worktree-resources if requested" block with:

```go
	// Propagate to the worktree CLI if present (best-effort).
	if worktreeinterop.Available() {
		related, _ := cmd.Flags().GetBool("related")
		cwd, _ := os.Getwd()
		u := ""
		if urlPtr != nil {
			u = *urlPtr
		}
		if err := worktreeinterop.AddResource(cwd, worktreeinterop.Resource{
			Type: resourceType, ID: resourceID, URL: u,
		}, related); err != nil {
			// soft degradation: subscribe already succeeded
			fmt.Fprintf(os.Stderr, "warning: could not propagate to worktree: %v\n", err)
		}
	}
```

Add `"os"` import if missing.

- [ ] **Step 4: Strip unsubscribe.go's persist path**

In `cmd/unsubscribe.go`: remove the `--persist` flag registration and the
entire "Remove from .worktree-resources if requested" block. `runUnsubscribe`
now only calls `d.Unsubscribe(...)` (handler DB) and prints. Remove the
`worktreeinterop` import if no longer used (it still uses `ParseResourceID`, so
keep it).

- [ ] **Step 5: Run tests**

Run: `go test ./cmd/... -run 'TestSubscribe|TestUnsubscribe' -v && go build ./...`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add cmd/subscribe.go cmd/unsubscribe.go cmd/subscribe_test.go cmd/unsubscribe_test.go
git commit --signoff -m "feat: /watch propagates to worktree (primary default, --related opt-in); /unwatch is handler-only"
```

---

## Task 7: Full suite + integration sanity

**Files:** none (verification task).

- [ ] **Step 1: Full test suite**

Run: `go test ./...`
Expected: PASS (all packages).

- [ ] **Step 2: Grep for any residual file-based references**

Run: `grep -rn "worktree-resources\|\"github.com/mturley/agent-handler/worktree\"\|ReadResources\|AppendResource\|RemoveResource" --include="*.go" .`
Expected: no matches.

- [ ] **Step 3: Confirm help text / flags are consistent**

Run: `go run . subscribe --help` and `go run . unsubscribe --help`
Expected: subscribe shows `--related` (no `--primary`/`--persist`); unsubscribe
shows no `--persist`.

- [ ] **Step 4: Ledger note the manual smoke item (not run here)**

Record in the ledger: manual smoke with a real `worktree` install — register in
a worktree → primaries auto-watch; `handler subscribe --resource pr:...` →
appears in worktree's UI; `handler unsubscribe` → worktree unaffected. Requires
building/installing handler (kill+restart the running UI server first, with
Mike's OK).

- [ ] **Step 5: Commit (if any doc/ledger tweaks)** — otherwise skip.

---

## Self-Review

**Spec coverage:**
- Registration auto-watch of primaries → Task 4. ✅
- `/watch` → worktree primary-default + `--related` → Task 6. ✅
- `/unwatch` handler-only → Task 6. ✅
- Delete `.worktree-resources` readers/writers → Tasks 4, 5, 6. ✅
- Graceful degradation (`Available()` gate) → Tasks 2, 4, 6. ✅
- Tombstone-respecting → Task 4 test. ✅
- URL mapping/backfill → Task 4 helper. ✅
- Command seam for tests → Tasks 2, 4. ✅
- No watcher/DB change → whole plan (Global Constraints). ✅

**Type consistency:** `Resource{Type,ID,URL}` defined Task 1, consumed Tasks
2/3/4/6 with the same field names. `ListPrimaryResources(dir)→([]Resource,error)`,
`AddResource(dir, Resource, related bool)→error`, `Available()→bool`,
`autoSubscribeWorktreePrimaries(d, sessionID, cwd, now)` consistent throughout.

**Placeholder scan:** the two `cmd` write-seam tests (Task 6) are described
against handler's existing cmd-test scaffolding rather than fully transcribed,
because that scaffolding's exact shape (how `runSubscribe` is invoked in tests)
must be read from the repo at execution time — the implementer is directed to
the nearest existing `cmd/*_test.go`. Flagged, not a silent gap.

**Open ruling for the executor:** the test seam exposure
(`SetSeamsForTest` in `worktreeinterop`) — Task 4 records the ruling; adjust if
the repo already has a cleaner cross-package seam pattern.
