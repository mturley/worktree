package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	watcherdb "github.com/mturley/watcher/db"
	"github.com/mturley/worktree/internal/notifyprefs"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/tasks"
	"github.com/mturley/worktree/internal/unread"
)

// TestHoldKeepsResourcePolledButUnfollowed: a resource only a task blocker
// holds (subscriber task:<id>) is polled, but nothing that means "followed
// by a worktree" counts it.
func TestHoldKeepsResourcePolledButUnfollowed(t *testing.T) {
	t.Parallel()
	s, wt := tasksServer(t)
	conn := s.DB
	// The worktree follows #2 only. #1 was followed once, by the same
	// worktree, then dropped: its tombstone and its read cursor remain, the
	// worst case for an "archived" fallback and for unread.
	must(t, resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u2"}))
	must(t, resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}))
	must(t, unread.EnsureCursor(conn, "pr", "o/r#1"))
	must(t, resources.Remove(conn, wt, "pr", "o/r#1"))

	prLink := tasks.LinkTarget{Kind: tasks.LinkResource, ResourceType: "pr", ResourceID: "o/r#1"}
	linked, err := tasks.Create(conn, webUser, tasks.NewTask{Title: "linked", Focus: []tasks.LinkTarget{prLink}})
	must(t, err)
	blocked, err := tasks.Create(conn, webUser, tasks.NewTask{Title: "blocked"})
	must(t, err)
	_, err = tasks.AddBlocker(conn, webUser, blocked.ID, tasks.BlockerTarget{Kind: tasks.BlockerResource, ResourceType: "pr", ResourceID: "o/r#1"})
	must(t, err)

	// An unread event on the held PR (newer than its cursor).
	insertEvent(t, conn, "held", time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		"github", "pr_comment", "held comment", "pr", "o/r#1", "u1")

	// Polled: the hold is a live subscription.
	prs, err := watcherdb.ActiveResources(conn, "pr")
	must(t, err)
	polled := false
	for _, r := range prs {
		polled = polled || r.ID == "o/r#1"
	}
	if !polled {
		t.Fatalf("held PR not polled: %+v", prs)
	}

	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	getJSON := func(path string, into any) {
		t.Helper()
		resp, err := http.Get(ts.URL + path)
		must(t, err)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s: %d", path, resp.StatusCode)
		}
		must(t, json.NewDecoder(resp.Body).Decode(into))
	}

	var all []map[string]any
	getJSON("/api/all-resources", &all)
	for _, r := range all {
		if r["id"] == "o/r#1" {
			t.Errorf("all-resources lists the held PR: %+v", r)
		}
	}

	var wres []resourceDTO
	getJSON("/api/worktree-resources?path="+url.QueryEscape(wt), &wres)
	if len(wres) != 1 || wres[0].ID != "o/r#2" {
		t.Errorf("worktree-resources = %+v, want only o/r#2", wres)
	}

	var wts []worktreeSummary
	getJSON("/api/worktrees", &wts)
	if len(wts) != 1 || wts[0].ResourceCount != 1 || wts[0].HasUnread || wts[0].UnreadCount != 0 {
		t.Errorf("worktrees = %+v, want 1 resource and nothing unread", wts)
	}

	timeline := func(q string) []TimelineEvent {
		var body struct {
			Events []TimelineEvent `json:"events"`
		}
		getJSON("/api/timeline?limit=50&"+q, &body)
		return body.Events
	}
	for _, q := range []string{"archived=false", "archived=false&unread_only=true"} {
		for _, e := range timeline(q) {
			if e.ID == "held" {
				t.Errorf("home timeline (%s) shows the held PR's event", q)
			}
		}
	}
	found := false
	for _, e := range timeline("archived=true") {
		if e.ID == "held" {
			found = true
			if len(e.Worktrees) != 0 {
				t.Errorf("held event attributed to worktrees %v", e.Worktrees)
			}
		}
	}
	if !found {
		t.Error("archived timeline should still show the held PR's event")
	}

	got, err := tasks.Get(conn, linked.ID)
	must(t, err)
	if len(got.Links) != 1 || !got.Links[0].Archived || !got.Archived || len(got.Implicit) != 0 {
		t.Errorf("link to a held-only PR must be archived with no implicit worktree: %+v", got)
	}

	must(t, notifyprefs.SetAll(conn, wt, true))
	batches, err := s.notifyBatches([]newEvent{{id: "held", ts: "1", title: "hi", resType: "pr", resID: "o/r#1"}})
	must(t, err)
	if len(batches) != 0 {
		t.Errorf("held PR notified: %+v", batches)
	}
}
