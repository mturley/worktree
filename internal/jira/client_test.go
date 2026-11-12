package jira

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/jira/jiratest"
)

func TestNewClientRequiresHostAndEmail(t *testing.T) {
	if _, err := NewClient("", "me@example.com", "tok"); err == nil {
		t.Fatal("expected error when host is empty")
	}
	if _, err := NewClient("example.atlassian.net", "", "tok"); err == nil {
		t.Fatal("expected error when email is empty")
	}
}

func TestNewClientRequiresToken(t *testing.T) {
	if _, err := NewClient("example.atlassian.net", "me@example.com", ""); err == nil {
		t.Fatal("expected error when token is empty")
	}
}

func TestNewClientSucceedsWithCreds(t *testing.T) {
	c, err := NewClient("example.atlassian.net", "me@example.com", "tok")
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if c == nil {
		t.Fatal("expected non-nil client")
	}
}

func TestIssueURL(t *testing.T) {
	tests := []struct {
		name string
		host string
		want string
	}{
		{"bare host", "example.atlassian.net", "https://example.atlassian.net/browse/PROJ-1"},
		{"host with scheme", "https://example.atlassian.net", "https://example.atlassian.net/browse/PROJ-1"},
		{"host with http scheme", "http://jira.internal", "http://jira.internal/browse/PROJ-1"},
		{"host with trailing slash", "https://example.atlassian.net/", "https://example.atlassian.net/browse/PROJ-1"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IssueURL(tt.host, "PROJ-1"); got != tt.want {
				t.Errorf("IssueURL(%q) = %q, want %q", tt.host, got, tt.want)
			}
		})
	}
}

func TestClientBaseURLNormalizesScheme(t *testing.T) {
	c, err := NewClient("https://example.atlassian.net/", "me@example.com", "tok")
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if got, want := c.baseURL(), "https://example.atlassian.net"; got != want {
		t.Errorf("baseURL() = %q, want %q", got, want)
	}
}

func TestConfiguredCustomFields(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if got := ConfiguredCustomFields(); got == nil || len(got) != 0 {
		t.Fatalf("no config.yaml: got %v, want an empty non-nil map", got)
	}

	path := config.ConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	body := "jira:\n  projects: [PROJ]\n  custom_fields:\n    git_pull_request: customfield_2\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := ConfiguredCustomFields(); len(got) != 1 || got["git_pull_request"] != "customfield_2" {
		t.Fatalf("got %v, want git_pull_request from worktree's config.yaml", got)
	}
}

func TestConfiguredIssueURL(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if got := ConfiguredIssueURL("ABC-1"); got != "" {
		t.Fatalf("no Jira configured: got %q, want empty", got)
	}

	jiratest.WriteWatcherAuth(t, "x.atlassian.net")
	if got, want := ConfiguredIssueURL("ABC-1"), "https://x.atlassian.net/browse/ABC-1"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
