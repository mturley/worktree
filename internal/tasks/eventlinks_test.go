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
