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
