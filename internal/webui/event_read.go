package webui

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/mturley/worktree/internal/tasks"
	"github.com/mturley/worktree/internal/unread"
)

// EventReadChange is what marking one event read did. Changed is false when
// the event already read as read, so there is nothing to undo.
type EventReadChange struct {
	ID      string `json:"id"`
	TS      string `json:"ts"`
	Changed bool   `json:"changed"`
}

// eventReadResponse is /api/event-read's answer, which is also what its undo
// (/api/event-read/restore) posts back.
type eventReadResponse = EventReadChange

// MarkEventRead marks one event read without moving its resource's cursor.
// ts, when given, is the row's ts as the caller saw it; a rewrite since then
// answers unread.ErrEventChanged, so a mark never covers a result nobody saw.
//
// An event that already reads as read — behind its cursor, the user's own, a
// CI run still in progress, already marked — writes nothing. Slack events are
// refused with unread.ErrSlackNotSupported: Slack keeps one cursor per thread
// and cannot read a single message, and two systems must not both claim
// authority over a thread.
func (s *Server) MarkEventRead(id, ts string) (EventReadChange, error) {
	ev, err := unread.LoadEvent(s.DB, id)
	if err != nil {
		return EventReadChange{}, err
	}
	if ev.IsSlack() {
		return EventReadChange{}, unread.ErrSlackNotSupported
	}
	if ts != "" && ts != ev.TS {
		return EventReadChange{}, unread.ErrEventChanged
	}
	out := EventReadChange{ID: id, TS: ev.TS}
	isUnread, err := s.eventIsUnread(ev)
	if err != nil || !isUnread {
		return out, err
	}
	if err := unread.MarkEvent(s.DB, id, ev.TS); err != nil {
		return out, err
	}
	out.Changed = true
	return out, nil
}

// RestoreEventRead takes a mark back; see unread.UnmarkEvent for ts. There is
// no conflict to report: removing a mark never rewinds a later read, since
// the cursor still covers whatever it has passed.
func (s *Server) RestoreEventRead(id, ts string) (EventReadChange, error) {
	removed, err := unread.UnmarkEvent(s.DB, id, ts)
	return EventReadChange{ID: id, TS: ts, Changed: removed}, err
}

// eventIsUnread is the rule the feeds apply to a row, for one event.
func (s *Server) eventIsUnread(ev unread.Event) (bool, error) {
	if ev.Source == "tasks" {
		cursors, err := unread.Cursors(s.DB)
		if err != nil {
			return false, err
		}
		marks, err := unread.EventMarks(s.DB)
		if err != nil {
			return false, err
		}
		key := unread.Key(taskResourceType, strconv.FormatInt(ev.TaskID, 10))
		return tasks.CountsAsUnread(ev.Actor) && ev.TS > cursors[key] && !unread.IsMarked(marks, ev.ID, ev.TS), nil
	}
	ix := s.newUnreadIndex()
	for _, r := range ev.Resources {
		if ix.IsUnread(ev.ID, r.Type, r.ID, ev.TS, ev.ExternalTS, ev.Type, ev.Source, ev.AuthorID) {
			return true, nil
		}
	}
	return false, nil
}

// handleEventRead: POST /api/event-read, body {"id":..., "ts":...} -> 200
// EventReadChange. 400 for a Slack event, 404 for an unknown one, 409 when
// the row has been rewritten since ts.
func (s *Server) handleEventRead(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
		TS string `json:"ts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.ID == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	ch, err := s.MarkEventRead(req.ID, req.TS)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, ch)
	case errors.Is(err, unread.ErrEventNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, unread.ErrSlackNotSupported):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, unread.ErrEventChanged):
		writeError(w, http.StatusConflict, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

// handleEventReadRestore: POST /api/event-read/restore, body {"id":..., "ts":...}
// -> 204, the undo of a POST /api/event-read, echoing back what it returned.
func (s *Server) handleEventReadRestore(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
		TS string `json:"ts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.ID == "" || req.TS == "" {
		writeError(w, http.StatusBadRequest, "id and ts are required")
		return
	}
	if _, err := s.RestoreEventRead(req.ID, req.TS); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
