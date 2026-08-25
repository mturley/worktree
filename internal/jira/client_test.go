package jira

import "testing"

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
