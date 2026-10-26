package tasks

import "testing"

func TestEventsCarryActor(t *testing.T) {
	conn := newDB(t)
	agent := Actor{Kind: ActorAgent, Session: "tasks-feature"}
	tk, err := Create(conn, agent, NewTask{Title: "x"})
	if err != nil {
		t.Fatal(err)
	}
	ev, err := Events(conn, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(ev) != 1 || ev[0].Type != "task_created" || ev[0].Actor != "agent" || ev[0].ActorSession != "tasks-feature" {
		t.Fatalf("events %+v", ev)
	}
	if ev[0].TaskID != tk.ID || ev[0].TS == "" {
		t.Fatalf("event %+v", ev[0])
	}
}

// Edits are not task events: only state-like changes are. Every edit below
// still saves, but the task's history holds only its creation.
func TestEditsRecordNoEvents(t *testing.T) {
	conn := newDB(t)
	tk, err := Create(conn, user, NewTask{Title: "x", Focus: []LinkTarget{prLink}})
	if err != nil {
		t.Fatal(err)
	}
	title := "renamed"
	if _, err := Update(conn, user, tk.ID, Patch{Title: &title}); err != nil {
		t.Fatal(err)
	}
	mustAddLink(t, conn, tk.ID, jiraLink, false)
	if err := SetLinkFocus(conn, user, tk.ID, jiraLink, true); err != nil {
		t.Fatal(err)
	}
	if err := SetLinkOrder(conn, user, tk.ID, []LinkTarget{prLink}, []LinkTarget{jiraLink}); err != nil {
		t.Fatal(err)
	}
	if err := RemoveLink(conn, user, tk.ID, prLink); err != nil {
		t.Fatal(err)
	}
	s, err := AddSubtask(conn, user, tk.ID, "sub")
	if err != nil {
		t.Fatal(err)
	}
	if err := EditSubtask(conn, user, s.ID, "sub edited"); err != nil {
		t.Fatal(err)
	}
	if err := RemoveSubtask(conn, user, s.ID); err != nil {
		t.Fatal(err)
	}
	if err := LinkEvent(conn, user, tk.ID, "ev:1", snapA); err != nil {
		t.Fatal(err)
	}
	if err := UnlinkEvent(conn, user, tk.ID, "ev:1"); err != nil {
		t.Fatal(err)
	}
	b := mustAddBlocker(t, conn, tk.ID, otherTarget("legal"))
	if err := RemoveBlocker(conn, user, b.ID); err != nil {
		t.Fatal(err)
	}

	got := mustGet(t, conn, tk.ID)
	if got.Title != "renamed" || len(got.Links) != 1 || got.Links[0].LinkTarget != jiraLink || got.Links[0].Primary {
		t.Fatalf("edits did not save: %+v", got)
	}
	ev, err := Events(conn, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	var types []string
	for _, e := range ev {
		types = append(types, e.Type)
	}
	if len(types) != 1 || types[0] != EventTaskCreated {
		t.Fatalf("event types = %v, want only [%s]", types, EventTaskCreated)
	}
}

func TestEventsNewestFirst(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "x")
	if _, err := SetState(conn, user, tk.ID, StateInProgress); err != nil {
		t.Fatal(err)
	}
	ev, err := Events(conn, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(ev) != 2 || ev[0].Type != EventTaskStateChanged || ev[1].Type != EventTaskCreated || ev[0].Actor != "user" {
		t.Fatalf("events %+v", ev)
	}
}
