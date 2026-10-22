package tasks

import "testing"

// The unread actor rule: an agent's events count as unread, the user's
// never do. Phase 5 adds "system".
func TestCountsAsUnread(t *testing.T) {
	for actor, want := range map[string]bool{ActorAgent: true, ActorUser: false, "": false, "bogus": false} {
		if got := CountsAsUnread(actor); got != want {
			t.Errorf("CountsAsUnread(%q) = %v, want %v", actor, got, want)
		}
	}
	if got := UnreadActors(); len(got) != 1 || got[0] != ActorAgent {
		t.Errorf("UnreadActors() = %v", got)
	}
}

// UnreadActorSQL is CountsAsUnread in SQL: the same verdict for every actor.
func TestUnreadActorSQLAgreesWithCountsAsUnread(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "alpha")
	clearEvents(t, conn)
	ids := map[int64]string{}
	for _, a := range []string{ActorAgent, ActorUser, "bogus"} {
		ids[feedEvent(t, conn, tk.ID, "2026-01-01T00:00:01Z", a)] = a
	}
	clause, args := UnreadActorSQL("e.actor")
	rows, err := conn.Query(`SELECT e.id FROM task_events e WHERE `+clause, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	matched := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		matched[id] = true
	}
	for id, a := range ids {
		if matched[id] != CountsAsUnread(a) {
			t.Errorf("actor %q: SQL %v, CountsAsUnread %v", a, matched[id], CountsAsUnread(a))
		}
	}
}
