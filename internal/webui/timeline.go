package webui

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
)

type TimelineEvent struct {
	ID            string   `json:"id"`
	TS            string   `json:"ts"`
	ExternalTS    string   `json:"external_ts"`
	Source        string   `json:"source"`
	Type          string   `json:"type"`
	TypeLabel     string   `json:"type_label"`
	Title         string   `json:"title"`
	Body          string   `json:"body"`
	Author        string   `json:"author"`
	ResourceType  string   `json:"resource_type"`
	ResourceID    string   `json:"resource_id"`
	ResourceURL   string   `json:"resource_url"`
	ResourceTitle string   `json:"resource_title"`
	Worktrees     []string `json:"worktrees"`
}

type timelineResponse struct {
	Events     []TimelineEvent `json:"events"`
	NextCursor string          `json:"next_cursor"`
}

const defaultTimelineLimit = 100

func parseLimit(r *http.Request) int {
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			return n
		}
	}
	return defaultTimelineLimit
}

// handleGlobalTimeline: GET /api/timeline?archived=&limit=&before=
func (s *Server) handleGlobalTimeline(w http.ResponseWriter, r *http.Request) {
	archived := r.URL.Query().Get("archived") == "true"
	limit := parseLimit(r)
	before := r.URL.Query().Get("before") // RFC3339 ts; "" = newest

	var (
		rows *sql.Rows
		err  error
	)
	base := `
SELECT DISTINCT e.id, e.ts, COALESCE(e.external_ts,''), e.source, e.type,
       COALESCE(e.title,''), COALESCE(e.body,''), COALESCE(e.author,''),
       er.resource_type, er.resource_id, COALESCE(er.resource_url,'')
FROM watcher_events e
JOIN watcher_event_resources er ON er.event_id = e.id `
	watchedJoin := `JOIN watcher_subscriptions s
       ON s.resource_type = er.resource_type AND s.resource_id = er.resource_id
       AND s.deleted_at IS NULL `
	filter := `WHERE e.type NOT IN ('watch_started','watcher_error') `
	order := `ORDER BY e.ts DESC LIMIT ?`

	beforeClause := ""
	args := []any{}
	if before != "" {
		beforeClause = "AND e.ts < ? "
	}

	if archived {
		q := base + filter + beforeClause + order
		if before != "" {
			args = append(args, before)
		}
		args = append(args, limit)
		rows, err = s.DB.Query(q, args...)
	} else {
		q := base + watchedJoin + filter + beforeClause + order
		if before != "" {
			args = append(args, before)
		}
		args = append(args, limit)
		rows, err = s.DB.Query(q, args...)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	s.writeTimelineRows(w, rows, limit)
}

// handleWorktreeTimeline: GET /api/worktree-timeline?path=<path>&limit=&before=
// A query param (not a path segment) is used because worktree paths contain
// slashes, which the Go 1.22 mux {wildcard} would split awkwardly.
func (s *Server) handleWorktreeTimeline(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	// Use the canonical subscriber key (Abs -> EvalSymlinks -> Clean) so this
	// matches the watcher_subscriptions rows written by resources.Add. A raw
	// "worktree:"+path concat would miss on macOS/symlinked homes.
	subscriber := wdb.Subscriber(path)
	// Full history reverse-chron: read ascending from epoch, reverse.
	evs, err := watcherdb.EventsForSubscriberSince(s.DB, subscriber, "1970-01-01T00:00:00Z")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	limit := parseLimit(r)
	out := make([]TimelineEvent, 0, len(evs))
	// reverse (EventsForSubscriberSince returns ASC)
	for i := len(evs) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, s.enrichEvent(evs[i]))
	}
	writeJSON(w, http.StatusOK, timelineResponse{Events: out, NextCursor: cursorOf(out)})
}

func (s *Server) writeTimelineRows(w http.ResponseWriter, rows *sql.Rows, limit int) {
	out := make([]TimelineEvent, 0, limit)
	for rows.Next() {
		var te TimelineEvent
		if err := rows.Scan(&te.ID, &te.TS, &te.ExternalTS, &te.Source, &te.Type,
			&te.Title, &te.Body, &te.Author, &te.ResourceType, &te.ResourceID, &te.ResourceURL); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		te.TypeLabel = watcher.EventType(te.Type).DisplayName()
		te.ResourceTitle = s.resourceTitle(te.ResourceType, te.ResourceID)
		te.Worktrees = s.worktreesWatching(te.ResourceType, te.ResourceID)
		out = append(out, te)
	}
	writeJSON(w, http.StatusOK, timelineResponse{Events: out, NextCursor: cursorOf(out)})
}

// enrichEvent maps a watcher.Event (+ its single resource, looked up) to a DTO.
func (s *Server) enrichEvent(e watcher.Event) TimelineEvent {
	te := TimelineEvent{
		ID: e.ID, TS: e.TS, Source: e.Source, Type: string(e.Type),
		TypeLabel: e.Type.DisplayName(), Title: e.Title,
	}
	if e.ExternalTS != nil {
		te.ExternalTS = *e.ExternalTS
	}
	if e.Body != nil {
		te.Body = *e.Body
	}
	if e.Author != nil {
		te.Author = *e.Author
	}
	// Resolve the event's resource(s) for scoped view.
	s.DB.QueryRow(`SELECT resource_type, resource_id, COALESCE(resource_url,'')
		FROM watcher_event_resources WHERE event_id = ? LIMIT 1`, e.ID).
		Scan(&te.ResourceType, &te.ResourceID, &te.ResourceURL)
	te.ResourceTitle = s.resourceTitle(te.ResourceType, te.ResourceID)
	te.Worktrees = s.worktreesWatching(te.ResourceType, te.ResourceID)
	return te
}

func (s *Server) resourceTitle(rtype, rid string) string {
	if rtype == "" || rid == "" {
		return ""
	}
	st, err := watcherdb.GetResourceState(s.DB, rtype, rid)
	if err != nil || st == nil {
		return ""
	}
	var m map[string]any
	if json.Unmarshal([]byte(st.StateJSON), &m) == nil {
		if t, ok := m["title"].(string); ok {
			return t
		}
	}
	return ""
}

// worktreesWatching returns the branch names of worktrees currently watching
// the resource (empty slice if none / archived). It matches on the CANONICAL
// subscriber (wdb.Subscriber of each registry path) because watcher_subscriptions
// store canonical subscribers while the worktrees table stores raw paths.
func (s *Server) worktreesWatching(rtype, rid string) []string {
	out := []string{}
	if rtype == "" || rid == "" {
		return out
	}
	subs, err := watcherdb.SubscribersOf(s.DB, rtype, rid) // []Subscription
	if err != nil {
		return out
	}
	// Build canonical-subscriber -> branch from the registry.
	entries, err := registry.List(s.DB)
	if err != nil {
		return out
	}
	branchBySub := make(map[string]string, len(entries))
	for _, e := range entries {
		branchBySub[wdb.Subscriber(e.Path)] = e.Branch
	}
	seen := map[string]bool{}
	for _, sub := range subs {
		if sub.DeletedAt != nil { // only active subscriptions attribute
			continue
		}
		if b, ok := branchBySub[sub.Subscriber]; ok && !seen[b] {
			seen[b] = true
			out = append(out, b)
		}
	}
	sort.Strings(out)
	return out
}

func cursorOf(evs []TimelineEvent) string {
	if len(evs) == 0 {
		return ""
	}
	return evs[len(evs)-1].TS
}

// latestEventTSForSubscriber returns the RFC3339 ts of the newest event for
// any resource this subscriber watches, or "" if none. Moved here from
// worktrees.go; callers pass a canonical subscriber (wdb.Subscriber(path)).
func latestEventTSForSubscriber(db *sql.DB, subscriber string) string {
	const q = `
SELECT COALESCE(MAX(e.ts), '')
FROM watcher_events e
JOIN watcher_event_resources er ON er.event_id = e.id
JOIN watcher_subscriptions s ON s.resource_type = er.resource_type AND s.resource_id = er.resource_id
WHERE s.subscriber = ? AND s.deleted_at IS NULL
  AND e.type NOT IN ('watch_started','watcher_error')`
	var ts string
	_ = db.QueryRow(q, subscriber).Scan(&ts)
	return ts
}
