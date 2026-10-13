# cmux Tab Peek Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hovering a tab row in the worktree detail page's cmux tab opens a hover card peeking at that tab — terminal text, browser screenshot, or rendered markdown — without focusing it.

**Architecture:** `internal/cmux/peek.go` wraps the three cmux commands (`read-screen`, `browser screenshot`, `read-selection`) and owns the screenshot temp files. A new `GET /api/cmux/peek` in `internal/webui/cmux_tabs.go` looks the tab's type up from `cmux tree` and dispatches. In the UI, `PaneDiagram`'s `TabRow` swaps its `Tooltip` for a `Popover` driven by the existing `useHoverMenu`, whose dropdown mounts `CmuxPeekCard`, which fetches via `useCmuxPeek`.

**Tech Stack:** Go (net/http, os/exec), React + Mantine 7 + TanStack Query, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-13-cmux-tab-peek-design.md`

## Global Constraints

- Terminal capture: `--scrollback --lines 200`.
- Markdown files: absolute path, extension `.md` or `.markdown` (case-insensitive), regular file, at most 512 KiB (`512 << 10` bytes). Anything else → `unsupported`.
- Screenshot dir: `filepath.Join(os.TempDir(), "worktree-cmux-peek")`, mode 0700; per-surface file `<surface ref with ":" → "-">.png`; removed before and after each screenshot; whole dir removed at `worktree ui` startup.
- Terminal peeks refetch every 5000ms while open; browser/markdown fetch once per open (no refetch, `staleTime: 0`, `gcTime: 0`).
- Hover: `openDelay` 400ms, `closeDelay` 300ms, at most one card open, disabled during a tab drag.
- Desktop only: no card when `(hover: none)` matches.
- cmux failures on the peek route → `writeError(w, http.StatusBadGateway, …)`; cmux not running → `writeError(w, http.StatusServiceUnavailable, "cmux is not running")`. Never `respondCmuxAction`/`cmuxUnavailable` (those answer 200 `ok:false`).
- Commits: `git commit --signoff`, add files by name (never `git add -A`/`.`), end messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Don't disable lint rules.

## Review Focus

1. **A tab closed between hover and fetch** — `FindTab` misses → 404, and the card shows the error text rather than a spinner forever. Pinned in Task 2 (`TestCmuxPeekUnknownSurface`) and Task 4 (error-render test).
2. **Two peeks of the same browser tab at once** — they must not race on one file; the per-surface mutex serializes them. Pinned in Task 1 (`TestScreenshotSerializesSameSurface`).
3. **A screenshot command that fails after writing a partial file** — the file must still be removed. Pinned in Task 1 (`TestScreenshotRemovesFileOnFailure`).
4. **A markdown tab pointing at a huge or non-markdown file** (`read-selection` returns whatever cmux has open) — never read past 512 KiB, never return a non-`.md` file. Pinned in Task 2 (`TestReadPeekMarkdownGuards`).
5. **Starting a drag while a card is open** — the card must close so it doesn't float over the drop targets. Pinned in Task 4 (drag test).

---

### Task 1: cmux peek commands and screenshot file lifecycle

**Files:**
- Create: `internal/cmux/peek.go`
- Test: `internal/cmux/peek_test.go`

**Interfaces:**
- Consumes: `cmuxCmd` (package var in `internal/cmux/cmux.go:120`), `runCmux` (`internal/cmux/tabs.go:13`), test helper `stubCmux(t, bin) *[]string` (`internal/cmux/description_test.go:9`).
- Produces:
  - `func ReadScreen(workspaceID, surfaceRef string, lines int) (string, error)`
  - `func MarkdownPath(workspaceID, surfaceRef string) (string, error)` — `""` when cmux reports no `file_path`
  - `func Screenshot(surfaceRef string) ([]byte, error)`
  - `func ClearPeekScreenshots()`
  - `var peekDir func() string` (test seam)

- [ ] **Step 1: Write the failing tests**

Create `internal/cmux/peek_test.go`:

```go
package cmux

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// stubCmuxScript runs script under sh for every cmux call, with the call's
// args as $1… so a stub can act on them (e.g. write to the --out path).
func stubCmuxScript(t *testing.T, script string) *[]string {
	t.Helper()
	var got []string
	orig := cmuxCmd
	cmuxCmd = func(args ...string) *exec.Cmd {
		got = args
		return exec.Command("sh", append([]string{"-c", script, "sh"}, args...)...)
	}
	t.Cleanup(func() { cmuxCmd = orig })
	return &got
}

func usePeekDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "peek")
	orig := peekDir
	peekDir = func() string { return dir }
	t.Cleanup(func() { peekDir = orig })
	return dir
}

func TestReadScreenArgsAndTrim(t *testing.T) {
	got := stubCmuxScript(t, `printf 'line 1\nline 2\n\n'`)
	text, err := ReadScreen("W", "surface:3", 200)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"read-screen", "--workspace", "W", "--surface", "surface:3", "--scrollback", "--lines", "200"}
	if !reflect.DeepEqual(*got, want) {
		t.Fatalf("args = %q, want %q", *got, want)
	}
	if text != "line 1\nline 2" {
		t.Fatalf("text = %q", text)
	}
}

func TestReadScreenReportsStderr(t *testing.T) {
	stubCmuxScript(t, `echo "Error: invalid_params: Surface is not a terminal" >&2; exit 1`)
	_, err := ReadScreen("W", "surface:3", 200)
	if err == nil || !strings.Contains(err.Error(), "Surface is not a terminal") {
		t.Fatalf("err = %v, want cmux's stderr in it", err)
	}
}

func TestMarkdownPath(t *testing.T) {
	got := stubCmuxScript(t, `printf '{"has_selection":false,"kind":"markdown","file_path":"/tmp/notes.md","text":""}'`)
	path, err := MarkdownPath("W", "surface:3")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"read-selection", "--workspace", "W", "--surface", "surface:3", "--json"}
	if !reflect.DeepEqual(*got, want) {
		t.Fatalf("args = %q, want %q", *got, want)
	}
	if path != "/tmp/notes.md" {
		t.Fatalf("path = %q", path)
	}
}

func TestMarkdownPathAbsent(t *testing.T) {
	stubCmuxScript(t, `printf '{"has_selection":false,"kind":"markdown","text":""}'`)
	path, err := MarkdownPath("W", "surface:3")
	if err != nil || path != "" {
		t.Fatalf("path=%q err=%v, want empty and no error", path, err)
	}
}

// writeOut sets $out to the stub's last argument — `--out <path>`'s path.
const writeOut = `for a; do out=$a; done; `

func TestScreenshotRemovesStaleFileBeforeAndNewFileAfter(t *testing.T) {
	dir := usePeekDir(t)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dir, "surface-7.png")
	if err := os.WriteFile(stale, []byte("OLD"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Fails if the stale file is still there when cmux runs.
	got := stubCmuxScript(t, writeOut+`test ! -e "$out" && printf NEW > "$out"`)
	png, err := Screenshot("surface:7")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"browser", "--surface", "surface:7", "screenshot", "--out", stale}
	if !reflect.DeepEqual(*got, want) {
		t.Fatalf("args = %q, want %q", *got, want)
	}
	if string(png) != "NEW" {
		t.Fatalf("bytes = %q", png)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("screenshot file still on disk after read (stat err = %v)", err)
	}
	if info, err := os.Stat(dir); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("peek dir mode = %v err = %v, want 0700", info.Mode().Perm(), err)
	}
}

func TestScreenshotRemovesFileOnFailure(t *testing.T) {
	dir := usePeekDir(t)
	stubCmuxScript(t, writeOut+`printf PARTIAL > "$out"; echo boom >&2; exit 1`)
	if _, err := Screenshot("surface:7"); err == nil {
		t.Fatal("want error when cmux fails")
	}
	if _, err := os.Stat(filepath.Join(dir, "surface-7.png")); !os.IsNotExist(err) {
		t.Fatalf("partial screenshot left on disk (stat err = %v)", err)
	}
}

func TestScreenshotSerializesSameSurface(t *testing.T) {
	usePeekDir(t)
	var running, maxRunning int32
	orig := cmuxCmd
	t.Cleanup(func() { cmuxCmd = orig })
	cmuxCmd = func(args ...string) *exec.Cmd {
		n := atomic.AddInt32(&running, 1)
		for {
			m := atomic.LoadInt32(&maxRunning)
			if n <= m || atomic.CompareAndSwapInt32(&maxRunning, m, n) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		atomic.AddInt32(&running, -1)
		return exec.Command("sh", append([]string{"-c", writeOut + `printf X > "$out"`, "sh"}, args...)...)
	}
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := Screenshot("surface:9"); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if maxRunning != 1 {
		t.Fatalf("max concurrent screenshots of one surface = %d, want 1", maxRunning)
	}
}

func TestClearPeekScreenshots(t *testing.T) {
	dir := usePeekDir(t)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "surface-1.png"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	ClearPeekScreenshots()
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("peek dir still exists (stat err = %v)", err)
	}
}
```

Note on `TestScreenshotSerializesSameSurface`: the stub's sleep runs inside `cmuxCmd` (i.e. while `Screenshot` holds the mutex, before the command executes), so overlapping callers would push `maxRunning` above 1 without the lock.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/cmux/ -run 'ReadScreen|MarkdownPath|Screenshot|ClearPeek' -v`
Expected: FAIL to compile — `undefined: ReadScreen`, `peekDir`, etc.

- [ ] **Step 3: Implement**

Create `internal/cmux/peek.go`:

```go
package cmux

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// The cmux tab's hover peek (internal/webui handleCmuxPeek). Verified
// against cmux 0.65.0: all three commands work on tabs that are not selected
// and in workspaces that are not focused, and none of them moves focus.

// cmuxOutput runs one cmux command and returns its stdout, folding stderr
// into the error.
func cmuxOutput(what string, args ...string) ([]byte, error) {
	out, err := cmuxCmd(args...).Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			if stderr := strings.TrimSpace(string(exitErr.Stderr)); stderr != "" {
				return nil, fmt.Errorf("%s: %s", what, stderr)
			}
		}
		return nil, fmt.Errorf("%s: %w", what, err)
	}
	return out, nil
}

// ReadScreen returns a terminal tab's last `lines` lines, scrollback
// included, as plain text. cmux refuses non-terminal surfaces.
func ReadScreen(workspaceID, surfaceRef string, lines int) (string, error) {
	out, err := cmuxOutput("reading terminal", "read-screen", "--workspace", workspaceID, "--surface", surfaceRef,
		"--scrollback", "--lines", strconv.Itoa(lines))
	if err != nil {
		return "", err
	}
	return strings.TrimRight(string(out), "\n"), nil
}

// MarkdownPath returns the file a markdown tab shows, or "" when cmux does
// not say. cmux's contract documents read-selection's file_path only for
// selections; that it is present with no selection is observed behavior
// (cmux 0.65.0), not a promise — hence "" rather than an error.
func MarkdownPath(workspaceID, surfaceRef string) (string, error) {
	out, err := cmuxOutput("reading markdown tab", "read-selection", "--workspace", workspaceID, "--surface", surfaceRef, "--json")
	if err != nil {
		return "", err
	}
	var sel struct {
		FilePath string `json:"file_path"`
	}
	if err := json.Unmarshal(out, &sel); err != nil {
		return "", fmt.Errorf("parsing read-selection: %w", err)
	}
	return sel.FilePath, nil
}

// peekDir holds browser screenshots for the instant between cmux writing one
// and Screenshot reading it back. A var so tests can point it elsewhere.
var peekDir = func() string { return filepath.Join(os.TempDir(), "worktree-cmux-peek") }

// screenshotLocks serializes screenshots of one surface, which share a file
// path; different surfaces proceed in parallel.
var screenshotLocks sync.Map // surface ref → *sync.Mutex

// Screenshot returns a PNG of a browser tab as it currently renders. No file
// outlives the call: any leftover at the surface's path is removed first,
// and the new one is removed once read (or once cmux fails).
func Screenshot(surfaceRef string) ([]byte, error) {
	lock, _ := screenshotLocks.LoadOrStore(surfaceRef, &sync.Mutex{})
	mu := lock.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()

	dir := peekDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("creating peek dir: %w", err)
	}
	path := filepath.Join(dir, strings.ReplaceAll(surfaceRef, ":", "-")+".png")
	_ = os.Remove(path)
	defer os.Remove(path)
	if err := runCmux("taking screenshot", "browser", "--surface", surfaceRef, "screenshot", "--out", path); err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}

// ClearPeekScreenshots removes the screenshot dir, catching anything a crash
// left between a screenshot and its cleanup. Run at `worktree ui` startup.
func ClearPeekScreenshots() {
	_ = os.RemoveAll(peekDir())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/cmux/ -v -run 'ReadScreen|MarkdownPath|Screenshot|ClearPeek' && go test ./internal/cmux/ && go vet ./internal/cmux/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/cmux/peek.go internal/cmux/peek_test.go
git commit --signoff -m "feat(cmux): read-screen, markdown path and screenshot for tab peek" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `GET /api/cmux/peek` and startup sweep

**Files:**
- Modify: `internal/webui/cmux_tabs.go` (`cmuxTabOps` struct ~line 17, `realCmuxTabOps` ~line 33; add handler + helpers at end of file)
- Modify: `internal/webui/server.go` (route table, after `{"GET /api/cmux/browser-tabs", …}` ~line 212)
- Modify: `cmd/ui.go` (after `srv := &webui.Server{…}` ~line 150)
- Test: `internal/webui/cmux_peek_test.go` (new), `internal/webui/cmux_tabs_test.go` (`fakeTabOps`)

**Interfaces:**
- Consumes: Task 1's `cmux.ReadScreen`, `cmux.MarkdownPath`, `cmux.Screenshot`, `cmux.ClearPeekScreenshots`; existing `validWorkspaceID`, `surfaceRefRe`, `writeError`, `writeJSON`, `(*cmux.WorkspaceTree).FindTab`; test helpers `newTabServer`, `wsID`, `sampleTree` (surface:1 terminal, surface:2 browser, surface:3 markdown, all in `wsID`).
- Produces: route `GET /api/cmux/peek?id=<uuid>&surface=surface:N` returning

```go
type cmuxPeekResponse struct {
	Type        string `json:"type"`
	Text        string `json:"text,omitempty"`
	Image       string `json:"image,omitempty"`
	Markdown    string `json:"markdown,omitempty"`
	Path        string `json:"path,omitempty"`
	Unsupported bool   `json:"unsupported,omitempty"`
}
```

- [ ] **Step 1: Extend the fake**

In `internal/webui/cmux_tabs_test.go`, add fields to `fakeTabOps` (after `browserTabsErr`):

```go
	// screen, png and mdPath back the peek seams; peekErr fails all three.
	screen  string
	png     []byte
	mdPath  string
	peekErr error
```

and entries in the `&cmuxTabOps{…}` literal in `ops()`:

```go
		readScreen: func(id, s string, lines int) (string, error) {
			f.calls = append(f.calls, fmt.Sprintf("read-screen %s %s %d", id, s, lines))
			return f.screen, f.peekErr
		},
		screenshot: func(s string) ([]byte, error) {
			f.calls = append(f.calls, "screenshot "+s)
			return f.png, f.peekErr
		},
		markdownPath: func(id, s string) (string, error) {
			f.calls = append(f.calls, "markdown-path "+id+" "+s)
			return f.mdPath, f.peekErr
		},
```

- [ ] **Step 2: Write the failing tests**

Create `internal/webui/cmux_peek_test.go`:

```go
package webui

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/cmux"
)

func getPeek(t *testing.T, s *Server, id, surface string) (int, cmuxPeekResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handleCmuxPeek(rec, httptest.NewRequest(http.MethodGet, "/api/cmux/peek?id="+id+"&surface="+surface, nil))
	var got cmuxPeekResponse
	if rec.Code == http.StatusOK {
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
	}
	return rec.Code, got
}

func TestCmuxPeekTerminal(t *testing.T) {
	s, f := newTabServer(t)
	f.screen = "$ make test\nok"
	code, got := getPeek(t, s, wsID, "surface:1")
	if code != http.StatusOK || got.Type != "terminal" || got.Text != "$ make test\nok" {
		t.Fatalf("code=%d got=%+v", code, got)
	}
	if !f.called("read-screen " + wsID + " surface:1 200") {
		t.Fatalf("calls = %q, want read-screen with 200 lines", f.calls)
	}
}

func TestCmuxPeekBrowser(t *testing.T) {
	s, f := newTabServer(t)
	f.png = []byte("PNG")
	code, got := getPeek(t, s, wsID, "surface:2")
	if code != http.StatusOK || got.Type != "browser" || got.Image != "data:image/png;base64,UE5H" {
		t.Fatalf("code=%d got=%+v", code, got)
	}
}

func TestCmuxPeekMarkdown(t *testing.T) {
	s, f := newTabServer(t)
	f.mdPath = filepath.Join(t.TempDir(), "notes.md")
	if err := os.WriteFile(f.mdPath, []byte("# Hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	code, got := getPeek(t, s, wsID, "surface:3")
	if code != http.StatusOK || got.Type != "markdown" || got.Markdown != "# Hello" || got.Path != f.mdPath || got.Unsupported {
		t.Fatalf("code=%d got=%+v", code, got)
	}
}

func TestCmuxPeekMarkdownWithoutPathIsUnsupported(t *testing.T) {
	s, _ := newTabServer(t)
	code, got := getPeek(t, s, wsID, "surface:3")
	if code != http.StatusOK || !got.Unsupported || got.Markdown != "" {
		t.Fatalf("code=%d got=%+v", code, got)
	}
}

func TestCmuxPeekOtherTypeIsUnsupportedWithoutPeeking(t *testing.T) {
	s, f := newTabServer(t)
	tree := sampleTree()
	tree.Panes[2].Tabs = []cmux.TreeTab{{Ref: "surface:5", Type: "simulator", Title: "sim"}}
	f.trees[wsID] = tree
	code, got := getPeek(t, s, wsID, "surface:5")
	if code != http.StatusOK || got.Type != "simulator" || !got.Unsupported {
		t.Fatalf("code=%d got=%+v", code, got)
	}
	if len(f.calls) != 1 || !strings.HasPrefix(f.calls[0], "tree ") {
		t.Fatalf("calls = %q, want only the tree read", f.calls)
	}
}

func TestCmuxPeekUnknownSurface(t *testing.T) {
	s, f := newTabServer(t)
	if code, _ := getPeek(t, s, wsID, "surface:42"); code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", code)
	}
	if f.called("read-screen") || f.called("screenshot") || f.called("markdown-path") {
		t.Fatalf("peeked a surface not in the workspace: %q", f.calls)
	}
}

func TestCmuxPeekValidation(t *testing.T) {
	s, f := newTabServer(t)
	for _, c := range []struct{ id, surface string }{
		{"", "surface:1"},
		{"--action", "surface:1"},
		{wsID, ""},
		{wsID, "pane:1"},
		{wsID, "surface:1%20--workspace%20X"},
	} {
		if code, _ := getPeek(t, s, c.id, c.surface); code != http.StatusBadRequest {
			t.Errorf("id=%q surface=%q: status = %d, want 400", c.id, c.surface, code)
		}
	}
	if len(f.calls) != 0 {
		t.Fatalf("called cmux on invalid input: %q", f.calls)
	}
}

func TestCmuxPeekUnavailable(t *testing.T) {
	s, f := newTabServer(t)
	t.Setenv("CMUX_SOCKET_PATH", "")
	if code, _ := getPeek(t, s, wsID, "surface:1"); code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", code)
	}
	if len(f.calls) != 0 {
		t.Fatalf("calls = %q, want none", f.calls)
	}
}

func TestCmuxPeekCmuxFailureIs502(t *testing.T) {
	s, f := newTabServer(t)
	f.peekErr = errors.New("taking screenshot: boom")
	if code, _ := getPeek(t, s, wsID, "surface:2"); code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", code)
	}
	if code, _ := getPeek(t, s, goneID, "surface:2"); code != http.StatusBadGateway {
		t.Fatalf("tree failure: status = %d, want 502", code)
	}
}

func TestReadPeekMarkdownGuards(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, size int) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(strings.Repeat("a", size)), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	ok := write("ok.md", 10)
	upper := write("UPPER.MARKDOWN", 10)
	atLimit := write("limit.md", peekMarkdownMaxBytes)
	tooBig := write("big.md", peekMarkdownMaxBytes+1)
	txt := write("notes.txt", 10)
	subdir := filepath.Join(dir, "folder.md")
	if err := os.Mkdir(subdir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		path string
		want bool
	}{
		{ok, true},
		{upper, true},
		{atLimit, true},
		{tooBig, false},
		{txt, false},
		{subdir, false},
		{"relative/notes.md", false},
		{filepath.Join(dir, "missing.md"), false},
		{"", false},
	} {
		if _, got := readPeekMarkdown(c.path); got != c.want {
			t.Errorf("readPeekMarkdown(%q) ok = %v, want %v", c.path, got, c.want)
		}
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test ./internal/webui/ -run 'CmuxPeek|ReadPeekMarkdown' -v`
Expected: FAIL to compile — `unknown field readScreen in struct literal`, `s.handleCmuxPeek undefined`.

- [ ] **Step 4: Implement**

In `internal/webui/cmux_tabs.go`, add to `cmuxTabOps` (after `browserTabs`):

```go
	readScreen   func(id, surface string, lines int) (string, error)
	screenshot   func(surface string) ([]byte, error)
	markdownPath func(id, surface string) (string, error)
```

and to `realCmuxTabOps()`:

```go
		readScreen:      cmux.ReadScreen,
		screenshot:      cmux.Screenshot,
		markdownPath:    cmux.MarkdownPath,
```

Append to `internal/webui/cmux_tabs.go` (add `encoding/base64`, `fmt`, `os`, `path/filepath` to its imports as needed):

```go
const (
	peekTerminalLines    = 200
	peekMarkdownMaxBytes = 512 << 10
)

type cmuxPeekResponse struct {
	Type        string `json:"type"`                  // the tab's type, from cmux
	Text        string `json:"text,omitempty"`        // terminal
	Image       string `json:"image,omitempty"`       // browser: data:image/png;base64,…
	Markdown    string `json:"markdown,omitempty"`    // markdown
	Path        string `json:"path,omitempty"`        // markdown: the file shown
	Unsupported bool   `json:"unsupported,omitempty"` // nothing to peek at
}

// handleCmuxPeek: GET /api/cmux/peek?id=<workspace>&surface=<surface ref>
//
// The cmux tab's hover card. The tab's type comes from a fresh `cmux tree`,
// never the client, which also proves the surface belongs to that
// workspace. Unlike the POST actions above, this is a data GET: failures are
// real HTTP errors, not 200 ok:false.
func (s *Server) handleCmuxPeek(w http.ResponseWriter, r *http.Request) {
	id, surface := r.URL.Query().Get("id"), r.URL.Query().Get("surface")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing id")
		return
	}
	if !validWorkspaceID(w, id) {
		return
	}
	if !surfaceRefRe.MatchString(surface) {
		writeError(w, http.StatusBadRequest, "invalid surface")
		return
	}
	if !cmux.IsAvailable() {
		writeError(w, http.StatusServiceUnavailable, "cmux is not running")
		return
	}
	ops := s.tabOps()
	tree, err := ops.tree(id)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	tab, _, ok := tree.FindTab(surface)
	if !ok {
		writeError(w, http.StatusNotFound, "no such tab")
		return
	}
	resp := cmuxPeekResponse{Type: tab.Type}
	switch tab.Type {
	case "terminal":
		resp.Text, err = ops.readScreen(id, surface, peekTerminalLines)
	case "browser":
		var png []byte
		if png, err = ops.screenshot(surface); err == nil {
			resp.Image = "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
		}
	case "markdown":
		var path string
		if path, err = ops.markdownPath(id, surface); err == nil {
			if md, ok := readPeekMarkdown(path); ok {
				resp.Markdown, resp.Path = md, path
			} else {
				resp.Unsupported = true
			}
		}
	default:
		resp.Unsupported = true
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// readPeekMarkdown reads a markdown tab's file, but only a Markdown file of
// sane size: the path comes from cmux rather than the request, but the UI is
// reachable remotely, so the server never hands back anything else.
func readPeekMarkdown(path string) (string, bool) {
	if !filepath.IsAbs(path) {
		return "", false
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".md", ".markdown":
	default:
		return "", false
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > peekMarkdownMaxBytes {
		return "", false
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) > peekMarkdownMaxBytes {
		return "", false
	}
	return string(data), true
}
```

In `internal/webui/server.go`, add after `{"GET /api/cmux/browser-tabs", s.handleCmuxBrowserTabs},`:

```go
		{"GET /api/cmux/peek", s.handleCmuxPeek},
```

In `cmd/ui.go`, immediately after the `srv := &webui.Server{…}` statement, add (importing `github.com/mturley/worktree/internal/cmux` if not already imported):

```go
	// Browser peek screenshots live only for one request; this catches any
	// a crash left behind (internal/cmux/peek.go).
	cmux.ClearPeekScreenshots()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/webui/ -run 'CmuxPeek|ReadPeekMarkdown' -v && go test ./... && go vet ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/webui/cmux_tabs.go internal/webui/cmux_tabs_test.go internal/webui/cmux_peek_test.go internal/webui/server.go cmd/ui.go
git commit --signoff -m "feat(webui): GET /api/cmux/peek for the cmux tab's hover card" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: UI API client and `useCmuxPeek`

**Files:**
- Modify: `ui/src/api/types.ts` (after `CmuxTab`, ~line 267)
- Modify: `ui/src/api/client.ts` (the `api` object, after `cmuxTree`)
- Create: `ui/src/api/cmuxPeek.ts`
- Test: `ui/src/api/cmuxPeek.test.tsx`

**Interfaces:**
- Consumes: Task 2's route and response shape.
- Produces:
  - `export interface CmuxPeek { type: string; text?: string; image?: string; markdown?: string; path?: string; unsupported?: boolean }` in `types.ts`
  - `api.cmuxPeek(id: string, surface: string): Promise<CmuxPeek>`
  - `export function peekQueryOptions(type: string): { refetchInterval: number | false; staleTime: number; gcTime: number; retry: false }`
  - `export function useCmuxPeek(workspaceId: string, tab: CmuxTab)` — a `useQuery` result of `CmuxPeek`

- [ ] **Step 1: Write the failing test**

Create `ui/src/api/cmuxPeek.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { api } from "./client"
import { peekQueryOptions, useCmuxPeek } from "./cmuxPeek"

afterEach(() => vi.restoreAllMocks())

function wrapper() {
  const qc = new QueryClient()
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe("peekQueryOptions", () => {
  it("refreshes terminals every 5s", () => {
    expect(peekQueryOptions("terminal").refetchInterval).toBe(5000)
  })

  it("fetches browser and markdown once per open and keeps nothing", () => {
    for (const type of ["browser", "markdown"]) {
      expect(peekQueryOptions(type)).toEqual({ refetchInterval: false, staleTime: 0, gcTime: 0, retry: false })
    }
  })
})

describe("useCmuxPeek", () => {
  it("fetches the tab's peek by workspace id and surface ref", async () => {
    const spy = vi.spyOn(api, "cmuxPeek").mockResolvedValue({ type: "terminal", text: "hi" })
    const tab = { ref: "surface:4", title: "zsh", type: "terminal", selected: false }
    const { result } = renderHook(() => useCmuxPeek("W", tab), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data?.text).toBe("hi"))
    expect(spy).toHaveBeenCalledWith("W", "surface:4")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/api/cmuxPeek.test.tsx`
Expected: FAIL — cannot resolve `./cmuxPeek`.

- [ ] **Step 3: Implement**

In `ui/src/api/types.ts`, after `CmuxTab`:

```ts
/** GET /api/cmux/peek: one tab's content for the cmux tab's hover card. */
export interface CmuxPeek {
  /** The tab's type as cmux reports it — read server-side, not echoed from the request. */
  type: string
  /** terminal: the last 200 lines, scrollback included, as plain text. */
  text?: string
  /** browser: a data:image/png URL of the page as it renders now. */
  image?: string
  /** markdown: the file's source. */
  markdown?: string
  /** markdown: the file shown. */
  path?: string
  /** Nothing to peek at (another tab type, or a markdown file cmux would not name or the server would not read). */
  unsupported?: boolean
}
```

In `ui/src/api/client.ts`, import `CmuxPeek` alongside the other types and add after `cmuxTree`:

```ts
  cmuxPeek: (id: string, surface: string) =>
    fetchJSON<CmuxPeek>(`/api/cmux/peek?id=${encodeURIComponent(id)}&surface=${encodeURIComponent(surface)}`),
```

Create `ui/src/api/cmuxPeek.ts`:

```ts
import { useQuery } from "@tanstack/react-query"
import { api } from "./client"
import type { CmuxTab } from "./types"

/**
 * How a tab's peek is fetched. Terminals change under you, so they refresh
 * every 5s while the card is open. A browser peek is a ~1s, ~200KB
 * screenshot and a markdown peek a file read: one fetch per open, nothing
 * kept once the card closes, so reopening always shows the tab as it is now.
 */
export function peekQueryOptions(type: string) {
  return {
    refetchInterval: type === "terminal" ? 5000 : (false as const),
    staleTime: 0,
    gcTime: 0,
    retry: false as const,
  }
}

/** A tab's peek. Mounted only while its hover card is open — mounting IS enabling. */
export function useCmuxPeek(workspaceId: string, tab: CmuxTab) {
  return useQuery({
    queryKey: ["cmux-peek", workspaceId, tab.ref],
    queryFn: () => api.cmuxPeek(workspaceId, tab.ref),
    ...peekQueryOptions(tab.type),
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/api/cmuxPeek.test.tsx && npx tsc -b`
Expected: PASS, no type errors (`tsc -b` is the typecheck half of `npm run build`).

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/types.ts ui/src/api/client.ts ui/src/api/cmuxPeek.ts ui/src/api/cmuxPeek.test.tsx
git commit --signoff -m "feat(ui): cmux peek API client and useCmuxPeek" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Hover card on cmux tab rows

**Files:**
- Create: `ui/src/components/CmuxPeekCard.tsx`
- Modify: `ui/src/components/PaneDiagram.tsx` (`Props`, `PaneDiagram`, `ViewProps`, `PaneBox`, `TabRow`)
- Modify: `ui/src/components/CmuxPanel.tsx:100` (pass `workspaceId`)
- Modify: `ui/src/styles/cmux.css` (terminal pre styling)
- Test: `ui/src/components/CmuxPeekCard.test.tsx` (new), `ui/src/components/PaneDiagram.test.tsx` (wrap + new tests)

**Interfaces:**
- Consumes: Task 3's `useCmuxPeek(workspaceId, tab)`, `api.cmuxPeek`; `useHoverMenu` / `HoverMenu` (`ui/src/lib/useHoverMenu.ts`); `NotesMarkdown` (`ui/src/components/NotesMarkdown.tsx`, `{ text }` with no `onToggleTask` = inert); `useMediaQuery` from `@mantine/hooks`.
- Produces: `export function CmuxPeekCard({ workspaceId, tab }: { workspaceId: string; tab: CmuxTab })`; `PaneDiagram` gains a required `workspaceId: string` prop.

- [ ] **Step 1: Write the failing card tests**

Create `ui/src/components/CmuxPeekCard.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api, HttpError } from "../api/client"
import type { CmuxPeek, CmuxTab } from "../api/types"
import { CmuxPeekCard } from "./CmuxPeekCard"

afterEach(() => vi.restoreAllMocks())

function show(tab: CmuxTab, peek: CmuxPeek | Error) {
  const spy = vi.spyOn(api, "cmuxPeek")
  if (peek instanceof Error) spy.mockRejectedValue(peek)
  else spy.mockResolvedValue(peek)
  const qc = new QueryClient()
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <CmuxPeekCard workspaceId="W" tab={tab} />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

const tab = (type: string, extra: Partial<CmuxTab> = {}): CmuxTab => ({ ref: "surface:1", title: `My ${type}`, type, selected: false, ...extra })

describe("CmuxPeekCard", () => {
  it("shows the title and URL as its header", async () => {
    show(tab("browser", { url: "https://example.com/x" }), { type: "browser", image: "data:image/png;base64,UE5H" })
    expect(screen.getByText("My browser")).toBeInTheDocument()
    expect(screen.getByText("https://example.com/x")).toBeInTheDocument()
  })

  it("renders terminal text in a pre", async () => {
    show(tab("terminal"), { type: "terminal", text: "$ make test\nok" })
    const pre = await screen.findByTestId("cmux-peek-terminal")
    expect(pre.tagName).toBe("PRE")
    expect(pre).toHaveTextContent("$ make test")
  })

  it("renders a browser screenshot", async () => {
    show(tab("browser"), { type: "browser", image: "data:image/png;base64,UE5H" })
    const img = await screen.findByRole("img", { name: "My browser" })
    expect(img).toHaveAttribute("src", "data:image/png;base64,UE5H")
  })

  it("renders markdown with its path", async () => {
    show(tab("markdown"), { type: "markdown", markdown: "# Heading\n\nbody", path: "/tmp/notes.md" })
    expect(await screen.findByRole("heading", { name: "Heading" })).toBeInTheDocument()
    expect(screen.getByText("/tmp/notes.md")).toBeInTheDocument()
  })

  it("says so when there is nothing to peek at", async () => {
    show(tab("simulator"), { type: "simulator", unsupported: true })
    expect(await screen.findByText("No preview for this tab")).toBeInTheDocument()
  })

  it("shows a failed peek's error instead of loading forever", async () => {
    show(tab("terminal"), new HttpError("no such tab", 404))
    expect(await screen.findByText("no such tab")).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && npx vitest run src/components/CmuxPeekCard.test.tsx`
Expected: FAIL — cannot resolve `./CmuxPeekCard`.

- [ ] **Step 3: Implement the card**

Create `ui/src/components/CmuxPeekCard.tsx`:

```tsx
import { Box, Image, Loader, Stack, Text } from "@mantine/core"
import { useLayoutEffect, useRef } from "react"
import { useCmuxPeek } from "../api/cmuxPeek"
import type { CmuxTab } from "../api/types"
import { NotesMarkdown } from "./NotesMarkdown"

/**
 * One cmux tab's hover card: what the old tooltip said (title, URL), then
 * the tab's content. Mounted only while the card is open, so mounting is
 * what starts the fetch (see useCmuxPeek).
 */
export function CmuxPeekCard({ workspaceId, tab }: { workspaceId: string; tab: CmuxTab }) {
  const { data, error } = useCmuxPeek(workspaceId, tab)
  return (
    <Stack gap={6}>
      <Box>
        <Text size="xs" fw={600}>{tab.title}</Text>
        {tab.url && <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>{tab.url}</Text>}
        {data?.path && <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>{data.path}</Text>}
      </Box>
      {error ? (
        <Text size="xs" c="red">{error.message}</Text>
      ) : !data ? (
        <Loader size="xs" />
      ) : data.type === "terminal" && !data.unsupported ? (
        // The server omits an empty screen's text (omitempty): still a terminal.
        <TerminalPeek text={data.text ?? ""} />
      ) : data.image ? (
        <Image src={data.image} alt={tab.title} radius="sm" />
      ) : data.markdown !== undefined && !data.unsupported ? (
        <Box className="cmux-peek-markdown">
          <NotesMarkdown text={data.markdown} />
        </Box>
      ) : (
        <Text size="xs" c="dimmed" fs="italic">No preview for this tab</Text>
      )}
    </Stack>
  )
}

/** Pinned to the bottom on every capture, like a terminal. */
function TerminalPeek({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null)
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text])
  return (
    <pre ref={ref} className="cmux-peek-terminal" data-testid="cmux-peek-terminal">
      {text || " "}
    </pre>
  )
}
```

Append to `ui/src/styles/cmux.css`:

```css
/* cmux tab peek (CmuxPeekCard) */
.cmux-peek-terminal {
  margin: 0;
  padding: 8px;
  max-height: 50vh;
  overflow-y: auto;
  overflow-x: hidden;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: var(--mantine-font-family-monospace);
  font-size: 11px;
  line-height: 1.25;
  background: #000;
  color: #cbd5e1;
  border-radius: var(--mantine-radius-sm);
}

.cmux-peek-markdown {
  max-height: 50vh;
  overflow-y: auto;
}
```

- [ ] **Step 4: Run card tests to verify they pass**

Run: `cd ui && npx vitest run src/components/CmuxPeekCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing PaneDiagram tests**

In `ui/src/components/PaneDiagram.test.tsx`:

1. Add imports: `import { QueryClient, QueryClientProvider } from "@tanstack/react-query"`, `import { api } from "../api/client"`, `import { afterEach } from "vitest"` (merge into the existing vitest import).
2. Replace `wrap`'s render with one that provides a QueryClient and the new prop:

```tsx
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <PaneDiagram workspaceId="W" layout={layout} panes={panes} {...props} />
      </QueryClientProvider>
    </MantineProvider>,
  )
```

3. Add a new `describe` block at the end of the file:

```tsx
describe("PaneDiagram tab peek", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const panes = (): CmuxPane[] => [
    { ref: "pane:1", focused: true, tabs: [t(1, "terminal", true), t(2)] },
    { ref: "pane:2", focused: false, tabs: [] },
  ]

  it("does not fetch until a card opens, then fetches that tab only", async () => {
    const spy = vi.spyOn(api, "cmuxPeek").mockResolvedValue({ type: "terminal", text: "hello from tab 1" })
    wrap(panes())
    expect(spy).not.toHaveBeenCalled()
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Switch to Tab 1" }))
    expect(await screen.findByText("hello from tab 1")).toBeInTheDocument()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith("W", "surface:1")
  })

  it("closes the card when a drag starts", async () => {
    vi.spyOn(api, "cmuxPeek").mockResolvedValue({ type: "terminal", text: "hello from tab 1" })
    wrap(panes())
    const row = screen.getByRole("button", { name: "Switch to Tab 1" })
    fireEvent.mouseEnter(row)
    expect(await screen.findByText("hello from tab 1")).toBeInTheDocument()
    vi.useFakeTimers()
    try {
      act(() => {
        fireEvent.mouseDown(row, { button: 0, clientX: 10, clientY: 10 })
        fireEvent.mouseMove(document, { button: 0, clientX: 10, clientY: 30 })
      })
      expect(screen.queryByText("hello from tab 1")).not.toBeInTheDocument()
      act(() => {
        fireEvent.mouseUp(document, { button: 0, clientX: 10, clientY: 30 })
      })
    } finally {
      act(() => {
        vi.runAllTimers()
      })
    }
  })

  it("shows no card on a device that cannot hover", async () => {
    const orig = window.matchMedia
    window.matchMedia = ((query: string) => ({
      ...orig(query),
      matches: query === "(hover: none)",
    })) as typeof window.matchMedia
    try {
      const spy = vi.spyOn(api, "cmuxPeek").mockResolvedValue({ type: "terminal", text: "hello from tab 1" })
      wrap(panes())
      fireEvent.mouseEnter(screen.getByRole("button", { name: "Switch to Tab 1" }))
      await new Promise((r) => setTimeout(r, 600))
      expect(screen.queryByText("hello from tab 1")).not.toBeInTheDocument()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      window.matchMedia = orig
    }
  })
})
```

(`findByText` waits up to 1000ms by default, which covers the 400ms open delay on real timers.)

- [ ] **Step 6: Run to verify they fail**

Run: `cd ui && npx vitest run src/components/PaneDiagram.test.tsx`
Expected: the three new tests FAIL (no card / `workspaceId` type error); existing tests still pass.

- [ ] **Step 7: Wire the card into `PaneDiagram`**

In `ui/src/components/PaneDiagram.tsx`:

1. Imports: remove `Tooltip` from the `@mantine/core` import (TabRow is its only user), and add:

```tsx
import { useMediaQuery } from "@mantine/hooks"
import { useHoverMenu, type HoverMenu } from "../lib/useHoverMenu"
import { CmuxPeekCard } from "./CmuxPeekCard"
```

2. `Props`: add

```tsx
  /** The cmux workspace these panes belong to — what the hover peek asks for. */
  workspaceId: string
```

3. `ViewProps`: add

```tsx
  workspaceId: string
  /** null on devices that cannot hover: no peek card at all. */
  menuFor: ((ref: string) => HoverMenu) | null
```

4. In `PaneDiagram`, destructure `workspaceId`, and after the `drag` state:

```tsx
  // One peek card open at a time across the whole diagram, closed while a
  // tab is being dragged so it never floats over the drop targets.
  const hoverMenuFor = useHoverMenu({ openDelay: 400, closeDelay: 300, disabled: drag.activeRef !== null })
  // Desktop only: a touch device has no hover, and a long-press is a drag.
  const canHover = !useMediaQuery("(hover: none)")
  const menuFor = canHover ? hoverMenuFor : null
```

and pass `workspaceId={workspaceId}` and `menuFor={menuFor}` to `<LayoutView … />`.

5. `PaneBox`: add `workspaceId, menuFor` to its destructured props, and pass them to each `<TabRow … />`:

```tsx
        workspaceId={workspaceId}
        menu={menuFor ? menuFor(tab.ref) : null}
```

6. `TabRow`: change its signature to

```tsx
function TabRow({ tab, dropBefore, onSelect, onClose, workspaceId, menu }: Handlers & {
  tab: CmuxTab
  dropBefore: boolean
  workspaceId: string
  menu: HoverMenu | null
}) {
```

and replace the whole `<Tooltip …>…</Tooltip>` element with:

```tsx
      <Popover
        opened={menu?.opened ?? false}
        onClose={menu?.close}
        position="right-start"
        shadow="md"
        width={720}
        // Small, so the pointer crosses little no-man's-land on its way into
        // the card; useHoverMenu's close delay is the grace period for it.
        offset={4}
        disabled={!menu}
      >
        <Popover.Target>
          <UnstyledButton
            aria-label={`Switch to ${tab.title}${tab.unread ? " (unread)" : ""}`}
            onClick={() => onSelect(tab)}
            onMouseEnter={menu?.onTargetEnter}
            onMouseLeave={menu?.onLeave}
            style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4, padding: "1px 4px" }}
          >
            <Icon size={12} style={{ flex: "none" }} color={tab.selected ? "var(--mantine-color-blue-filled)" : "var(--mantine-color-dimmed)"} />
            <Text size="xs" truncate fw={tab.selected ? 700 : 400} data-selected={tab.selected || undefined}>
              {tab.title}
            </Text>
            {tab.unread && <UnreadDot />}
          </UnstyledButton>
        </Popover.Target>
        <Popover.Dropdown
          p="xs"
          style={{ maxWidth: "90vw" }}
          onMouseEnter={menu?.onDropdownEnter}
          onMouseLeave={menu?.onLeave}
        >
          <CmuxPeekCard workspaceId={workspaceId} tab={tab} />
        </Popover.Dropdown>
      </Popover>
```

(Mantine's `Popover.Dropdown` is unmounted while closed — `keepMounted` defaults to false — so `CmuxPeekCard`, and its fetch, exist only while the card is open. Keep the existing explanatory comment about cmux's embedded browser not showing native `title` tooltips, reworded to say the peek card's header carries the title and URL.)

7. In `ui/src/components/CmuxPanel.tsx`, pass the workspace id:

```tsx
        <PaneDiagram
          workspaceId={ws.id}
          layout={ws.layout}
```

- [ ] **Step 8: Run all UI tests, typecheck and lint**

Run: `cd ui && npx vitest run && npm run build && npx eslint src/components/PaneDiagram.tsx src/components/CmuxPeekCard.tsx src/api/cmuxPeek.ts`
Expected: all PASS, no type or lint errors.

- [ ] **Step 9: Commit**

```bash
git add ui/src/components/CmuxPeekCard.tsx ui/src/components/CmuxPeekCard.test.tsx ui/src/components/PaneDiagram.tsx ui/src/components/PaneDiagram.test.tsx ui/src/components/CmuxPanel.tsx ui/src/styles/cmux.css
git commit --signoff -m "feat(ui): peek at a cmux tab by hovering it in the cmux tab" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docs and a real-cmux check

**Files:**
- Modify: `docs/web-ui-architecture.md` (inside `### The details card's cmux tab` section, ~line 1739, before `## Known deferred items`)
- Modify: `CLAUDE.md` (the `cmux` bullet under "Project Structure")
- Modify: `docs/superpowers/specs/2026-10-13-cmux-tab-peek-design.md` (Status line)

**Interfaces:**
- Consumes: everything above.
- Produces: documentation only.

- [ ] **Step 1: Add the architecture doc section**

Add a `#### Tab peek (`GET /api/cmux/peek`, `cmux/peek.go`, `CmuxPeekCard`)` subsection to the cmux tab section of `docs/web-ui-architecture.md` covering, in prose:

- Hovering a tab row (desktop only — `(hover: none)` disables it) opens a Popover driven by `useHoverMenu` (400ms open, 300ms close, one at a time, disabled during a drag). Its dropdown mounts `CmuxPeekCard`, so mounting is fetching.
- The route reads the tab's type from `cmux tree` (never the client), 404s a surface not in that workspace, 503s when cmux is not running and 502s cmux failures — a data GET, unlike the cmux tab's POST actions which answer 200 `ok:false`.
- Per type: terminal = `read-screen --scrollback --lines 200`, refetched every 5s while open; browser = `browser --surface S screenshot --out <file>` (~1.3s, ~200KB), once per open; markdown = `read-selection --json` → `file_path`, read server-side only if absolute, `.md`/`.markdown`, regular, ≤ 512 KiB, once per open; anything else is `unsupported`.
- Screenshot files: `$TMPDIR/worktree-cmux-peek/<surface>.png`, removed before and after each screenshot under a per-surface mutex; `worktree ui` removes the dir at startup.
- cmux facts learned (0.65.0): `read-screen` refuses non-terminal surfaces ("Surface is not a terminal"); `read-selection` returns `file_path` for a markdown surface even with no selection — undocumented, so its absence degrades to `unsupported`; no other command (`tree`, `list-pane-surfaces`, `surface-health`) exposes a markdown tab's path; all three peek commands work on unselected tabs in unfocused workspaces without moving focus.

- [ ] **Step 2: Update CLAUDE.md**

In `CLAUDE.md`'s `cmux` package bullet, append one sentence: "`peek.go` reads a tab for the cmux tab's hover peek (`ReadScreen`, `Screenshot`, `MarkdownPath`); screenshots are temp files that never outlive their request — see `docs/web-ui-architecture.md` "Tab peek"."

- [ ] **Step 3: Mark the spec implemented**

Change the spec's `Status:` line to `Status: implemented`.

- [ ] **Step 4: Full verification**

Run: `make test && make build`
Expected: PASS and a built `bin/worktree`.

Then a real-cmux smoke test of the package functions. Do NOT start a second `worktree ui` for this: it would also run the notifier and the unread-title sync against the real DB and could double-notify Mike. Instead:

1. Pick one terminal, one NON-selected browser and one markdown surface from a single workspace in `cmux tree --json` (read-only).
2. Write a TEMPORARY, uncommitted `internal/cmux/peek_live_test.go`:

```go
package cmux

import (
	"os"
	"strings"
	"testing"
)

func TestPeekLive(t *testing.T) {
	ws := os.Getenv("CMUX_PEEK_WS")
	if ws == "" {
		t.Skip("set CMUX_PEEK_WS, CMUX_PEEK_TERM, CMUX_PEEK_BROWSER, CMUX_PEEK_MD")
	}
	text, err := ReadScreen(ws, os.Getenv("CMUX_PEEK_TERM"), 200)
	if err != nil || text == "" {
		t.Fatalf("terminal: %q %v", text, err)
	}
	png, err := Screenshot(os.Getenv("CMUX_PEEK_BROWSER"))
	if err != nil || !strings.HasPrefix(string(png), "\x89PNG") {
		t.Fatalf("browser: %d bytes %v", len(png), err)
	}
	if entries, _ := os.ReadDir(peekDir()); len(entries) != 0 {
		t.Fatalf("screenshot files left behind: %v", entries)
	}
	path, err := MarkdownPath(ws, os.Getenv("CMUX_PEEK_MD"))
	if err != nil || !strings.HasSuffix(path, ".md") {
		t.Fatalf("markdown: %q %v", path, err)
	}
}
```

3. Run `cmux identify --no-caller` (note the focused surface), then `CMUX_PEEK_WS=… CMUX_PEEK_TERM=… CMUX_PEEK_BROWSER=… CMUX_PEEK_MD=… go test ./internal/cmux/ -run TestPeekLive -v`, then `cmux identify --no-caller` again — the focused surface must be unchanged.
4. Delete `internal/cmux/peek_live_test.go`. Report the results; Mike checks the UI itself after `make install`.

- [ ] **Step 5: Commit**

```bash
git add docs/web-ui-architecture.md CLAUDE.md docs/superpowers/specs/2026-10-13-cmux-tab-peek-design.md
git commit --signoff -m "docs: cmux tab peek" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
