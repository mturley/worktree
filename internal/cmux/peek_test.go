package cmux

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
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

// assertEmptyDir fails unless dir holds no files (a missing dir counts as empty).
func assertEmptyDir(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("files left in %s: %v", dir, entries)
	}
}

func TestScreenshotLeavesNoFile(t *testing.T) {
	dir := usePeekDir(t)
	got := stubCmuxScript(t, writeOut+`printf NEW > "$out"`)
	png, err := Screenshot("surface:7")
	if err != nil {
		t.Fatal(err)
	}
	args := *got
	if len(args) != 6 || !reflect.DeepEqual(args[:5], []string{"browser", "--surface", "surface:7", "screenshot", "--out"}) {
		t.Fatalf("args = %q", args)
	}
	if out := args[5]; filepath.Dir(out) != dir || filepath.Ext(out) != ".png" {
		t.Fatalf("--out %q, want a .png in %s", out, dir)
	}
	if string(png) != "NEW" {
		t.Fatalf("bytes = %q", png)
	}
	assertEmptyDir(t, dir)
	if info, err := os.Stat(dir); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("peek dir stat = %v err = %v, want mode 0700", info, err)
	}
}

func TestScreenshotRemovesFileOnFailure(t *testing.T) {
	dir := usePeekDir(t)
	stubCmuxScript(t, writeOut+`printf PARTIAL > "$out"; echo boom >&2; exit 1`)
	if _, err := Screenshot("surface:7"); err == nil {
		t.Fatal("want error when cmux fails")
	}
	assertEmptyDir(t, dir)
}

// Overlapping screenshots of one tab — two hovers, or two `worktree ui`
// processes sharing the directory — each get their own file, so neither can
// delete or read the other's.
func TestConcurrentScreenshotsUseSeparateFiles(t *testing.T) {
	dir := usePeekDir(t)
	// Each screenshot's content is its own path; the sleep makes them overlap.
	stubCmuxScript(t, writeOut+`printf '%s' "$out" > "$out"; sleep 0.1`)
	const n = 3
	paths := make(chan string, n)
	var wg sync.WaitGroup
	for range n {
		wg.Go(func() {
			png, err := Screenshot("surface:9")
			if err != nil {
				t.Error(err)
				return
			}
			paths <- string(png)
		})
	}
	wg.Wait()
	close(paths)
	seen := map[string]bool{}
	for p := range paths {
		seen[p] = true
	}
	if len(seen) != n {
		t.Fatalf("got %d distinct screenshot files for %d screenshots: %v", len(seen), n, seen)
	}
	assertEmptyDir(t, dir)
}

// A wedged cmux (e.g. a hung webview) must fail the peek, not block it.
func TestPeekCommandsTimeOut(t *testing.T) {
	usePeekDir(t)
	orig := peekTimeout
	peekTimeout = 100 * time.Millisecond
	t.Cleanup(func() { peekTimeout = orig })
	stubCmuxScript(t, `exec sleep 5`)
	for name, run := range map[string]func() error{
		"read-screen":    func() error { _, err := ReadScreen("W", "surface:1", 200); return err },
		"read-selection": func() error { _, err := MarkdownPath("W", "surface:1"); return err },
		"screenshot":     func() error { _, err := Screenshot("surface:1"); return err },
	} {
		start := time.Now()
		err := run()
		if err == nil || !strings.Contains(err.Error(), "timed out") {
			t.Errorf("%s: err = %v, want a timeout", name, err)
		}
		if elapsed := time.Since(start); elapsed > 2*time.Second {
			t.Errorf("%s: took %v, want it cut off near the timeout", name, elapsed)
		}
	}
}

// The startup sweep removes leftovers a crash abandoned, but never a fresh
// file another running `worktree ui` may be mid-screenshot on.
func TestClearPeekScreenshotsKeepsFreshFiles(t *testing.T) {
	dir := usePeekDir(t)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dir, "stale.png")
	fresh := filepath.Join(dir, "fresh.png")
	for _, p := range []string{stale, fresh} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-2 * peekStaleAfter)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	ClearPeekScreenshots()
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale screenshot survived the sweep (stat err = %v)", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("fresh screenshot removed by the sweep: %v", err)
	}
}

func TestClearPeekScreenshotsWithoutDir(t *testing.T) {
	usePeekDir(t)
	ClearPeekScreenshots() // must not panic or create anything
}
