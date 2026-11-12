package webui

import (
	"os"
	"path/filepath"
	"testing"

	wconfig "github.com/mturley/watcher/config"

	"github.com/mturley/worktree/internal/config"
)

// Serial: sets the loadLinkedCreds package var.
func TestLinkedSourcesNeverReadsDisabledServicesCredentials(t *testing.T) {
	authPath := filepath.Join(t.TempDir(), "watcher-auth.yaml")
	auth := "services:\n  github:\n    token: ghtok\n  jira:\n    host: example.atlassian.net\n    email: a@b.c\n    token: jtok\n"
	if err := os.WriteFile(authPath, []byte(auth), 0o600); err != nil {
		t.Fatal(err)
	}
	calls := 0
	orig := loadLinkedCreds
	loadLinkedCreds = func(p string) (*wconfig.Config, error) { calls++; return orig(p) }
	t.Cleanup(func() { loadLinkedCreds = orig })

	srv := func(off ...string) *Server {
		s := &Server{WatcherAuthPath: authPath}
		m := map[string]bool{}
		for _, svc := range off {
			m[svc] = true
		}
		s.SetWatchersDisabled(m)
		return s
	}

	src := srv().linkedSources()
	if src.PR == nil || src.Jira == nil {
		t.Fatalf("both on: PR=%v Jira=%v, want both", src.PR, src.Jira)
	}
	src = srv(config.ServiceJira).linkedSources()
	if src.PR == nil || src.Jira != nil || src.JiraState != nil {
		t.Fatalf("jira off: PR=%v Jira=%v", src.PR, src.Jira)
	}
	src = srv(config.ServiceGitHub).linkedSources()
	if src.PR != nil || src.Jira == nil {
		t.Fatalf("github off: PR=%v Jira=%v", src.PR, src.Jira)
	}
	calls = 0
	src = srv(config.ServiceGitHub, config.ServiceJira).linkedSources()
	if src.PR != nil || src.Jira != nil || calls != 0 {
		t.Fatalf("both off: PR=%v Jira=%v, watcher-auth.yaml loaded %d times", src.PR, src.Jira, calls)
	}
}
