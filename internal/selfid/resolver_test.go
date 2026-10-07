package selfid

import (
	"context"
	"errors"
	"testing"
)

func TestResolveOnceStoresAndCountsPending(t *testing.T) {
	conn := testDB(t)
	fail := true
	r := &Resolver{DB: conn, Lookups: map[string]Lookup{
		"github": func(context.Context) (string, error) { return "101", nil },
		"jira": func(context.Context) (string, error) {
			if fail {
				return "", errors.New("down")
			}
			return "acc-me", nil
		},
	}}
	if pending := r.ResolveOnce(context.Background()); pending != 1 {
		t.Fatalf("pending = %d, want 1 (jira failed)", pending)
	}
	ids, _ := Load(conn)
	if ids["github"] != "101" || ids["jira"] != "" {
		t.Fatalf("after first pass: %v", ids)
	}
	fail = false
	if pending := r.ResolveOnce(context.Background()); pending != 0 {
		t.Fatalf("pending = %d, want 0", pending)
	}
	ids, _ = Load(conn)
	if ids["jira"] != "acc-me" {
		t.Fatalf("after retry: %v", ids)
	}
}

func TestResolveOnceKeepsOldRowOnFailure(t *testing.T) {
	conn := testDB(t)
	Set(conn, "slack", "U1")
	r := &Resolver{DB: conn, Lookups: map[string]Lookup{
		"slack": func(context.Context) (string, error) { return "", errors.New("expired") },
	}}
	r.ResolveOnce(context.Background())
	if ids, _ := Load(conn); ids["slack"] != "U1" {
		t.Fatalf("a failed lookup must keep the stored ID, got %v", ids)
	}
}
