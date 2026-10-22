package tasks

import (
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

var snapA = EventSnapshot{Source: "github", Type: "pr_comment", Title: "Looks good", Author: "bob",
	Body: "body", URL: "https://x/y", TS: "2026-10-21T10:00:00Z", ResourceType: "pr", ResourceID: "o/r#1"}

func TestEventLinkRoundTrip(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	if err := LinkEvent(conn, user, tk.ID, "ev:5", snapA); err != nil {
		t.Fatal(err)
	}
	if err := LinkEvent(conn, user, tk.ID, "slack:C1:123.4", snapA); err != nil {
		t.Fatal(err)
	}
	got, err := EventLinks(conn, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Key != "ev:5" || got[1].Key != "slack:C1:123.4" || got[0].Snapshot != snapA || got[0].CreatedAt == "" {
		t.Fatalf("links = %+v", got)
	}
	ids, err := TasksLinkingEvent(conn, "ev:5")
	if err != nil || len(ids) != 1 || ids[0] != tk.ID {
		t.Fatalf("TasksLinkingEvent = %v, %v", ids, err)
	}
	if n := len(eventsOfType(t, conn, tk.ID, EventTaskEventLinked)); n != 2 {
		t.Fatalf("linked events = %d", n)
	}
	if err := UnlinkEvent(conn, user, tk.ID, "ev:5"); err != nil {
		t.Fatal(err)
	}
	got, _ = EventLinks(conn, tk.ID)
	if len(got) != 1 || len(eventsOfType(t, conn, tk.ID, EventTaskEventUnlinked)) != 1 {
		t.Fatalf("after unlink: %+v", got)
	}
}

func TestEventLinkIdempotent(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	for i := 0; i < 2; i++ {
		if err := LinkEvent(conn, user, tk.ID, "ev:5", snapA); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(eventsOfType(t, conn, tk.ID, EventTaskEventLinked)); n != 1 {
		t.Fatalf("linked events = %d, want 1", n)
	}
}

func TestEventLinkErrors(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	if err := UnlinkEvent(conn, user, tk.ID, "ev:9"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unlink missing = %v", err)
	}
	for _, k := range []string{"", "bogus:1", "ev"} {
		if err := LinkEvent(conn, user, tk.ID, k, snapA); !errors.Is(err, ErrInvalid) {
			t.Fatalf("key %q = %v", k, err)
		}
	}
	if err := LinkEvent(conn, user, 999, "ev:1", snapA); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing task = %v", err)
	}
	if err := LinkEvent(conn, Actor{}, tk.ID, "ev:1", snapA); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bad actor = %v", err)
	}
}

func TestEventLinkBodyTruncated(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	s := snapA
	s.Body = strings.Repeat("é", 2000)
	if err := LinkEvent(conn, user, tk.ID, "ev:1", s); err != nil {
		t.Fatal(err)
	}
	got, _ := EventLinks(conn, tk.ID)
	if n := utf8.RuneCountInString(got[0].Snapshot.Body); n != 500 {
		t.Fatalf("body runes = %d", n)
	}
}

func TestEventLinkCascadeOnDelete(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	if err := LinkEvent(conn, user, tk.ID, "ev:1", snapA); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`DELETE FROM tasks WHERE id = ?`, tk.ID); err != nil {
		t.Fatal(err)
	}
	if n := count(t, conn, "task_event_links"); n != 0 {
		t.Fatalf("rows = %d", n)
	}
}

func TestEventLinkRelinkKeepsVersionFlat(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	if err := LinkEvent(conn, user, tk.ID, "ev:5", snapA); err != nil {
		t.Fatal(err)
	}
	v := mustVersion(t, conn)
	if err := LinkEvent(conn, user, tk.ID, "ev:5", snapA); err != nil {
		t.Fatal(err)
	}
	if got := mustVersion(t, conn); got != v {
		t.Fatalf("version after no-op relink = %d, want %d", got, v)
	}
}

func TestLinkEventReplaceOverwritesSnapshot(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	client := EventSnapshot{Title: "client", Source: "slack"}
	if err := LinkEvent(conn, user, tk.ID, "slack:C1:1.2", client); err != nil {
		t.Fatal(err)
	}
	// LinkEvent leaves an existing snapshot alone.
	if err := LinkEvent(conn, user, tk.ID, "slack:C1:1.2", snapA); err != nil {
		t.Fatal(err)
	}
	if got, _ := EventLinks(conn, tk.ID); got[0].Snapshot != client {
		t.Fatalf("LinkEvent replaced the snapshot: %+v", got[0].Snapshot)
	}
	if err := LinkEventReplace(conn, user, tk.ID, "slack:C1:1.2", snapA); err != nil {
		t.Fatal(err)
	}
	got, _ := EventLinks(conn, tk.ID)
	if len(got) != 1 || got[0].Snapshot != snapA {
		t.Fatalf("after replace = %+v", got)
	}
	if n := len(eventsOfType(t, conn, tk.ID, EventTaskEventLinked)); n != 1 {
		t.Fatalf("a replaced snapshot records no event; linked events = %d", n)
	}
	v := mustVersion(t, conn)
	if err := LinkEventReplace(conn, user, tk.ID, "slack:C1:1.2", snapA); err != nil {
		t.Fatal(err)
	}
	if mustVersion(t, conn) != v {
		t.Fatal("replacing with the same snapshot bumped Version")
	}
	// A new key links as LinkEvent would.
	if err := LinkEventReplace(conn, user, tk.ID, "ev:9", snapA); err != nil {
		t.Fatal(err)
	}
	if n := len(eventsOfType(t, conn, tk.ID, EventTaskEventLinked)); n != 2 {
		t.Fatalf("linked events = %d", n)
	}
}

func TestCreateFromEvent(t *testing.T) {
	conn := newDB(t)
	tk, err := CreateFromEvent(conn, user, NewTask{Title: "from ev", Focus: []LinkTarget{
		{Kind: LinkResource, ResourceType: "pr", ResourceID: "o/r#1"},
	}}, "ev:5", snapA)
	if err != nil {
		t.Fatal(err)
	}
	if tk.Title != "from ev" || len(tk.Links) != 1 {
		t.Fatalf("task = %+v", tk)
	}
	links, err := EventLinks(conn, tk.ID)
	if err != nil || len(links) != 1 || links[0].Key != "ev:5" || links[0].Snapshot != snapA {
		t.Fatalf("event links = %+v, %v", links, err)
	}
	if n := len(eventsOfType(t, conn, tk.ID, EventTaskEventLinked)); n != 1 {
		t.Fatalf("linked events = %d", n)
	}
}

func TestCreateFromEventIsAtomic(t *testing.T) {
	conn := newDB(t)
	// Make the event-link insert fail inside the transaction.
	if _, err := conn.Exec(`CREATE TRIGGER boom BEFORE INSERT ON task_event_links
		BEGIN SELECT RAISE(ABORT, 'boom'); END`); err != nil {
		t.Fatal(err)
	}
	v := mustVersion(t, conn)
	if _, err := CreateFromEvent(conn, user, NewTask{Title: "x", Focus: []LinkTarget{
		{Kind: LinkResource, ResourceType: "pr", ResourceID: "o/r#1"},
	}}, "ev:5", snapA); err == nil {
		t.Fatal("want an error")
	}
	for _, table := range []string{"tasks", "task_links", "task_events", "task_event_links"} {
		if n := count(t, conn, table); n != 0 {
			t.Errorf("%s rows = %d after a failed CreateFromEvent", table, n)
		}
	}
	if mustVersion(t, conn) != v {
		t.Error("a failed CreateFromEvent bumped Version")
	}
	// Bad input fails before anything is written.
	if _, err := CreateFromEvent(conn, user, NewTask{Title: "x"}, "bogus:1", snapA); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bad key = %v", err)
	}
	if _, err := CreateFromEvent(conn, user, NewTask{Title: " "}, "ev:1", snapA); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty title = %v", err)
	}
	if _, err := CreateFromEvent(conn, Actor{}, NewTask{Title: "x"}, "ev:1", snapA); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bad actor = %v", err)
	}
}
