package tasks

import (
	"errors"
	"testing"
)

func subtaskTexts(tk Task) []string {
	out := []string{}
	for _, s := range tk.Subtasks {
		out = append(out, s.Text)
	}
	return out
}

func eqStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestSubtaskLifecycle(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	if got := mustGet(t, conn, tk.ID); got.Subtasks == nil || len(got.Subtasks) != 0 {
		t.Fatalf("want non-nil empty subtasks, got %#v", got.Subtasks)
	}
	var ids []int64
	for _, s := range []string{"a", " b ", "c"} {
		st, err := AddSubtask(conn, user, tk.ID, s)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, st.ID)
	}
	got := mustGet(t, conn, tk.ID)
	if !eqStrings(subtaskTexts(got), []string{"a", "b", "c"}) {
		t.Fatalf("texts = %v", subtaskTexts(got))
	}
	if got.Subtasks[0].TaskID != tk.ID || got.Subtasks[0].Checked {
		t.Fatalf("bad subtask %+v", got.Subtasks[0])
	}

	ch, err := SetSubtaskChecked(conn, user, ids[1], true)
	if err != nil || ch.From || !ch.To || ch.EventID == 0 {
		t.Fatalf("check: %+v %v", ch, err)
	}
	evs, _ := Events(conn, tk.ID)
	if evs[0].Type != EventSubtaskChecked {
		t.Fatalf("last event %s", evs[0].Type)
	}
	ch, err = SetSubtaskChecked(conn, user, ids[1], true)
	if err != nil || ch.EventID != 0 || !ch.From || !ch.To {
		t.Fatalf("recheck: %+v %v", ch, err)
	}
	if _, err := SetSubtaskChecked(conn, user, ids[1], false); err != nil {
		t.Fatal(err)
	}
	evs, _ = Events(conn, tk.ID)
	if evs[0].Type != EventSubtaskUnchecked {
		t.Fatalf("last event %s", evs[0].Type)
	}

	n := len(evs)
	if err := EditSubtask(conn, user, ids[0], "a"); err != nil {
		t.Fatal(err)
	}
	if evs, _ = Events(conn, tk.ID); len(evs) != n {
		t.Fatal("unchanged edit recorded an event")
	}
	if err := EditSubtask(conn, user, ids[0], "a2"); err != nil {
		t.Fatal(err)
	}
	evs, _ = Events(conn, tk.ID)
	if evs[0].Type != EventSubtaskEdited {
		t.Fatalf("last event %s", evs[0].Type)
	}

	if err := RemoveSubtask(conn, user, ids[2]); err != nil {
		t.Fatal(err)
	}
	got = mustGet(t, conn, tk.ID)
	if !eqStrings(subtaskTexts(got), []string{"a2", "b"}) {
		t.Fatalf("texts = %v", subtaskTexts(got))
	}
	evs, _ = Events(conn, tk.ID)
	if evs[0].Type != EventSubtaskRemoved {
		t.Fatalf("last event %s", evs[0].Type)
	}
}

func TestSubtaskErrors(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	if _, err := AddSubtask(conn, user, tk.ID, "  "); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty: %v", err)
	}
	if _, err := AddSubtask(conn, user, 999, "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing task: %v", err)
	}
	if _, err := AddSubtask(conn, Actor{}, tk.ID, "x"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("zero actor: %v", err)
	}
	st, _ := AddSubtask(conn, user, tk.ID, "x")
	if err := EditSubtask(conn, user, st.ID, " "); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty edit: %v", err)
	}
	if err := EditSubtask(conn, user, 999, "y"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if _, err := SetSubtaskChecked(conn, user, 999, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if err := RemoveSubtask(conn, user, 999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if _, err := Delete(conn, user, tk.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := AddSubtask(conn, user, tk.ID, "z"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted task: %v", err)
	}
	if err := EditSubtask(conn, user, st.ID, "y"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted parent: %v", err)
	}
	if _, err := SetSubtaskChecked(conn, user, st.ID, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted parent: %v", err)
	}
	if err := RemoveSubtask(conn, user, st.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted parent: %v", err)
	}
}

func TestSetSubtaskOrderForgiving(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	other := mustCreate(t, conn, "o")
	var ids []int64
	for _, s := range []string{"a", "b", "c"} {
		st, _ := AddSubtask(conn, user, tk.ID, s)
		ids = append(ids, st.ID)
	}
	foreign, _ := AddSubtask(conn, user, other.ID, "f")
	if err := SetSubtaskOrder(conn, tk.ID, []int64{ids[2], ids[0], 999, foreign.ID}); err != nil {
		t.Fatal(err)
	}
	if got := subtaskTexts(mustGet(t, conn, tk.ID)); !eqStrings(got, []string{"c", "a", "b"}) {
		t.Fatalf("order = %v", got)
	}
	if got := subtaskTexts(mustGet(t, conn, other.ID)); !eqStrings(got, []string{"f"}) {
		t.Fatalf("other = %v", got)
	}
	if err := SetSubtaskOrder(conn, 999, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing task: %v", err)
	}
}
