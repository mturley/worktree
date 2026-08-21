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
