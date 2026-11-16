package webui

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"

	"github.com/mturley/worktree/internal/jobs"
)

// jobs is the job manager, built on first use with both kinds registered.
// Lazily, like every other per-Server hub: Server is a bare struct literal in
// cmd/ui.go and in every test, so there is no constructor to build it in.
func (s *Server) jobs() *jobs.Manager {
	s.jobsOnce.Do(func() {
		m := jobs.New(s.DB, os.Getpid())
		if s.Logger != nil {
			// A job's goroutine has nobody to return a save failure to, so
			// without this the published state could part from the stored
			// rows in silence.
			m.Logf = s.Logger.Printf
		}
		m.Register(s.createJobKind())
		m.Register(s.deleteJobKind())
		s.jobsMgr = m
	})
	return s.jobsMgr
}

// RecoverJobs turns the rows a dead server left behind into states the user
// can act on. `worktree ui` calls it once before serving.
func (s *Server) RecoverJobs() error { return s.jobs().Recover() }

// startJobResponse is what the create and delete routes answer with.
// Attached means the request joined the job already running on this target
// rather than starting a second one.
type startJobResponse struct {
	Job      jobs.Job `json:"job"`
	Attached bool     `json:"attached"`
}

type jobsResponse struct {
	Jobs []jobs.Job `json:"jobs"`
}

// startJob starts kind and writes the response, so the two start handlers
// differ only in their validation.
func (s *Server) startJob(w http.ResponseWriter, kind, title, target string, request any) {
	body, err := json.Marshal(request)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	job, attached, err := s.jobs().Start(kind, title, target, body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, startJobResponse{Job: job, Attached: attached})
}

// handleJobs: GET /api/jobs
//
// Every visible job, for a tab's first paint; the stream keeps it current
// afterwards.
func (s *Server) handleJobs(w http.ResponseWriter, r *http.Request) {
	list, err := s.jobs().Visible()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if list == nil {
		list = []jobs.Job{}
	}
	writeJSON(w, http.StatusOK, jobsResponse{Jobs: list})
}

type jobIDRequest struct {
	ID string `json:"id"`
}

type jobAnswerRequest struct {
	ID     string `json:"id"`
	Answer string `json:"answer"`
}

// handleJobAnswer: POST /api/jobs/answer
func (s *Server) handleJobAnswer(w http.ResponseWriter, r *http.Request) {
	var req jobAnswerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	var yes bool
	switch req.Answer {
	case "yes":
		yes = true
	case "no":
		yes = false
	default:
		writeError(w, http.StatusBadRequest, `answer must be "yes" or "no"`)
		return
	}
	job, err := s.jobs().Answer(req.ID, yes)
	if err != nil {
		writeJobError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, job)
}

// handleJobRetry: POST /api/jobs/retry
func (s *Server) handleJobRetry(w http.ResponseWriter, r *http.Request) {
	var req jobIDRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	job, err := s.jobs().Retry(req.ID)
	if err != nil {
		writeJobError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, job)
}

// handleJobDismiss: POST /api/jobs/dismiss
func (s *Server) handleJobDismiss(w http.ResponseWriter, r *http.Request) {
	var req jobIDRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := s.jobs().Dismiss(req.ID); err != nil {
		writeJobError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// writeJobError maps the manager's errors onto statuses. A wrong state is 409
// and not 400: the request was well formed, the job simply moved on — which
// is what a second tab acting on a stale view looks like.
func writeJobError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, jobs.ErrNotFound):
		writeError(w, http.StatusNotFound, "job not found")
	case errors.Is(err, jobs.ErrWrongState):
		writeError(w, http.StatusConflict, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}
