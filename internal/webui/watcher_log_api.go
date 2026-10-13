package webui

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
)

// Watcher log endpoints. Both are read-only and are called only by the
// watcher log modal while it is open — never on ordinary page loads.

type watchedResource struct {
	watcher.Resource
	Name      string
	Worktrees []string
	UpdatedAt string
}

var errBadScope = errors.New("resource must be <type>:<id>")

// allWatched returns every resource with a live worktree subscription, with
// the worktrees tracking it and its display name (custom → title → id).
func (s *Server) allWatched() ([]watchedResource, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	rows, err := s.DB.Query(`SELECT subscriber, resource_type, resource_id, COALESCE(resource_url,'')
		FROM watcher_subscriptions
		WHERE subscriber LIKE 'worktree:%' AND deleted_at IS NULL
		  AND resource_type IN ('pr','jira','slack') -- link resources are never polled
		  AND (expires_at IS NULL OR expires_at > ?)
		ORDER BY resource_type, resource_id, subscriber`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byKey := map[watcherdb.ResourceKey]*watchedResource{}
	var order []watcherdb.ResourceKey
	for rows.Next() {
		var sub string
		var r watcher.Resource
		if err := rows.Scan(&sub, &r.Type, &r.ID, &r.URL); err != nil {
			return nil, err
		}
		k := watcherdb.ResourceKey{Type: r.Type, ID: r.ID}
		wr, ok := byKey[k]
		if !ok {
			wr = &watchedResource{Resource: r}
			byKey[k] = wr
			order = append(order, k)
		}
		if p, ok := wdb.WorktreePathFromSubscriber(sub); ok {
			wr.Worktrees = append(wr.Worktrees, p)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]watchedResource, 0, len(order))
	for _, k := range order {
		wr := byKey[k]
		dto := resourceDTO{Type: wr.Type, ID: wr.ID, URL: wr.URL}
		if meta, err := watcherdb.GetResourceMeta(s.DB, wr.Type, wr.ID); err == nil && meta != nil {
			dto.CustomName = meta.CustomName
		}
		s.enrichResourceDTO(&dto)
		wr.Name = firstNonEmpty(dto.CustomName, dto.Title, wr.ID)
		wr.UpdatedAt = dto.UpdatedAt
		out = append(out, *wr)
	}
	return out, nil
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

// resolveWatcherScope applies ?resource=<type>:<id> (wins) or ?worktree=<path>.
// It returns the scoped list, the full watched list, and whether a scope applied.
func (s *Server) resolveWatcherScope(r *http.Request) (scope, all []watchedResource, scoped bool, err error) {
	all, err = s.allWatched()
	if err != nil {
		return nil, nil, false, err
	}
	q := r.URL.Query()
	if res := q.Get("resource"); res != "" {
		typ, id, ok := strings.Cut(res, ":")
		if !ok || typ == "" || id == "" {
			return nil, nil, false, errBadScope
		}
		for _, wr := range all {
			if wr.Type == typ && wr.ID == id {
				return []watchedResource{wr}, all, true, nil
			}
		}
		return []watchedResource{{Resource: watcher.Resource{Type: typ, ID: id}, Name: id}}, all, true, nil
	}
	if wt := q.Get("worktree"); wt != "" {
		want, _ := wdb.WorktreePathFromSubscriber(wdb.Subscriber(wt))
		var out []watchedResource
		for _, wr := range all {
			for _, p := range wr.Worktrees {
				if p == want {
					out = append(out, wr)
					break
				}
			}
		}
		return out, all, true, nil
	}
	return all, all, false, nil
}

type watchedResourceDTO struct {
	Type              string                        `json:"type"`
	ID                string                        `json:"id"`
	URL               string                        `json:"url,omitempty"`
	Name              string                        `json:"name"`
	Worktrees         []string                      `json:"worktrees"`
	Status            string                        `json:"status"`
	LastAttempt       string                        `json:"last_attempt,omitempty"`
	LastSuccess       string                        `json:"last_success,omitempty"`
	LastError         string                        `json:"last_error,omitempty"`
	ErrorMessage      string                        `json:"error_message,omitempty"`
	Detail            *watcherdb.ResourcePollDetail `json:"detail,omitempty"`
	ResourceUpdatedAt string                        `json:"resource_updated_at,omitempty"`
}

// handleWatchedResources: GET /api/watchers/resources — per-resource last
// poll status for the requested scope, failing resources first.
func (s *Server) handleWatchedResources(w http.ResponseWriter, r *http.Request) {
	scope, _, _, err := s.resolveWatcherScope(r)
	if errors.Is(err, errBadScope) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	rs := make([]watcher.Resource, len(scope))
	for i, wr := range scope {
		rs[i] = wr.Resource
	}
	statuses, err := watcherdb.GetResourcePollStatuses(s.DB, rs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]watchedResourceDTO, 0, len(scope))
	for _, wr := range scope {
		dto := watchedResourceDTO{Type: wr.Type, ID: wr.ID, URL: wr.URL, Name: wr.Name,
			Worktrees: wr.Worktrees, Status: "never", ResourceUpdatedAt: wr.UpdatedAt}
		if dto.Worktrees == nil {
			dto.Worktrees = []string{}
		}
		if st, ok := statuses[watcherdb.ResourceKey{Type: wr.Type, ID: wr.ID}]; ok {
			dto.LastAttempt, dto.LastSuccess, dto.LastError = st.LastAttempt, st.LastSuccess, st.LastError
			dto.ErrorMessage, dto.Detail = st.LastErrorMessage, st.Detail
			dto.Status = "ok"
			if st.Failing() {
				dto.Status = "error"
			}
		}
		out = append(out, dto)
	}
	rank := map[string]int{"error": 0, "ok": 1, "never": 2}
	sort.SliceStable(out, func(i, j int) bool {
		if rank[out[i].Status] != rank[out[j].Status] {
			return rank[out[i].Status] < rank[out[j].Status]
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	writeJSON(w, http.StatusOK, map[string]any{"resources": out})
}

type taggedResourceDTO struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Name string `json:"name"`
}

type pollLogEntryDTO struct {
	ID         int64               `json:"id"`
	TS         string              `json:"ts"`
	Source     string              `json:"source"`
	Level      string              `json:"level"`
	Kind       string              `json:"kind"`
	Message    string              `json:"message"`
	Method     string              `json:"method,omitempty"`
	Endpoint   string              `json:"endpoint,omitempty"`
	HTTPStatus int                 `json:"http_status,omitempty"`
	DurationMS int                 `json:"duration_ms,omitempty"`
	Bytes      int64               `json:"bytes,omitempty"`
	ErrorBody  string              `json:"error_body,omitempty"`
	Resources  []taggedResourceDTO `json:"resources"`
}

var validSources = map[string]bool{"github": true, "jira": true, "slack": true}

func parseID(q string) (int64, error) {
	if q == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(q, 10, 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("invalid id %q", q)
	}
	return n, nil
}

// handleWatcherLog: GET /api/watchers/log — watcher log entries, newest first.
func (s *Server) handleWatcherLog(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	bad := func(msg string) { writeError(w, http.StatusBadRequest, msg) }

	pq := watcherdb.PollLogQuery{Limit: 200}
	switch lv := q.Get("level"); lv {
	case "", "info":
	case "warn", "error":
		pq.MinLevel = lv
	default:
		bad("level must be info, warn, or error")
		return
	}
	for _, src := range q["source"] {
		if !validSources[src] {
			bad("unknown source " + src)
			return
		}
		pq.Sources = append(pq.Sources, src)
	}
	var err error
	if pq.AfterID, err = parseID(q.Get("after_id")); err != nil {
		bad(err.Error())
		return
	}
	if pq.BeforeID, err = parseID(q.Get("before_id")); err != nil {
		bad(err.Error())
		return
	}
	if l := q.Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > 500 {
			bad("limit must be 1..500")
			return
		}
		pq.Limit = n
	}

	scope, all, scoped, err := s.resolveWatcherScope(r)
	if errors.Is(err, errBadScope) {
		bad(err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	names := map[watcherdb.ResourceKey]string{}
	for _, wr := range scope {
		names[watcherdb.ResourceKey{Type: wr.Type, ID: wr.ID}] = wr.Name
	}
	if scoped {
		pq.ResourceScoped = true
		for _, wr := range scope {
			pq.Resources = append(pq.Resources, wr.Resource)
		}
		// Tags on scoped rows can name resources outside the scope (a GitHub
		// batch row lists every PR); resolve those names too.
		for _, wr := range all {
			names[watcherdb.ResourceKey{Type: wr.Type, ID: wr.ID}] = wr.Name
		}
	}

	entries, more, err := watcherdb.QueryPollLog(s.DB, pq)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]pollLogEntryDTO, 0, len(entries))
	for _, e := range entries {
		dto := pollLogEntryDTO{ID: e.ID, TS: e.TS, Source: e.Source, Level: e.Level, Kind: e.Kind,
			Message: e.Message, Method: e.Method, Endpoint: e.Endpoint, HTTPStatus: e.HTTPStatus,
			DurationMS: e.DurationMS, Bytes: e.Bytes, ErrorBody: e.ErrorBody,
			Resources: make([]taggedResourceDTO, 0, len(e.Resources))}
		for _, tr := range e.Resources {
			name := names[watcherdb.ResourceKey{Type: tr.Type, ID: tr.ID}]
			dto.Resources = append(dto.Resources, taggedResourceDTO{Type: tr.Type, ID: tr.ID, Name: firstNonEmpty(name, tr.ID)})
		}
		out = append(out, dto)
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": out, "has_more": more})
}
