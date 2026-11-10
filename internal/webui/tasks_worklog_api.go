package webui

import (
	"net/http"

	"github.com/mturley/worktree/internal/tasks"
)

type workLogRequest struct {
	ID      int64  `json:"id"`
	EventID int64  `json:"event_id"`
	Text    string `json:"text"`
}

// handleAddWorkLog: POST /api/tasks/worklog/add {id, text}
func (s *Server) handleAddWorkLog(w http.ResponseWriter, r *http.Request) {
	var req workLogRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	if _, err := tasks.LogWork(s.DB, webActor, req.ID, req.Text); err != nil {
		writeTaskError(w, err)
		return
	}
	s.afterTaskWrite()
	s.writeTaskDetail(w, req.ID)
}

// workLogWrite runs op on the work log entry named in the body and answers
// with its task's detail. The task is looked up first: after a delete there
// is no event left to find it from.
func (s *Server) workLogWrite(w http.ResponseWriter, r *http.Request, op func(workLogRequest) error) {
	var req workLogRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	taskID, err := tasks.WorkLogTaskID(s.DB, req.EventID)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	if err := op(req); err != nil {
		writeTaskError(w, err)
		return
	}
	s.afterTaskWrite()
	s.writeTaskDetail(w, taskID)
}

// handleEditWorkLog: POST /api/tasks/worklog/edit {event_id, text}
func (s *Server) handleEditWorkLog(w http.ResponseWriter, r *http.Request) {
	s.workLogWrite(w, r, func(req workLogRequest) error {
		_, err := tasks.EditWorkLog(s.DB, webActor, req.EventID, req.Text)
		return err
	})
}

// handleDeleteWorkLog: POST /api/tasks/worklog/delete {event_id}
func (s *Server) handleDeleteWorkLog(w http.ResponseWriter, r *http.Request) {
	s.workLogWrite(w, r, func(req workLogRequest) error {
		_, err := tasks.DeleteWorkLog(s.DB, webActor, req.EventID)
		return err
	})
}
