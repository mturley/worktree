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
		t.Fatalf("peek dir stat = %v err = %v, want mode 0700", info, err)
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
	// The sleep runs inside cmuxCmd, i.e. while Screenshot holds its lock,
	// so overlapping callers would push maxRunning above 1 without it.
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

// A wedged cmux (e.g. a hung webview) must fail the peek, not block it — a
// stuck screenshot would otherwise hold its surface's lock forever.
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
