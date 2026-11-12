package jiratest

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/mturley/worktree/internal/config"
)

// WriteWatcherAuth points XDG_CONFIG_HOME at a temp dir holding worktree's
// watcher-auth.yaml with Jira configured on host, so tests can build issue
// URLs without reading the real user config.
func WriteWatcherAuth(t *testing.T, host string) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	path := config.WatcherAuthPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	body := "services:\n  jira:\n    host: " + host + "\n    email: me@example.com\n    token: tok\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}
