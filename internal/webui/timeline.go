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

// eventIDsForResource returns the set of event ids linked to one resource.
// Resolving the set up front means handleWorktreeTimeline can skip
// non-matching events without paying the enricher's per-event cost on rows it
// would discard.
func (s *Server) eventIDsForResource(rtype, rid string) (map[string]struct{}, error) {
	rows, err := s.DB.Query(
		`SELECT event_id FROM watcher_event_resources WHERE resource_type = ? AND resource_id = ?`,
		rtype, rid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make(map[string]struct{})
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids[id] = struct{}{}
	}
	return ids, rows.Err()
}

// handleWorktreeTimeline: GET /api/worktree-timeline?path=<path>&limit=&before=&resource_type=&resource_id=
// A query param (not a path segment) is used because worktree paths contain
// slashes, which the Go 1.22 mux {wildcard} would split awkwardly.
//
// `before` is an exclusive RFC3339 cursor ("" = newest), matching
// handleGlobalTimeline. It is applied inside the reverse scan below rather
// than as a SQL clause, because this handler filters in memory — the
// resource filter and the cursor have to agree on which events they skip,
// or paging a filtered feed silently repeats rows.
func (s *Server) handleWorktreeTimeline(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	rtype := r.URL.Query().Get("resource_type")
	rid := r.URL.Query().Get("resource_id")
	if (rtype == "") != (rid == "") {
		writeError(w, http.StatusBadRequest, "resource_type and resource_id must be supplied together")
		return
	}
	var only map[string]struct{}
	if rtype != "" {
		var err error
		only, err = s.eventIDsForResource(rtype, rid)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
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
	before := r.URL.Query().Get("before") // exclusive RFC3339 cursor; "" = newest
	outCap := limit
	if len(evs) < outCap {
		outCap = len(evs)
	}
	out := make([]TimelineEvent, 0, outCap)
	enricher := s.newEventEnricher()
	// reverse (EventsForSubscriberSince returns ASC)
	for i := len(evs) - 1; i >= 0 && len(out) < limit; i-- {
		// Strictly less-than, so the event the cursor names is not repeated
		// as the first row of the next page. Shared limitation with
		// handleGlobalTimeline's SQL `e.ts < ?`: events sharing an identical
		// ts straddle a page boundary and the later ones are skipped. Not a
		// concern while the pollers stamp distinct ts values per event.
		if before != "" && evs[i].TS >= before {
			continue
		}
		if only != nil {
			if _, ok := only[evs[i].ID]; !ok {
				continue
			}
		}
		out = append(out, enricher.enrich(evs[i]))
	}
	writeJSON(w, http.StatusOK, timelineResponse{Events: out, NextCursor: cursorOf(out)})
}

func (s *Server) writeTimelineRows(w http.ResponseWriter, rows *sql.Rows, limit int) {
	out := make([]TimelineEvent, 0, limit)
	// An event can be linked to more than one resource in
	// watcher_event_resources (the join in handleGlobalTimeline yields one
	// row per resource). Dedupe here so each event id appears at most once
	// in the response; the resource kept is whichever row we saw first,
	// which is deterministic given the query's ORDER BY e.ts DESC.
	//
	// NOTE: because dedup happens after the SQL LIMIT is applied, a page can
	// come back under-filled if duplicate rows for the same event consume
	// slots that another distinct event would otherwise occupy. Today
	// (watcher writes exactly 1 resource per event) this never happens in
	// practice. If Phase 4 (Slack) starts linking multiple resources to a
	// single event, revisit this with a query-level GROUP BY / windowed
	// subquery that picks one resource per event before LIMIT is applied.
	enricher := s.newEventEnricher()
	seen := make(map[string]bool, limit)
	for rows.Next() {
		var te TimelineEvent
		if err := rows.Scan(&te.ID, &te.TS, &te.ExternalTS, &te.Source, &te.Type,
			&te.Title, &te.Body, &te.Author, &te.ResourceType, &te.ResourceID, &te.ResourceURL); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if seen[te.ID] {
			continue
		}
		seen[te.ID] = true
		te.TypeLabel = watcher.EventType(te.Type).DisplayName()
		enricher.fillResource(&te)
		out = append(out, te)
	}
	writeJSON(w, http.StatusOK, timelineResponse{Events: out, NextCursor: cursorOf(out)})
}

// eventEnricher turns raw events into TimelineEvent DTOs for ONE request.
//
// Its whole reason to exist is lifetime. The per-event work it replaces was
// dominated not by queries but by rebuilding a constant: worktreesWatching
// called registry.List and then wdb.Subscriber — which runs
// filepath.EvalSymlinks, a filesystem syscall — for every worktree, for every
// event. On real data that was ~96µs of the ~107µs spent per event, i.e. ~90%
// of the cost was recomputing one map, and it grew with worktrees × events.
//
// IMPORTANT: build one per request (see newEventEnricher) and let it go with
// the response. Do NOT hang it off Server. Its maps would then need
// invalidating on every title and subscription change — including writes made
// by a DIFFERENT PROCESS (`worktree add`, `worktree resources set-name`, and
// agent-handler shelling out to the CLI all write this same SQLite file),
// which this server cannot observe at all. At request scope there is nothing
// to invalidate: the next request builds a fresh one.
//
// A side benefit: a page now renders from a single consistent snapshot.
// Previously each event looked its resource up at a slightly different
// instant, so a concurrent poll could produce one page mixing old and new
// values.
type eventEnricher struct {
	s *Server
	// canonical subscriber -> branch, for every registered worktree. Built
	// once: it is identical for every event on the page.
	branchBySub map[string]string
	// memoised per resource key. A page of 50 events typically touches only
	// ~12 distinct resources.
	titles   map[string]string
	watching map[string][]string
}

func (s *Server) newEventEnricher() *eventEnricher {
	e := &eventEnricher{
		s:           s,
		branchBySub: map[string]string{},
		titles:      map[string]string{},
		watching:    map[string][]string{},
	}
	// A registry read failure leaves branchBySub empty, which degrades to
	// "no worktrees attributed" — the same outcome the old per-event code
	// produced on error, and not worth failing a whole page over.
	if entries, err := registry.List(s.DB); err == nil {
		for _, ent := range entries {
			e.branchBySub[wdb.Subscriber(ent.Path)] = ent.Branch
		}
	}
	return e
}

// enrich maps a watcher.Event (+ its single resource, looked up) to a DTO.
func (e *eventEnricher) enrich(ev watcher.Event) TimelineEvent {
	te := TimelineEvent{
		ID: ev.ID, TS: ev.TS, Source: ev.Source, Type: string(ev.Type),
		TypeLabel: ev.Type.DisplayName(), Title: ev.Title,
	}
	if ev.ExternalTS != nil {
		te.ExternalTS = *ev.ExternalTS
	}
	if ev.Body != nil {
		te.Body = *ev.Body
	}
	if ev.Author != nil {
		te.Author = *ev.Author
	}
	// Resolve the event's resource(s) for scoped view.
	e.s.DB.QueryRow(`SELECT resource_type, resource_id, COALESCE(resource_url,'')
		FROM watcher_event_resources WHERE event_id = ? LIMIT 1`, ev.ID).
		Scan(&te.ResourceType, &te.ResourceID, &te.ResourceURL)
	e.fillResource(&te)
	return te
}

// fillResource adds the resource-derived fields to an event whose resource
// columns are already populated (the global timeline gets them from its join).
func (e *eventEnricher) fillResource(te *TimelineEvent) {
	te.ResourceTitle = e.resourceTitle(te.ResourceType, te.ResourceID)
	te.Worktrees = e.worktreesWatching(te.ResourceType, te.ResourceID)
}

func (e *eventEnricher) resourceTitle(rtype, rid string) string {
	if rtype == "" || rid == "" {
		return ""
	}
	key := rtype + ":" + rid
	if t, ok := e.titles[key]; ok {
		return t
	}
	title := ""
	if st, err := watcherdb.GetResourceState(e.s.DB, rtype, rid); err == nil && st != nil {
		var m map[string]any
		if json.Unmarshal([]byte(st.StateJSON), &m) == nil {
			if t, ok := m["title"].(string); ok {
				title = t
			}
		}
	}
	e.titles[key] = title
	return title
}

// worktreesWatching returns the branch names of worktrees currently watching
// the resource (empty slice if none / archived). It matches on the CANONICAL
// subscriber (wdb.Subscriber of each registry path) because watcher_subscriptions
// store canonical subscribers while the worktrees table stores raw paths — the
// map for that is built once per request, in newEventEnricher.
//
// The returned slice is shared with any later event on the same resource;
// callers marshal it and must not mutate it.
func (e *eventEnricher) worktreesWatching(rtype, rid string) []string {
	out := []string{}
	if rtype == "" || rid == "" {
		return out
	}
	key := rtype + ":" + rid
	if w, ok := e.watching[key]; ok {
		return w
	}
	subs, err := watcherdb.SubscribersOf(e.s.DB, rtype, rid) // []Subscription
	if err != nil {
		return out
	}
	seen := map[string]bool{}
	for _, sub := range subs {
		if sub.DeletedAt != nil { // only active subscriptions attribute
			continue
		}
		if b, ok := e.branchBySub[sub.Subscriber]; ok && !seen[b] {
			seen[b] = true
			out = append(out, b)
		}
	}
	sort.Strings(out)
	e.watching[key] = out
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
