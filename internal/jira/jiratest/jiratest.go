package jiratest

import (
	"os"
	"path/filepath"
	"testing"
)

// WriteWatcherAuth points WATCHER_HOME at a temp dir holding an auth.yaml
// with Jira configured on host, so tests can build issue URLs without
// reading the real user config.
func WriteWatcherAuth(t *testing.T, host string) {
	t.Helper()
	dir := t.TempDir()
	body := "services:\n  jira:\n    host: " + host + "\n    email: me@example.com\n    token: tok\n"
	if err := os.WriteFile(filepath.Join(dir, "auth.yaml"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WATCHER_HOME", dir)
}
