package tasks

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func workLogText(t *testing.T, e Event) WorkLogPayload {
	t.Helper()
	var p WorkLogPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLogWorkRecordsEvent(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "alpha")
	if _, err := conn.Exec(`UPDATE tasks SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?`, tk.ID); err != nil {
		t.Fatal(err)
	}
	ev, err := LogWork(conn, user, tk.ID, "  did X\nand Y ")
	if err != nil {
		t.Fatal(err)
	}
	if ev.Type != EventTaskWorkLogged || ev.Actor != ActorUser || ev.TaskID != tk.ID {
		t.Fatalf("event = %+v", ev)
	}
	if p := workLogText(t, ev); p.Text != "did X\nand Y" || p.EditedAt != "" {
		t.Fatalf("payload = %+v", p)
	}
	evs, err := Events(conn, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if evs[0].ID != ev.ID || evs[0].Type != EventTaskWorkLogged || evs[0].TS != ev.TS || string(evs[0].Payload) != string(ev.Payload) {
		t.Fatalf("Events[0] = %+v, want %+v", evs[0], ev)
	}
	if got := mustGet(t, conn, tk.ID); got.UpdatedAt == "2000-01-01T00:00:00Z" {
		t.Fatalf("updated_at not advanced: %s", got.UpdatedAt)
	}
}

func TestLogWorkValidation(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "alpha")
	for _, s := range []string{"", " \n\t "} {
		if _, err := LogWork(conn, user, tk.ID, s); !errors.Is(err, ErrInvalid) {
			t.Errorf("LogWork(%q) = %v, want ErrInvalid", s, err)
		}
	}
	if _, err := LogWork(conn, user, tk.ID, strings.Repeat("é", MaxWorkLogText+1)); !errors.Is(err, ErrInvalid) {
		t.Errorf("4001 runes = %v, want ErrInvalid", err)
	}
	if _, err := LogWork(conn, user, tk.ID, strings.Repeat("é", MaxWorkLogText)); err != nil {
		t.Errorf("4000 runes: %v", err)
	}
	if _, err := LogWork(conn, user, 9999, "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing task = %v, want ErrNotFound", err)
	}
	if _, err := Delete(conn, user, tk.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := LogWork(conn, user, tk.ID, "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("deleted task = %v, want ErrNotFound", err)
	}
}

func TestEditWorkLog(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "alpha")
	ev, err := LogWork(conn, user, tk.ID, "first")
	if err != nil {
		t.Fatal(err)
	}
	got, err := EditWorkLog(conn, user, ev.ID, " second ")
	if err != nil {
		t.Fatal(err)
	}
	p := workLogText(t, got)
	if p.Text != "second" || p.EditedAt == "" {
		t.Fatalf("payload = %+v", p)
	}
	if _, err := time.Parse(time.RFC3339, p.EditedAt); err != nil {
		t.Fatalf("edited_at %q: %v", p.EditedAt, err)
	}
	if got.ID != ev.ID || got.TS != ev.TS {
		t.Fatalf("id/ts changed: %+v vs %+v", got, ev)
	}
	evs, _ := Events(conn, tk.ID)
	if evs[0].ID != ev.ID || evs[0].TS != ev.TS || workLogText(t, evs[0]).Text != "second" {
		t.Fatalf("stored = %+v", evs[0])
	}

	// Identical text writes nothing.
	ev2, err := LogWork(conn, user, tk.ID, "same")
	if err != nil {
		t.Fatal(err)
	}
	before, _ := Version(conn)
	out, err := EditWorkLog(conn, user, ev2.ID, "same ")
	if err != nil {
		t.Fatal(err)
	}
	if after, _ := Version(conn); after != before {
		t.Fatalf("version %d -> %d on a no-op edit", before, after)
	}
	if workLogText(t, out).EditedAt != "" {
		t.Fatalf("edited_at set on a no-op edit: %s", out.Payload)
	}
}

func TestEditDeleteRefuseOtherTypes(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "alpha")
	evs, _ := Events(conn, tk.ID)
	created := evs[len(evs)-1]
	if created.Type != EventTaskCreated {
		t.Fatalf("setup: %+v", created)
	}
	if _, err := EditWorkLog(conn, user, created.ID, "x"); !errors.Is(err, ErrNotWorkLog) {
		t.Errorf("Edit = %v, want ErrNotWorkLog", err)
	}
	if _, err := DeleteWorkLog(conn, user, created.ID); !errors.Is(err, ErrNotWorkLog) {
		t.Errorf("Delete = %v, want ErrNotWorkLog", err)
	}
	if _, err := WorkLogTaskID(conn, created.ID); !errors.Is(err, ErrNotWorkLog) {
		t.Errorf("WorkLogTaskID = %v, want ErrNotWorkLog", err)
	}
	if _, err := WorkLogTaskID(conn, 9999); !errors.Is(err, ErrNotFound) {
		t.Errorf("WorkLogTaskID missing = %v, want ErrNotFound", err)
	}
	after, _ := Events(conn, tk.ID)
	if len(after) != len(evs) || string(after[len(after)-1].Payload) != string(created.Payload) {
		t.Fatalf("row touched: %+v", after)
	}
}

func TestDeleteWorkLog(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "alpha")
	ev, err := LogWork(conn, user, tk.ID, "x")
	if err != nil {
		t.Fatal(err)
	}
	id, err := WorkLogTaskID(conn, ev.ID)
	if err != nil || id != tk.ID {
		t.Fatalf("WorkLogTaskID = %d, %v", id, err)
	}
	got, err := DeleteWorkLog(conn, user, ev.ID)
	if err != nil || got != tk.ID {
		t.Fatalf("DeleteWorkLog = %d, %v", got, err)
	}
	evs, _ := Events(conn, tk.ID)
	for _, e := range evs {
		if e.ID == ev.ID {
			t.Fatal("row still present")
		}
	}
	if _, err := DeleteWorkLog(conn, user, ev.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete = %v, want ErrNotFound", err)
	}
}

func TestWorkLogAgentActorAllowed(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "alpha")
	ev, err := LogWork(conn, agent, tk.ID, "agent note")
	if err != nil {
		t.Fatal(err)
	}
	if ev.Actor != ActorAgent || ev.ActorSession != "s1" {
		t.Fatalf("event = %+v", ev)
	}
}
