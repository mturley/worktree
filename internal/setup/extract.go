// internal/setup/extract.go
package setup

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// extractScript is the exact contents of a proven, standalone Node script
// that drives a headed Chromium (via Playwright) to log into Slack and pull
// out the browser session's xoxc- token and xoxd- "d" cookie. It is embedded
// so the Go binary can write it out and run it with plain `node`, without
// worktree depending on Node or Playwright at build time. Ported from
// slack-mini's internal/cli/extract.go/.mjs.
//
//go:embed extract.mjs
var extractScript string

// autoExtractor runs the automatic, browser-driven credential extraction. It
// is a package var so tests can substitute a fake without launching a real
// browser or installing anything.
var autoExtractor = runAutoExtract

// cacheDir returns the directory worktree uses for cached, transient runtime
// state related to Slack credential extraction (the Playwright/Node install
// and browser profile). It honors XDG_CACHE_HOME, falling back to
// ~/.cache/worktree.
func cacheDir() (string, error) {
	base := os.Getenv("XDG_CACHE_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".cache")
	}
	return filepath.Join(base, "worktree"), nil
}

// autoExtractAvailable reports whether automatic extraction can be attempted
// at all: it requires both node and npx on PATH. It does not check whether
// Playwright itself is installed yet (runAutoExtract installs it on demand).
func autoExtractAvailable() bool {
	if _, err := exec.LookPath("node"); err != nil {
		return false
	}
	if _, err := exec.LookPath("npx"); err != nil {
		return false
	}
	return true
}

// runAutoExtract orchestrates automatic credential extraction: it ensures a
// cache directory exists, installs Playwright + Chromium into it on first
// use (a transient, user-triggered install — never a project dependency),
// writes out the embedded extraction script, runs it with node, and parses
// its result. Progress and any login prompts from the child process are
// streamed to stderr so the interactive user can see and act on them.
func runAutoExtract() (token, cookie string, err error) {
	dir, err := cacheDir()
	if err != nil {
		return "", "", fmt.Errorf("could not determine cache directory: %w", err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", fmt.Errorf("could not create cache directory %s: %w", dir, err)
	}

	if _, statErr := os.Stat(filepath.Join(dir, "node_modules", "playwright")); os.IsNotExist(statErr) {
		fmt.Fprintln(os.Stderr, "Downloading Playwright + Chromium (one-time)...")
		if err := installPlaywright(dir); err != nil {
			return "", "", err
		}
	}

	scriptPath := filepath.Join(dir, "extract.mjs")
	if err := os.WriteFile(scriptPath, []byte(extractScript), 0o600); err != nil {
		return "", "", fmt.Errorf("could not write extraction script: %w", err)
	}

	cmd := exec.Command("node", "extract.mjs")
	cmd.Dir = dir
	cmd.Stderr = os.Stderr
	var stdoutBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf

	if err := runWithTimeout(cmd, 6*time.Minute); err != nil {
		return "", "", fmt.Errorf("extraction script failed: %w", err)
	}

	return parseExtractOutput(stdoutBuf.String())
}

// installPlaywright installs Playwright and its Chromium browser into dir,
// a transient cache directory (never worktree's own go.mod/package.json).
// It initializes a throwaway package.json if one doesn't already exist so
// `npm install` has somewhere to record the dependency. All child output is
// streamed to stderr so the user can watch progress on what can be a
// multi-minute download.
func installPlaywright(dir string) error {
	if _, err := os.Stat(filepath.Join(dir, "package.json")); os.IsNotExist(err) {
		if err := runStreamed(dir, "npm", "init", "-y"); err != nil {
			return fmt.Errorf("npm init failed: %w", err)
		}
	}
	if err := runStreamed(dir, "npm", "install", "playwright"); err != nil {
		return fmt.Errorf("npm install playwright failed: %w", err)
	}
	if err := runStreamed(dir, "npx", "playwright", "install", "chromium"); err != nil {
		return fmt.Errorf("playwright install chromium failed: %w", err)
	}
	return nil
}

// runStreamed runs name with args in dir, streaming its combined stdout and
// stderr to our stderr so the user sees install progress live.
func runStreamed(dir, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// runWithTimeout starts cmd and waits for it, killing the process if it
// doesn't complete within timeout. Used for the interactive extraction step,
// which needs a generous ceiling to give the user time to log in.
func runWithTimeout(cmd *exec.Cmd, timeout time.Duration) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		<-done
		return fmt.Errorf("timed out after %s", timeout)
	}
}

// extractResult mirrors the single JSON line printed to stdout by
// extract.mjs on completion.
type extractResult struct {
	OK     bool   `json:"ok"`
	Token  string `json:"token"`
	Cookie string `json:"cookie"`
	Error  string `json:"error"`
}

// parseExtractOutput parses the extraction script's stdout, which may
// contain blank lines or (in principle) other chatter, but ends with a
// single JSON line describing the result. It returns the token and cookie on
// success, or an error describing what went wrong (including the script's
// own reported error message) otherwise.
func parseExtractOutput(stdout string) (token, cookie string, err error) {
	var lastLine string
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			lastLine = line
		}
	}
	if lastLine == "" {
		return "", "", fmt.Errorf("extraction script produced no output")
	}

	var res extractResult
	if err := json.Unmarshal([]byte(lastLine), &res); err != nil {
		return "", "", fmt.Errorf("could not parse extraction script output: %w", err)
	}
	if !res.OK {
		msg := res.Error
		if msg == "" {
			msg = "unknown error"
		}
		return "", "", fmt.Errorf("%s", msg)
	}
	if res.Token == "" || res.Cookie == "" {
		return "", "", fmt.Errorf("extraction script reported success but token or cookie was empty")
	}
	return res.Token, res.Cookie, nil
}
