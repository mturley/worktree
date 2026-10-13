package webui

import (
	"errors"
	"net/http"
	"sort"
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
func (s *Server) resolveWatcherScope(r *http.Request) ([]watchedResource, bool, error) {
	all, err := s.allWatched()
	if err != nil {
		return nil, false, err
	}
	q := r.URL.Query()
	if res := q.Get("resource"); res != "" {
		typ, id, ok := strings.Cut(res, ":")
		if !ok || typ == "" || id == "" {
			return nil, false, errBadScope
		}
		for _, wr := range all {
			if wr.Type == typ && wr.ID == id {
				return []watchedResource{wr}, true, nil
			}
		}
		return []watchedResource{{Resource: watcher.Resource{Type: typ, ID: id}, Name: id}}, true, nil
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
		return out, true, nil
	}
	return all, false, nil
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
	scope, _, err := s.resolveWatcherScope(r)
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
