package webui

import (
	"net/http"
	"testing"

	"github.com/mturley/worktree/internal/tasks"
)

func workLogRow(t *testing.T, s *Server, id int64) (TimelineEvent, bool) {
	t.Helper()
	for _, e := range getActivity(t, s, id, "filter=task") {
		if e.Type == tasks.EventTaskWorkLogged {
			return e, true
		}
	}
	return TimelineEvent{}, false
}

func TestWorkLogAPIAddEditDelete(t *testing.T) {
	t.Parallel()
	s, _ := tasksServer(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "T title"})

	rec := serveTasks(t, s, http.MethodPost, "/api/tasks/worklog/add", map[string]any{"id": tk.ID, "text": "did a thing"})
	if d := decodeDetail(t, rec); d.ID != tk.ID {
		t.Fatalf("detail id = %d", d.ID)
	}
	row, ok := workLogRow(t, s, tk.ID)
	if !ok || row.Title != `Worked on “T title”` || row.Body != "did a thing" || row.EditedAt != "" {
		t.Fatalf("row = %+v ok=%v", row, ok)
	}
	if row.TypeLabel != "work logged" {
		t.Fatalf("label = %q", row.TypeLabel)
	}

	var evID int64
	if err := s.DB.QueryRow(`SELECT id FROM task_events WHERE type = ?`, tasks.EventTaskWorkLogged).Scan(&evID); err != nil {
		t.Fatal(err)
	}
	decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/worklog/edit", map[string]any{"event_id": evID, "text": "did two things"}))
	row, ok = workLogRow(t, s, tk.ID)
	if !ok || row.Body != "did two things" || row.EditedAt == "" {
		t.Fatalf("after edit row = %+v ok=%v", row, ok)
	}

	decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/worklog/delete", map[string]any{"event_id": evID}))
	if _, ok := workLogRow(t, s, tk.ID); ok {
		t.Fatal("work log row still present after delete")
	}
}

func TestWorkLogAPIRefusesOtherEvents(t *testing.T) {
	t.Parallel()
	s, _ := tasksServer(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "T title"})
	var createdID int64
	if err := s.DB.QueryRow(`SELECT id FROM task_events WHERE type = ? AND task_id = ?`, tasks.EventTaskCreated, tk.ID).Scan(&createdID); err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"edit", "delete"} {
		rec := serveTasks(t, s, http.MethodPost, "/api/tasks/worklog/"+route, map[string]any{"event_id": createdID, "text": "x"})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s created event = %d, want 400", route, rec.Code)
		}
		rec = serveTasks(t, s, http.MethodPost, "/api/tasks/worklog/"+route, map[string]any{"event_id": 999999, "text": "x"})
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s unknown event = %d, want 404", route, rec.Code)
		}
	}
	rec := serveTasks(t, s, http.MethodPost, "/api/tasks/worklog/add", map[string]any{"id": tk.ID, "text": "  "})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("empty text = %d, want 400", rec.Code)
	}
}
