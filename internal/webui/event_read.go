package webui

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/mturley/worktree/internal/tasks"
	"github.com/mturley/worktree/internal/unread"
)

// EventReadChange is what marking one event read or unread did, and what its
// undo posts back. Changed is false when the event already read that way, so
// there is nothing to undo. Previous is the mark the write replaced or deleted
// ("read", "unread", or "" for none).
type EventReadChange struct {
	ID       string `json:"id"`
	TS       string `json:"ts"`
	Previous string `json:"previous"`
	Changed  bool   `json:"changed"`
}

// eventReadResponse is the mark routes' answer.
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
	return s.setEventRead(id, ts, unread.StateRead)
}

// MarkEventUnread marks one event unread, even behind its cursor, as
// MarkEventRead does in reverse. It also refuses events that can never read as
// unread (unread.ErrNeverUnread) and resources no worktree follows
// (unread.ErrNotFollowed), which have no card to clear it from.
func (s *Server) MarkEventUnread(id, ts string) (EventReadChange, error) {
	return s.setEventRead(id, ts, unread.StateUnread)
}

func (s *Server) setEventRead(id, ts, state string) (EventReadChange, error) {
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
	v, err := s.eventVerdict(ev)
	if err != nil {
		return EventReadChange{}, err
	}
	out := EventReadChange{ID: id, TS: ev.TS}
	wantUnread := state == unread.StateUnread
	if wantUnread {
		if !v.canBeUnread {
			return EventReadChange{}, unread.ErrNeverUnread
		}
		if ev.Source != "tasks" {
			followed, err := unread.IsFollowed(s.DB, ev)
			if err != nil {
				return EventReadChange{}, err
			}
			if !followed {
				return EventReadChange{}, unread.ErrNotFollowed
			}
		}
	}
	if v.unread == wantUnread {
		return out, nil
	}
	out.Previous, out.Changed = v.mark, true
	// The least that gives the right answer: when the cursor already says what
	// is wanted, no mark. That matters if the cursor later moves back, since a
	// stored mark would keep overriding it.
	if v.pastCursor == wantUnread {
		_, err = unread.UnmarkEvent(s.DB, id, "")
	} else {
		err = unread.SetEventMark(s.DB, id, ev.TS, state)
	}
	return out, err
}

// RestoreEventRead undoes a mark, given its ts and the mark it replaced
// (previous, "" for none); see unread.RestoreEventMark. An empty ts removes
// whatever mark is there. There is no conflict to report: a mark only ever says
// something about the row version it was made on.
func (s *Server) RestoreEventRead(id, ts, previous string) (EventReadChange, error) {
	if ts == "" {
		removed, err := unread.UnmarkEvent(s.DB, id, "")
		return EventReadChange{ID: id, Changed: removed}, err
	}
	err := unread.RestoreEventMark(s.DB, id, ts, previous)
	return EventReadChange{ID: id, TS: ts, Previous: previous, Changed: err == nil}, err
}

// eventVerdict is what the feeds' rule says about one event.
type eventVerdict struct {
	unread      bool   // reads as unread now
	pastCursor  bool   // reads as unread with no mark
	canBeUnread bool   // not one of the events that never reads as unread
	mark        string // the state of a mark at its current ts, "" for none
}

func (s *Server) eventVerdict(ev unread.Event) (eventVerdict, error) {
	marks, err := unread.EventMarks(s.DB)
	if err != nil {
		return eventVerdict{}, err
	}
	var v eventVerdict
	if m, ok := marks[ev.ID]; ok && m.TS == ev.TS {
		v.mark = m.State
	}
	if ev.Source == "tasks" {
		cursors, err := unread.Cursors(s.DB)
		if err != nil {
			return eventVerdict{}, err
		}
		v.canBeUnread = tasks.CountsAsUnread(ev.Actor)
		key := unread.Key(taskResourceType, strconv.FormatInt(ev.TaskID, 10))
		v.pastCursor = v.canBeUnread && ev.TS > cursors[key]
		v.unread = v.canBeUnread && unread.EventUnread(marks, ev.ID, ev.TS, ev.TS > cursors[key])
		return v, nil
	}
	ix := s.newUnreadIndex()
	noMarks := *ix
	noMarks.marks = nil
	for _, r := range ev.Resources {
		v.canBeUnread = v.canBeUnread || ix.canMarkUnread(r.Type, ev.Type, ev.Source, ev.AuthorID)
		v.unread = v.unread || ix.IsUnread(ev.ID, r.Type, r.ID, ev.TS, ev.ExternalTS, ev.Type, ev.Source, ev.AuthorID)
		v.pastCursor = v.pastCursor || noMarks.IsUnread(ev.ID, r.Type, r.ID, ev.TS, ev.ExternalTS, ev.Type, ev.Source, ev.AuthorID)
	}
	return v, nil
}

// handleEventRead: POST /api/event-read, body {"id":..., "ts":...} -> 200
// EventReadChange. 400 for a Slack event, 404 for an unknown one, 409 when
// the row has been rewritten since ts.
func (s *Server) handleEventRead(w http.ResponseWriter, r *http.Request) {
	s.handleEventMark(w, r, s.MarkEventRead)
}

// handleEventUnread: POST /api/event-unread, as handleEventRead, and also 400
// for an event that can never be unread or that no worktree follows.
func (s *Server) handleEventUnread(w http.ResponseWriter, r *http.Request) {
	s.handleEventMark(w, r, s.MarkEventUnread)
}

func (s *Server) handleEventMark(w http.ResponseWriter, r *http.Request, mark func(id, ts string) (EventReadChange, error)) {
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
	ch, err := mark(req.ID, req.TS)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, ch)
	case errors.Is(err, unread.ErrEventNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, unread.ErrSlackNotSupported), errors.Is(err, unread.ErrNeverUnread), errors.Is(err, unread.ErrNotFollowed):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, unread.ErrEventChanged):
		writeError(w, http.StatusConflict, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

// handleEventReadRestore: POST /api/event-read/restore, body
// {"id":..., "ts":..., "previous":...} -> 204, the undo of a mark either way,
// echoing back what it returned.
func (s *Server) handleEventReadRestore(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID       string `json:"id"`
		TS       string `json:"ts"`
		Previous string `json:"previous"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.ID == "" || req.TS == "" {
		writeError(w, http.StatusBadRequest, "id and ts are required")
		return
	}
	if _, err := s.RestoreEventRead(req.ID, req.TS, req.Previous); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
