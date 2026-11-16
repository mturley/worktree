// Package jobs models the background jobs (worktree create and delete) that
// the web UI server runs, and stores them in the worktree DB.
package jobs

import "encoding/json"

// State is where a job is in its life.
type State string

const (
	StateRunning     State = "running"
	StateNeedsAnswer State = "needs_answer"
	StateSucceeded   State = "succeeded"
	StateFailed      State = "failed"
	StateInterrupted State = "interrupted"
)

// StepStatus is where one step of a job is.
type StepStatus string

const (
	StepPending    StepStatus = "pending" // not reached
	StepRunning    StepStatus = "running" // in flight
	StepDone       StepStatus = "done"
	StepSkipped    StepStatus = "skipped"
	StepFailed     StepStatus = "failed"
	StepNeedsForce StepStatus = "needs_force"
)

// Step is one named stage of a job.
type Step struct {
	Key    string     `json:"key"`
	Label  string     `json:"label"`
	Status StepStatus `json:"status"`
	Detail string     `json:"detail,omitempty"`
}

// Job is one background job.
type Job struct {
	ID         string          `json:"id"`
	Kind       string          `json:"kind"`
	Title      string          `json:"title"`
	Target     string          `json:"target"`
	State      State           `json:"state"`
	Steps      []Step          `json:"steps"`    // never null
	Question   json.RawMessage `json:"question"` // null unless needs_answer
	Result     json.RawMessage `json:"result"`   // null until a kind sets it
	Error      string          `json:"error,omitempty"`
	CreatedAt  string          `json:"created_at"` // RFC3339Nano UTC
	UpdatedAt  string          `json:"updated_at"`
	FinishedAt string          `json:"finished_at,omitempty"`
	Dismissed  bool            `json:"dismissed,omitempty"` // only on the final event for a job
	Request    json.RawMessage `json:"-"`
	PID        int             `json:"-"`
}

// Finished reports whether the job succeeded, failed or was interrupted.
func (j Job) Finished() bool {
	switch j.State {
	case StateSucceeded, StateFailed, StateInterrupted:
		return true
	}
	return false
}

// HasFailedStep reports whether any step failed.
func (j Job) HasFailedStep() bool {
	for _, s := range j.Steps {
		if s.Status == StepFailed {
			return true
		}
	}
	return false
}
