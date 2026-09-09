package webui

import (
	"net/http"

	watcherdb "github.com/mturley/watcher/db"
)

// watcherSources maps each poller's name to the resource type the timeline
// filters by. The two vocabularies genuinely differ — the GitHub poller is
// named "github" but the resources it polls are type "pr" — and this is the
// single place that reconciles them. Duplicating the mapping in the frontend
// is how the GitHub toggle ends up silently statusless.
var watcherSources = []struct {
	Name string // poller name, as written to watcher_poller_status
	Type string // resource type, as used by the timeline's source filter
}{
	{Name: "github", Type: "pr"},
	{Name: "jira", Type: "jira"},
	{Name: "slack", Type: "slack"},
}

type watcherStatusDTO struct {
	Name string `json:"name"`
	Type string `json:"type"`
	// LastSuccess is the last time this poller completed a run without error,
	// RFC3339, or "" if it has never succeeded. Deliberately the last SUCCESS
	// rather than the last attempt: a fresh timestamp beside an error icon
	// reads as "just worked", which is the opposite of the truth.
	LastSuccess string `json:"last_success,omitempty"`
	// HasError is true when the last error is more recent than the last
	// success — the poller is currently failing, not merely has failed once.
	HasError     bool   `json:"has_error,omitempty"`
	ErrorMessage string `json:"error_message,omitempty"`
}

type watchersResponse struct {
	Watchers []watcherStatusDTO `json:"watchers"`
	// Polling reports whether a poll is running right now. It is server-wide,
	// not per watcher, because pollAll runs the three pollers sequentially
	// under one guard — there is no moment when "github is fetching" is true
	// and the others are independently answerable.
	Polling bool `json:"polling"`
}

// handleWatchers: GET /api/watchers — status of the three pollers.
//
// A source that has never run reports no LastSuccess and no error, which the
// UI renders as no annotation at all. That is the honest answer for a fresh
// install or an unconfigured source: "never" would imply something is wrong.
func (s *Server) handleWatchers(w http.ResponseWriter, r *http.Request) {
	out := watchersResponse{
		Watchers: make([]watcherStatusDTO, 0, len(watcherSources)),
		Polling:  s.pollInFlight.Load(),
	}
	for _, src := range watcherSources {
		dto := watcherStatusDTO{Name: src.Name, Type: src.Type}
		st, err := watcherdb.GetPollerStatus(s.DB, src.Name)
		if err != nil {
			if s.Logger != nil {
				s.Logger.Printf("GetPollerStatus(%s): %v", src.Name, err)
			}
			// Degrade to "nothing known" rather than failing the whole
			// response: two working watchers should still report.
			out.Watchers = append(out.Watchers, dto)
			continue
		}
		if st != nil {
			dto.LastSuccess = st.LastSuccess
			if watcherdb.HasPollerError(s.DB, src.Name) {
				dto.HasError = true
				dto.ErrorMessage = st.LastErrorMessage
			}
		}
		out.Watchers = append(out.Watchers, dto)
	}
	writeJSON(w, http.StatusOK, out)
}

// handleWatchersPoll: POST /api/watchers/poll — refresh all three now.
//
// Returns immediately rather than blocking for the length of a poll. The
// client's spinner is driven by the `polling` flag from GET /api/watchers, so
// it reflects the BACKGROUND loop's polls too, not only ones the user asked
// for — which is what "is anything fetching right now" should mean.
//
// A poll already in flight makes this a no-op (safePollAll's guard), and that
// is still a success: the caller asked for a refresh and one is happening.
func (s *Server) handleWatchersPoll(w http.ResponseWriter, r *http.Request) {
	go s.safePollAll()
	w.WriteHeader(http.StatusAccepted)
}
