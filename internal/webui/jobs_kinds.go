package webui

import (
	"encoding/json"
	"fmt"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/jobs"
	"github.com/mturley/worktree/internal/worktreedel"
	"github.com/mturley/worktree/internal/worktreenew"
)

// The two job kinds. These names are stored in every job row and sent to the
// browser, so they are fixed.
const (
	jobKindCreate = "worktree_create"
	jobKindDelete = "worktree_delete"
)

// observedStatus maps a runner's step status to a job's. Both runners announce
// a step as `pending` through observe just before doing its work — that is
// exactly what `running` means on a job, and it is the only way the UI can
// show that a slow step (a pull, a large directory removal) is under way. A
// plan's own pending steps never pass through observe, so nothing else needs
// this translation; every other status name is shared by both vocabularies.
func observedStatus(status string) jobs.StepStatus {
	if status == string(jobs.StepPending) {
		return jobs.StepRunning
	}
	return jobs.StepStatus(status)
}

// createJobKind is the worktree_create kind: it runs internal/worktreenew and
// turns its confirmations into the job's questions.
func (s *Server) createJobKind() jobs.Kind {
	return jobs.Kind{
		Name: jobKindCreate,
		Plan: func(json.RawMessage) []jobs.Step {
			planned := worktreenew.Planned()
			steps := make([]jobs.Step, 0, len(planned))
			for _, st := range planned {
				steps = append(steps, jobs.Step{
					Key: string(st.Key), Label: st.Label, Status: jobs.StepStatus(st.Status),
				})
			}
			return steps
		},
		Run:    s.runCreateJob,
		Answer: answerCreateJob,
	}
}

func (s *Server) runCreateJob(request json.RawMessage, report func(jobs.Step)) jobs.Outcome {
	var req createWorktreeRequest
	if err := json.Unmarshal(request, &req); err != nil {
		return jobs.Outcome{State: jobs.StateFailed, Error: err.Error()}
	}
	cfg, err := s.createConfig()
	if err != nil {
		return jobs.Outcome{State: jobs.StateFailed, Error: err.Error()}
	}

	res := worktreenew.Run(s.DB, cfg, req.options(), func(st worktreenew.Step) {
		report(jobs.Step{
			Key: string(st.Key), Label: st.Label,
			Status: observedStatus(string(st.Status)), Detail: st.Detail,
		})
	})

	switch {
	case res.Err != nil:
		return jobs.Outcome{State: jobs.StateFailed, Error: res.Err.Error()}
	case res.Confirm != nil:
		question, err := json.Marshal(res.Confirm)
		if err != nil {
			return jobs.Outcome{State: jobs.StateFailed, Error: err.Error()}
		}
		return jobs.Outcome{State: jobs.StateNeedsAnswer, Question: question}
	}
	result, err := json.Marshal(createResult{Path: res.Path, Branch: res.Branch})
	if err != nil {
		return jobs.Outcome{State: jobs.StateFailed, Error: err.Error()}
	}
	return jobs.Outcome{State: jobs.StateSucceeded, Result: result}
}

// createResult is what a finished create leaves on the job: where the worktree
// is, so the UI can navigate to it.
type createResult struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
}

// answerCreateJob turns a yes/no into the request to replay. There is no
// server-side session: an answer is a flag on the whole request, and the
// runner reaches the same point again with it in hand.
func answerCreateJob(request, question json.RawMessage, yes bool) (json.RawMessage, bool, error) {
	var req createWorktreeRequest
	if err := json.Unmarshal(request, &req); err != nil {
		return nil, false, err
	}
	var c worktreenew.Confirm
	if err := json.Unmarshal(question, &c); err != nil {
		return nil, false, err
	}
	switch c.Key {
	case worktreenew.ConfirmReuseBranch:
		// Nothing else the create could do with a branch the user will not
		// reuse: the job simply ends.
		if !yes {
			return nil, true, nil
		}
		req.ReuseBranch = true
	case worktreenew.ConfirmResetToPR:
		// The branch was already reused to get this far; declining only
		// declines the reset, and must be recorded so the replay does not ask
		// again.
		req.ReuseBranch = true
		if yes {
			req.ResetToPR = true
		} else {
			req.DeclineReset = true
		}
	default:
		return nil, false, fmt.Errorf("unknown create question %q", c.Key)
	}
	next, err := json.Marshal(req)
	return next, false, err
}

// deleteJobKind is the worktree_delete kind: it runs internal/worktreedel and
// turns its force escalations into the job's questions.
func (s *Server) deleteJobKind() jobs.Kind {
	return jobs.Kind{
		Name: jobKindDelete,
		Plan: func(request json.RawMessage) []jobs.Step {
			// A request that will not decode runs nowhere; plan the steps a
			// bare delete shows and let Run report the failure.
			var req deleteWorktreeRequest
			_ = json.Unmarshal(request, &req)
			planned := worktreedel.Planned(req.options())
			steps := make([]jobs.Step, 0, len(planned))
			for _, st := range planned {
				steps = append(steps, jobs.Step{
					Key: string(st.Key), Label: st.Label, Status: jobs.StepStatus(st.Status),
				})
			}
			return steps
		},
		Run:    s.runDeleteJob,
		Answer: answerDeleteJob,
	}
}

func (s *Server) runDeleteJob(request json.RawMessage, report func(jobs.Step)) jobs.Outcome {
	var req deleteWorktreeRequest
	if err := json.Unmarshal(request, &req); err != nil {
		return jobs.Outcome{State: jobs.StateFailed, Error: err.Error()}
	}
	cfg, err := config.Load()
	if err != nil {
		return jobs.Outcome{State: jobs.StateFailed, Error: err.Error()}
	}

	res := worktreedel.Run(s.DB, cfg, req.options(), func(st worktreedel.Step) {
		report(jobs.Step{
			Key: string(st.Key), Label: st.Label,
			Status: observedStatus(string(st.Status)), Detail: st.Detail,
		})
	})

	if res.NeedsForce != "" {
		question, err := json.Marshal(deleteQuestion{Key: res.NeedsForce})
		if err != nil {
			return jobs.Outcome{State: jobs.StateFailed, Error: err.Error()}
		}
		return jobs.Outcome{State: jobs.StateNeedsAnswer, Question: question}
	}
	// A delete reports a failed cleanup step without failing the run as a
	// whole (stopping would strand more than carrying on), so the steps are
	// part of the verdict, not just res.Err.
	failed := res.Err != nil
	for _, st := range res.Steps {
		if st.Status == worktreedel.StatusFailed {
			failed = true
		}
	}
	if failed {
		out := jobs.Outcome{State: jobs.StateFailed}
		if res.Err != nil {
			out.Error = res.Err.Error()
		}
		return out
	}
	return jobs.Outcome{State: jobs.StateSucceeded}
}

// deleteQuestion is what a delete asks: which step needs a force. The step's
// label and detail are already on the job, so the key is the whole question.
type deleteQuestion struct {
	Key worktreedel.StepKey `json:"key"`
}

func answerDeleteJob(request, question json.RawMessage, yes bool) (json.RawMessage, bool, error) {
	var req deleteWorktreeRequest
	if err := json.Unmarshal(request, &req); err != nil {
		return nil, false, err
	}
	var q deleteQuestion
	if err := json.Unmarshal(question, &q); err != nil {
		return nil, false, err
	}
	switch q.Key {
	case worktreedel.StepRemoveDirectory:
		// Declining ends the job: nothing may be unregistered while its
		// directory is still on disk, so there is no reduced delete to run.
		if !yes {
			return nil, true, nil
		}
		req.ForceDirectory = true
	case worktreedel.StepDeleteBranch:
		// Declining the branch force is a replay without the branch delete,
		// not an end: the rest of the cleanup still has to complete.
		if yes {
			req.ForceBranch = true
		} else {
			req.DeleteBranch = false
		}
	default:
		return nil, false, fmt.Errorf("unknown delete question %q", q.Key)
	}
	next, err := json.Marshal(req)
	return next, false, err
}
