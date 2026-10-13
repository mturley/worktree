package cmux

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The cmux tab's hover peek (internal/webui handleCmuxPeek). Verified
// against cmux 0.65.0: all three commands work on tabs that are not selected
// and in workspaces that are not focused, and none of them moves focus.

// peekTimeout bounds every peek command: a wedged cmux (say, a hung webview
// asked for a screenshot) must fail the hover, not block it — and a stuck
// screenshot would hold its surface's lock for every later hover too.
// A var so tests can shorten it.
var peekTimeout = 10 * time.Second

// cmuxOutput runs one peek command and returns its stdout, folding stderr
// into the error, and kills it after peekTimeout.
func cmuxOutput(what string, args ...string) ([]byte, error) {
	cmd := cmuxCmd(args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	// After the kill, stop waiting on output pipes a child process may
	// still hold open.
	cmd.WaitDelay = time.Second
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("%s: %w", what, err)
	}
	timer := time.AfterFunc(peekTimeout, func() { _ = cmd.Process.Kill() })
	err := cmd.Wait()
	if !timer.Stop() {
		return nil, fmt.Errorf("%s: timed out after %s", what, peekTimeout)
	}
	if err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return nil, fmt.Errorf("%s: %s", what, msg)
		}
		return nil, fmt.Errorf("%s: %w", what, err)
	}
	return stdout.Bytes(), nil
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
	if _, err := cmuxOutput("taking screenshot", "browser", "--surface", surfaceRef, "screenshot", "--out", path); err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}

// ClearPeekScreenshots removes the screenshot dir, catching anything a crash
// left between a screenshot and its cleanup. Run at `worktree ui` startup.
func ClearPeekScreenshots() {
	_ = os.RemoveAll(peekDir())
}
