package webui

import (
	"database/sql"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/selfid"
	"github.com/mturley/worktree/internal/tasks"
	"github.com/mturley/worktree/internal/unread"
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
	// Filesystem paths for Worktrees, same order. The UI routes by path, and
	// branch names are not unique across repos, so it cannot map one to the
	// other on its own.
	WorktreePaths []string `json:"worktree_paths"`
	// Archived marks a task event whose task is archived (it has links and
	// every one is gone). Watcher events leave it false: theirs is inferred
	// from having no watching worktree.
	Archived bool `json:"archived,omitempty"`
	// TaskState is the state a task event left its task in: a state change's
	// new state, or "not_started" for a creation. The feed draws that
	// checkbox for the event. Empty for every other event.
	TaskState string `json:"task_state,omitempty"`
	// The event's resource, enriched from cached state exactly as the
	// resource cards are. Present so the global timeline — which has no
	// per-worktree resource list to look anything up in — can render the
	// resource with its real status icon and custom name.
	Resource *resourceDTO `json:"resource,omitempty"`
	// Unread is true when this event is newer than its resource's read
	// cursor — Slack's own cursor for a thread, worktree's for everything
	// else. See unreadIndex.IsUnread.
	Unread bool `json:"unread,omitempty"`
	// Match says why the event matched the `q` search; absent without q.
	Match *searchMatch `json:"match,omitempty"`
	// LinkedToTask is set only by the task activity feed: the event is
	// linked to the task whose feed it is (see tasks_detail_api.go).
	LinkedToTask bool `json:"linked_to_task,omitempty"`
	// LinkedKey is the event-link key it is linked under, with LinkedToTask:
	// the key to unlink it by (a Slack message's slack: key, which the
	// client cannot derive from the row's id; any other event's ev: key).
	LinkedKey string `json:"linked_key,omitempty"`
	// authorID is the event's watcher author_id, used only to leave the
	// user's own events out of unread (internal/selfid). Not sent.
	authorID string `json:"-"`
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

// parseResourceTypes reads the repeated/comma-separated `resource_types`
// filter ("pr", "jira", "slack", "task"). "task" selects task events (see
// mergeTaskEvents); as a watcher resource type it matches no row, so a
// filter of only "task" leaves the watcher side empty. Empty means no
// filter — an explicit
// all-off state is not representable and does not need to be: the UI treats
// "nothing selected" as "show everything".
//
// Unknown values are dropped rather than passed to SQL, so a typo cannot
// produce a query that silently matches nothing.
func parseResourceTypes(r *http.Request) []string {
	known := map[string]bool{"pr": true, "jira": true, "slack": true, taskResourceType: true}
	seen := map[string]bool{}
	out := []string{}
	for _, raw := range r.URL.Query()["resource_types"] {
		for _, v := range strings.Split(raw, ",") {
			v = strings.TrimSpace(v)
			if known[v] && !seen[v] {
				seen[v] = true
				out = append(out, v)
			}
		}
	}
	return out
}

// eventTypeFilter is the `event_types` filter: the Activity feed's per-source
// subfilters ("Comments", "CI", …). Each value is either an exact event type
// ("pr_comment") or a prefix ending in `*` ("ci_*"). The prefix form exists
// for CI, whose variants the library keeps adding (ci_check_failed,
// ci_workflows_partial_failure, …): enumerating them in the UI would silently
// drop any new one from the "CI" subfilter until the UI caught up.
//
// Empty means no filter, as with resource_types.
type eventTypeFilter struct {
	exact    []string
	prefixes []string
}

// eventTypeValue is what a value must look like to be accepted. Event types
// are lower_snake; anything else is dropped rather than passed on, for the
// same reason parseResourceTypes drops unknown sources — a typo should widen
// the feed, not quietly empty it.
var eventTypeValue = regexp.MustCompile(`^[a-z][a-z0-9_]*\*?$`)

func parseEventTypes(r *http.Request) eventTypeFilter {
	var f eventTypeFilter
	seen := map[string]bool{}
	for _, raw := range r.URL.Query()["event_types"] {
		for _, v := range strings.Split(raw, ",") {
			v = strings.TrimSpace(v)
			if !eventTypeValue.MatchString(v) || seen[v] {
				continue
			}
			seen[v] = true
			if p, ok := strings.CutSuffix(v, "*"); ok {
				f.prefixes = append(f.prefixes, p)
			} else {
				f.exact = append(f.exact, v)
			}
		}
	}
	return f
}

func (f eventTypeFilter) empty() bool { return len(f.exact) == 0 && len(f.prefixes) == 0 }

// taskEventCategory is the `event_types` value of the "Task activity"
// category: it selects every task event (task_* and subtask_* alike). No
// watcher event has this type, so it matches nothing on the watcher side.
const taskEventCategory = "task"

// includesTasks reports whether task events pass the filter: always when it
// is empty, else only when the task category is selected.
func (f eventTypeFilter) includesTasks() bool {
	return f.empty() || slices.Contains(f.exact, taskEventCategory)
}

// matches is the Go twin of sql, for the worktree timeline's in-memory scan.
func (f eventTypeFilter) matches(t string) bool {
	if f.empty() {
		return true
	}
	if slices.Contains(f.exact, t) {
		return true
	}
	for _, p := range f.prefixes {
		if strings.HasPrefix(t, p) {
			return true
		}
	}
	return false
}

// sql returns an `AND (...)` clause over e.type and its args, or "" when the
// filter is empty. Prefixes go through LIKE with `_` and `%` escaped — `_` is
// a LIKE wildcard and every event type is full of them, so an unescaped
// "ci_" would also match "cix…".
func (f eventTypeFilter) sql() (string, []any) {
	if f.empty() {
		return "", nil
	}
	parts := []string{}
	args := []any{}
	if len(f.exact) > 0 {
		parts = append(parts, "e.type IN ("+strings.TrimSuffix(strings.Repeat("?,", len(f.exact)), ",")+")")
		for _, t := range f.exact {
			args = append(args, t)
		}
	}
	esc := strings.NewReplacer(`\`, `\\`, `_`, `\_`, `%`, `\%`)
	for _, p := range f.prefixes {
		parts = append(parts, `e.type LIKE ? ESCAPE '\'`)
		args = append(args, esc.Replace(p)+"%")
	}
	return "AND (" + strings.Join(parts, " OR ") + ") ", args
}

// unreadOnlyClause narrows the global timeline to unread events in SQL.
//
// It is a SECOND implementation of unreadIndex.IsUnread, and must agree with
// it event for event (TestGlobalTimelineUnreadOnlyMatchesIsUnread pins the
// two together). It has to live in SQL because this handler pages with LIMIT:
// filtering the rows afterwards would return short or empty pages while
// unread events still sat further back.
//
// The two clocks are kept apart exactly as IsUnread keeps them:
//   - non-Slack: e.ts against worktree's own cursor row; no row means read.
//   - Slack: e.external_ts against the poller-cached last_read, via
//     unread.SlackNewerSQL — shared with unread.SlackCounts, so a thread's
//     count and this filter cannot disagree.
const unreadOnlyClause = `AND (
    (er.resource_type <> 'slack' AND EXISTS (
        SELECT 1 FROM resource_read_cursor c
         WHERE c.resource_type = er.resource_type AND c.resource_id = er.resource_id
           AND e.ts > c.last_read_ts))
 OR (er.resource_type = 'slack' AND EXISTS (
        SELECT 1 FROM watcher_resource_state rs
         WHERE rs.resource_type = 'slack' AND rs.resource_id = er.resource_id
           AND ` + unread.SlackNewerSQL + `))
) AND ` + selfid.NotMineSQL + `
  AND ` + unread.NotPendingCISQL + ` `

// handleGlobalTimeline: GET /api/timeline?archived=&limit=&before=&resource_types=&event_types=&unread_only=&q=
func (s *Server) handleGlobalTimeline(w http.ResponseWriter, r *http.Request) {
	archived := r.URL.Query().Get("archived") == "true"
	unreadOnly := r.URL.Query().Get("unread_only") == "true"
	limit := parseLimit(r)
	before := r.URL.Query().Get("before") // RFC3339 ts; "" = newest
	types := parseResourceTypes(r)
	eventTypes := parseEventTypes(r)
	eventTypeClause, eventTypeArgs := eventTypes.sql()
	terms := parseSearchTerms(r.URL.Query().Get("q"))
	searchClause, searchArgs := searchSQL(terms)

	var (
		rows *sql.Rows
		err  error
	)
	base := `
SELECT DISTINCT e.id, e.ts, COALESCE(e.external_ts,''), e.source, e.type,
       COALESCE(e.title,''), COALESCE(e.body,''), COALESCE(e.author,''), COALESCE(e.author_id,''),
       er.resource_type, er.resource_id, COALESCE(er.resource_url,'')
FROM watcher_events e
JOIN watcher_event_resources er ON er.event_id = e.id `
	// "Watched" means followed by a worktree: a task: blocker hold keeps a
	// resource polled but never makes it watched (see tasks.HoldSubscriber).
	watchedJoin := `JOIN watcher_subscriptions s
       ON s.resource_type = er.resource_type AND s.resource_id = er.resource_id
       AND s.deleted_at IS NULL AND s.subscriber LIKE 'worktree:%' `
	filter := `WHERE e.type NOT IN ('watch_started','watcher_error') `
	order := `ORDER BY e.ts DESC LIMIT ?`

	beforeClause := ""
	if before != "" {
		beforeClause = "AND e.ts < ? "
	}
	// Placeholders are generated from the count of ALREADY-VALIDATED values,
	// never by interpolating the values themselves.
	typeClause := ""
	if len(types) > 0 {
		typeClause = "AND er.resource_type IN (" + strings.TrimSuffix(strings.Repeat("?,", len(types)), ",") + ") "
	}

	unreadClause := ""
	if unreadOnly {
		unreadClause = unreadOnlyClause
	}

	// restArgs are the args of every clause after the cursor's.
	restArgs := []any{}
	for _, t := range types {
		restArgs = append(restArgs, t)
	}
	restArgs = append(restArgs, eventTypeArgs...)
	restArgs = append(restArgs, searchArgs...)
	args := []any{}
	if before != "" {
		args = append(args, before)
	}
	args = append(args, restArgs...)
	args = append(args, limit)

	from := base
	if !archived {
		from = base + watchedJoin
	}
	rest := typeClause + eventTypeClause + searchClause + unreadClause
	q := from + filter + beforeClause + rest + order
	rows, err = s.DB.Query(q, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	out, err := s.collectTimelineRows(rows, limit, terms)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// A full page may have cut through a same-second cluster: read the rest
	// of it with the same filters, `e.ts = <boundary>` in place of the cursor
	// and the LIMIT, so the page overfills (see mergeTaskEvents).
	if len(out) >= limit {
		tieArgs := append([]any{out[len(out)-1].TS}, restArgs...)
		tieRows, err := s.DB.Query(from+filter+"AND e.ts = ? "+rest+"ORDER BY e.ts DESC", tieArgs...)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		ties, err := s.collectTimelineRows(tieRows, 0, terms)
		tieRows.Close()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		out = appendUnseen(out, ties)
	}
	// Every non-deleted task's events, whatever `archived` says: archived
	// only governs watcher events.
	out, err = s.mergeTaskEvents(out, taskFeedQuery{
		include:    taskEventsSelected(types, eventTypes),
		before:     before,
		limit:      limit,
		unreadOnly: unreadOnly,
		terms:      terms,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeTimeline(w, out)
}

// taskResourceType is the pseudo-resource type task events are attributed
// to, and the `resource_types` value that selects them.
const taskResourceType = "task"

// taskEventsSelected reports whether the source and event-type filters let
// task events through: an empty filter does, a non-empty one only when it
// names tasks.
func taskEventsSelected(types []string, eventTypes eventTypeFilter) bool {
	if len(types) > 0 && !slices.Contains(types, taskResourceType) {
		return false
	}
	return eventTypes.includesTasks()
}

// taskFeedQuery is the task side of a timeline page, mirroring the filters
// the watcher side was read with.
type taskFeedQuery struct {
	include    bool    // false = the filters exclude task events
	taskIDs    []int64 // nil = every non-deleted task (see tasks.FeedQuery)
	before     string  // exclusive ts cursor, as the watcher side's
	limit      int
	unreadOnly bool
	terms      []string
}

// mergeTaskEvents merges the task events q selects into a page of watcher
// rows (newest first: q.limit rows plus any tying the last one's ts),
// returning the newest q.limit of the union, ts DESC, a tie putting the
// watcher row first, OVERFILLED with every remaining row of either side
// whose ts equals the last kept row's. Both sides apply the same strict
// `before`, so the page's last ts (cursorOf) pages both; the overfill is
// what keeps that strict cursor from skipping the rest of a same-second
// cluster (task ts values have one-second resolution). An overfull page is
// safe: useTimeline treats only a short page as the end.
//
// Each side brings its whole boundary cluster (the watcher side via
// watcherTies or the worktree scan, the task side via FeedQuery.AtTS), so
// every row tying the merged page's boundary is at hand.
//
// unread_only and q are applied in Go, so with either set every candidate
// task event is read rather than the newest q.limit: a LIMIT before the
// filter would short a page while matching events sat further back. Task
// history is small next to watcher history, so this stays cheap.
func (s *Server) mergeTaskEvents(rows []TimelineEvent, q taskFeedQuery) ([]TimelineEvent, error) {
	if !q.include {
		return rows, nil
	}
	fq := tasks.FeedQuery{TaskIDs: q.taskIDs, Before: q.before, Limit: q.limit, UnreadActorsOnly: q.unreadOnly}
	if q.unreadOnly || len(q.terms) > 0 {
		fq.Limit = 0
	}
	evs, err := tasks.FeedEvents(s.DB, fq)
	if err != nil {
		return nil, err
	}
	// A LIMIT can cut through a same-second cluster; read the rest of it, so
	// the page can overfill with every row at its boundary ts. FeedEvents
	// orders ties by id DESC, so the rows the cut left out are those with a
	// smaller id than the last one read.
	if fq.Limit > 0 && len(evs) == fq.Limit {
		last := evs[len(evs)-1]
		tq := fq
		tq.Before, tq.Limit, tq.AtTS = "", 0, last.TS
		ties, err := tasks.FeedEvents(s.DB, tq)
		if err != nil {
			return nil, err
		}
		for _, fe := range ties {
			if fe.ID < last.ID {
				evs = append(evs, fe)
			}
		}
	}
	if len(evs) == 0 {
		return rows, nil
	}
	cursors, err := unread.Cursors(s.DB)
	if err != nil {
		return nil, err
	}
	// Each task's links, implicit worktrees and archived state, for the
	// rows' worktree badges (fillTaskWorktrees).
	all, err := tasks.List(s.DB, tasks.Filter{IncludeCompleted: true, IncludeArchived: true})
	if err != nil {
		return nil, err
	}
	byTask := make(map[int64]tasks.Task, len(all))
	for _, t := range all {
		byTask[t.ID] = t
	}
	enr := s.newEventEnricher()
	taskRows := make([]TimelineEvent, 0, len(evs))
	for _, fe := range evs {
		// Past q.limit rows, keep only those tying the last one's ts.
		if len(taskRows) >= q.limit && fe.TS < taskRows[len(taskRows)-1].TS {
			break
		}
		te := taskFeedRow(fe, cursors)
		if t, ok := byTask[fe.TaskID]; ok {
			enr.fillTaskWorktrees(&te, t)
		}
		if q.unreadOnly && !te.Unread {
			continue
		}
		if len(q.terms) > 0 {
			if te.Match = matchTaskEvent(&te, q.terms); te.Match == nil {
				continue
			}
		}
		taskRows = append(taskRows, te)
	}
	out := make([]TimelineEvent, 0, min(q.limit, len(rows)+len(taskRows)))
	i, j := 0, 0
	for i < len(rows) || j < len(taskRows) {
		fromRows := j == len(taskRows) || (i < len(rows) && rows[i].TS >= taskRows[j].TS)
		var next *TimelineEvent
		if fromRows {
			next = &rows[i]
		} else {
			next = &taskRows[j]
		}
		// Full: overfill only with rows tying the boundary ts (see overfill).
		if len(out) >= q.limit && next.TS != out[len(out)-1].TS {
			break
		}
		out = append(out, *next)
		if fromRows {
			i++
		} else {
			j++
		}
	}
	return out, nil
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

// handleWorktreeTimeline: GET /api/worktree-timeline?path=<path>&limit=&before=&resource_type=&resource_id=&resource_types=&event_types=&unread_only=&q=
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
	types := parseResourceTypes(r)
	eventTypes := parseEventTypes(r)
	unreadOnly := r.URL.Query().Get("unread_only") == "true"
	terms := parseSearchTerms(r.URL.Query().Get("q"))
	typeAllowed := map[string]bool{}
	for _, t := range types {
		typeAllowed[t] = true
	}
	outCap := limit
	if len(evs) < outCap {
		outCap = len(evs)
	}
	out := make([]TimelineEvent, 0, outCap)
	enricher := s.newEventEnricher()
	// reverse (EventsForSubscriberSince returns ASC)
	for i := len(evs) - 1; i >= 0; i-- {
		// Full: keep scanning only for rows tying the last kept row's ts, so
		// the page overfills with the rest of a same-second cluster and the
		// strict cursor below cannot skip it (see mergeTaskEvents).
		if len(out) >= limit && evs[i].TS < out[len(out)-1].TS {
			break
		}
		// Strictly less-than, so the event the cursor names is not repeated
		// as the first row of the next page.
		if before != "" && evs[i].TS >= before {
			continue
		}
		if only != nil {
			if _, ok := only[evs[i].ID]; !ok {
				continue
			}
		}
		// Before enrichment: the type is on the raw event, so a filtered-out
		// row costs nothing.
		if !eventTypes.matches(string(evs[i].Type)) {
			continue
		}
		te := enricher.enrich(evs[i])
		// Applied after enrichment because the resource type comes from the
		// event's resource row, which enrich resolves.
		if len(typeAllowed) > 0 && !typeAllowed[te.ResourceType] {
			continue
		}
		// Applied before the limit check counts the row, so an unread-only
		// page is a full page of unread events. te.Unread is IsUnread's own
		// verdict, so this filter cannot disagree with the feed's markers.
		if unreadOnly && !te.Unread {
			continue
		}
		// After enrichment: the resource's custom name and cached title are
		// searchable, and enrich is what resolves them. Before the append,
		// so `limit` counts matching rows only.
		if len(terms) > 0 {
			if te.Match = matchEvent(&te, terms); te.Match == nil {
				continue
			}
		}
		out = append(out, te)
	}
	// The worktree's scope (linked directly or implicitly, plus the archived
	// fallback), or with a resource filter the tasks linking that resource.
	scope := tasks.Scope{Kind: tasks.ScopeWorktree, Worktree: path}
	if rtype != "" {
		scope = tasks.Scope{Kind: tasks.ScopeResource, ResourceType: rtype, ResourceID: rid}
	}
	q := taskFeedQuery{
		include:    taskEventsSelected(types, eventTypes),
		before:     before,
		limit:      limit,
		unreadOnly: unreadOnly,
		terms:      terms,
	}
	if q.include {
		if q.taskIDs, err = tasks.ScopeTaskIDs(s.DB, scope); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if out, err = s.mergeTaskEvents(out, q); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeTimeline(w, out)
}

// writeTimeline writes a timeline page, its cursor the last row's ts.
func writeTimeline(w http.ResponseWriter, out []TimelineEvent) {
	writeJSON(w, http.StatusOK, timelineResponse{Events: out, NextCursor: cursorOf(out)})
}

// collectTimelineRows reads the global timeline's watcher rows into enriched
// DTOs, at most limit, each event once.
func (s *Server) collectTimelineRows(rows *sql.Rows, limit int, terms []string) ([]TimelineEvent, error) {
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
	//
	// IMPORTANT: read every row and close rows BEFORE enriching. The
	// enricher queries the DB, and a query issued while these rows are open
	// deadlocks against any writer under SQLite's rollback journal: the open
	// rows hold SHARED, the writer's commit holds PENDING waiting on them, and
	// the enricher's query waits on the writer. All three stall until
	// busy_timeout and fail with SQLITE_BUSY (see
	// TestGlobalTimelineQueriesNothingWhileRowsAreOpen).
	seen := make(map[string]bool, limit)
	for rows.Next() {
		var te TimelineEvent
		if err := rows.Scan(&te.ID, &te.TS, &te.ExternalTS, &te.Source, &te.Type,
			&te.Title, &te.Body, &te.Author, &te.authorID, &te.ResourceType, &te.ResourceID, &te.ResourceURL); err != nil {
			return nil, err
		}
		if seen[te.ID] {
			continue
		}
		seen[te.ID] = true
		te.TypeLabel = watcher.EventType(te.Type).DisplayName()
		out = append(out, te)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	enricher := s.newEventEnricher()
	for i := range out {
		enricher.fillResource(&out[i])
		out[i].Match = matchEvent(&out[i], terms)
	}
	return out, nil
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
	// canonical subscriber -> worktree, for every registered worktree. Built
	// once: it is identical for every event on the page.
	worktreeBySub map[string]watchingWorktree
	// memoised per resource key. A page of 50 events typically touches only
	// ~12 distinct resources.
	resources map[string]*resourceDTO
	watching  map[string][]watchingWorktree
	unread    *unreadIndex
}

// watchingWorktree is one worktree that follows a resource: the branch the UI
// shows, and the path it routes by.
type watchingWorktree struct {
	Branch string
	Path   string
}

func (s *Server) newEventEnricher() *eventEnricher {
	e := &eventEnricher{
		s:             s,
		worktreeBySub: map[string]watchingWorktree{},
		resources:     map[string]*resourceDTO{},
		watching:      map[string][]watchingWorktree{},
		unread:        s.newUnreadIndex(),
	}
	// A registry read failure leaves worktreeBySub empty, which degrades to
	// "no worktrees attributed" — the same outcome the old per-event code
	// produced on error, and not worth failing a whole page over.
	if entries, err := registry.List(s.DB); err == nil {
		for _, ent := range entries {
			e.worktreeBySub[wdb.Subscriber(ent.Path)] = watchingWorktree{Branch: ent.Branch, Path: ent.Path}
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
	if ev.AuthorID != nil {
		te.authorID = *ev.AuthorID
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
	if dto := e.resource(te.ResourceType, te.ResourceID); dto != nil {
		te.Resource = dto
		// Kept alongside Resource: existing consumers read this directly, and
		// it is the plain-text fallback when no chip is shown.
		te.ResourceTitle = dto.Title
		te.Title = slackEventTitle(te.Source, te.Type, te.Title, dto)
	}
	te.Unread = e.unread.IsUnread(te.ResourceType, te.ResourceID, te.TS, te.ExternalTS, te.Type, te.Source, te.authorID)
	wts := e.worktreesWatching(te.ResourceType, te.ResourceID)
	te.Worktrees = make([]string, 0, len(wts))
	te.WorktreePaths = make([]string, 0, len(wts))
	for _, w := range wts {
		te.Worktrees = append(te.Worktrees, w.Branch)
		te.WorktreePaths = append(te.WorktreePaths, w.Path)
	}
}

// fillTaskWorktrees names, by branch, the worktrees a task event's task
// belongs to: its live worktree links and the worktrees following its
// resource links (Implicit), as fillResource does for a watcher event. It
// also carries the task's archived state: without it the UI would read "no
// worktrees" as archived, which is wrong for a global task.
func (e *eventEnricher) fillTaskWorktrees(te *TimelineEvent, t tasks.Task) {
	te.Archived = t.Archived
	seen := map[string]bool{}
	wts := []watchingWorktree{}
	add := func(p string) {
		if w, ok := e.worktreeBySub[wdb.Subscriber(p)]; ok && !seen[w.Path] {
			seen[w.Path] = true
			wts = append(wts, w)
		}
	}
	for _, l := range t.Links {
		if l.Kind == tasks.LinkWorktree && !l.Archived {
			add(l.Worktree)
		}
	}
	for _, p := range t.Implicit {
		add(p)
	}
	sort.Slice(wts, func(i, j int) bool { return wts[i].Branch < wts[j].Branch })
	te.Worktrees = make([]string, 0, len(wts))
	te.WorktreePaths = make([]string, 0, len(wts))
	for _, w := range wts {
		te.Worktrees = append(te.Worktrees, w.Branch)
		te.WorktreePaths = append(te.WorktreePaths, w.Path)
	}
}

// slackEventTitle re-renders a Slack thread event's title against the thread's
// CURRENT name: the user's custom name, else the cached title.
//
// The watcher library bakes the thread's root text into the title when it
// emits the event ("New reply in <root text>"), so the stored title never
// reflects a custom name — a worktree concept, set before or after the event.
// Falling back to the cached title rather than the stored one also keeps
// events current when the root message is edited, and repairs events stored
// before watcher v0.14.1, which kept raw "<@U…>" mention tokens. Any other
// event — or a thread with no name to offer — keeps the title it was stored
// with.
func slackEventTitle(source, typ, title string, d *resourceDTO) string {
	if source != "slack" || d == nil {
		return title
	}
	name := d.CustomName
	if name == "" {
		name = d.Title
	}
	if name == "" {
		return title
	}
	switch watcher.EventType(typ) {
	case watcher.EventTypeSlackReply:
		return "New reply in " + name
	case watcher.EventTypeWatchStarted:
		return "Started watching thread: " + name
	}
	return title
}

// resource returns the event's resource as the same enriched DTO the resource
// cards use, memoised per request.
//
// It reuses enrichResourceDTO rather than parsing state_json again here: the
// icon a chip shows depends on fields (state, status, issue-type icon) that
// would otherwise have to be decoded in two places and kept in step.
func (e *eventEnricher) resource(rtype, rid string) *resourceDTO {
	if rtype == "" || rid == "" {
		return nil
	}
	key := rtype + ":" + rid
	if dto, ok := e.resources[key]; ok {
		return dto
	}
	dto := &resourceDTO{Type: rtype, ID: rid}
	// Custom name/description live in a separate table from cached state, and
	// the chip prefers a custom name over the fetched title.
	if meta, err := watcherdb.GetResourceMeta(e.s.DB, rtype, rid); err == nil && meta != nil {
		dto.CustomName = meta.CustomName
		dto.CustomDescription = meta.CustomDescription
	}
	e.s.enrichResourceDTO(dto)
	// Chips need no task counts, and fill's task part would load them on
	// every timeline request.
	e.unread.fillOwn(dto)
	e.resources[key] = dto
	return dto
}

// worktreesWatching returns the branch names of worktrees currently watching
// the resource (empty slice if none / archived). It matches on the CANONICAL
// subscriber (wdb.Subscriber of each registry path) because watcher_subscriptions
// store canonical subscribers while the worktrees table stores raw paths — the
// map for that is built once per request, in newEventEnricher.
//
// The returned slice is shared with any later event on the same resource;
// callers marshal it and must not mutate it.
func (e *eventEnricher) worktreesWatching(rtype, rid string) []watchingWorktree {
	out := []watchingWorktree{}
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
		if w, ok := e.worktreeBySub[sub.Subscriber]; ok && !seen[w.Path] {
			seen[w.Path] = true
			out = append(out, w)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Branch < out[j].Branch })
	e.watching[key] = out
	return out
}

// appendUnseen appends the events of more whose id out does not hold yet.
func appendUnseen(out, more []TimelineEvent) []TimelineEvent {
	seen := make(map[string]bool, len(out))
	for _, e := range out {
		seen[e.ID] = true
	}
	for _, e := range more {
		if !seen[e.ID] {
			seen[e.ID] = true
			out = append(out, e)
		}
	}
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
