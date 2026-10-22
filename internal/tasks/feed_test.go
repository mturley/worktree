package tasks

import (
	"database/sql"
	"testing"
)

// feedEvent inserts a task_events row with an exact ts.
func feedEvent(t *testing.T, conn *sql.DB, taskID int64, ts, actor string) int64 {
	t.Helper()
	res, err := conn.Exec(
		`INSERT INTO task_events (task_id, ts, type, actor, actor_session, payload)
		 VALUES (?, ?, 'task_edited', ?, '', '{}')`, taskID, ts, actor)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	return id
}

// clearEvents drops the events Create wrote so tests control every row.
func clearEvents(t *testing.T, conn *sql.DB) {
	t.Helper()
	if _, err := conn.Exec(`DELETE FROM task_events`); err != nil {
		t.Fatal(err)
	}
}

func feedIDs(evs []FeedEvent) []int64 {
	out := []int64{}
	for _, e := range evs {
		out = append(out, e.ID)
	}
	return out
}

func TestFeedEventsOrderAndBefore(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "alpha")
	clearEvents(t, conn)
	a := feedEvent(t, conn, tk.ID, "2026-01-01T00:00:01Z", "user")
	b := feedEvent(t, conn, tk.ID, "2026-01-01T00:00:02Z", "agent")
	c := feedEvent(t, conn, tk.ID, "2026-01-01T00:00:02Z", "agent") // same ts, higher id
	d := feedEvent(t, conn, tk.ID, "2026-01-01T00:00:03Z", "user")

	evs, err := FeedEvents(conn, FeedQuery{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if !equalIDs(feedIDs(evs), []int64{d, c, b, a}) {
		t.Fatalf("order %v", feedIDs(evs))
	}
	if evs[0].TaskTitle != "alpha" {
		t.Fatalf("title %q", evs[0].TaskTitle)
	}
	evs, _ = FeedEvents(conn, FeedQuery{Limit: 2})
	if !equalIDs(feedIDs(evs), []int64{d, c}) {
		t.Fatalf("limit %v", feedIDs(evs))
	}
	// Before is exclusive on ts: both ts=...02 rows drop out.
	evs, _ = FeedEvents(conn, FeedQuery{Before: "2026-01-01T00:00:02Z", Limit: 10})
	if !equalIDs(feedIDs(evs), []int64{a}) {
		t.Fatalf("before %v", feedIDs(evs))
	}
	evs, _ = FeedEvents(conn, FeedQuery{SinceTS: "2026-01-01T00:00:02Z", Limit: 10})
	if !equalIDs(feedIDs(evs), []int64{d, c, b}) {
		t.Fatalf("since %v", feedIDs(evs))
	}
}

func TestFeedEventsTaskIDsNilVsEmpty(t *testing.T) {
	conn := newDB(t)
	t1 := mustCreate(t, conn, "one")
	t2 := mustCreate(t, conn, "two")
	clearEvents(t, conn)
	e1 := feedEvent(t, conn, t1.ID, "2026-01-01T00:00:01Z", "agent")
	e2 := feedEvent(t, conn, t2.ID, "2026-01-01T00:00:02Z", "agent")

	evs, _ := FeedEvents(conn, FeedQuery{Limit: 10})
	if !equalIDs(feedIDs(evs), []int64{e2, e1}) {
		t.Fatalf("nil %v", feedIDs(evs))
	}
	evs, _ = FeedEvents(conn, FeedQuery{TaskIDs: []int64{}, Limit: 10})
	if len(evs) != 0 {
		t.Fatalf("empty %v", feedIDs(evs))
	}
	evs, _ = FeedEvents(conn, FeedQuery{TaskIDs: []int64{t1.ID}, Limit: 10})
	if !equalIDs(feedIDs(evs), []int64{e1}) {
		t.Fatalf("one %v", feedIDs(evs))
	}
}

func TestFeedEventsAgentOnlyAndDeleted(t *testing.T) {
	conn := newDB(t)
	t1 := mustCreate(t, conn, "one")
	t2 := mustCreate(t, conn, "two")
	clearEvents(t, conn)
	feedEvent(t, conn, t1.ID, "2026-01-01T00:00:01Z", "user")
	ag := feedEvent(t, conn, t1.ID, "2026-01-01T00:00:02Z", "agent")
	feedEvent(t, conn, t2.ID, "2026-01-01T00:00:03Z", "agent")

	evs, _ := FeedEvents(conn, FeedQuery{AgentOnly: true, Limit: 10})
	if len(evs) != 2 {
		t.Fatalf("agent only %v", feedIDs(evs))
	}
	if _, err := Delete(conn, user, t2.ID); err != nil {
		t.Fatal(err)
	}
	evs, _ = FeedEvents(conn, FeedQuery{AgentOnly: true, Limit: 10})
	if !equalIDs(feedIDs(evs), []int64{ag}) {
		t.Fatalf("deleted task leaked: %v", feedIDs(evs))
	}
	evs, _ = FeedEvents(conn, FeedQuery{TaskIDs: []int64{t2.ID}, Limit: 10})
	if len(evs) != 0 {
		t.Fatalf("explicit id of deleted task: %v", feedIDs(evs))
	}
}

func TestScopeTaskIDs(t *testing.T) {
	conn := newDB(t)
	mustCreate(t, conn, "one")
	ids, err := ScopeTaskIDs(conn, Scope{})
	if err != nil || ids != nil {
		t.Fatalf("all: %v %v", ids, err)
	}
	res := Scope{Kind: ScopeResource, ResourceType: "pr", ResourceID: "o/r#1"}
	ids, err = ScopeTaskIDs(conn, res)
	if err != nil || ids == nil || len(ids) != 0 {
		t.Fatalf("empty resource scope must be non-nil empty: %#v %v", ids, err)
	}
	tk := mustCreate(t, conn, "linked")
	if _, err := AddLink(conn, user, tk.ID, LinkTarget{Kind: LinkResource, ResourceType: "pr", ResourceID: "o/r#1"}, false); err != nil {
		t.Fatal(err)
	}
	ids, _ = ScopeTaskIDs(conn, res)
	if !equalIDs(ids, []int64{tk.ID}) {
		t.Fatalf("scope ids %v", ids)
	}
}
