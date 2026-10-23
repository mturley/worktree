package tasks

import (
	"database/sql"
	"fmt"
	"sort"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
)

// ScopeKind says which tasks a List is about.
type ScopeKind string

const (
	ScopeAll      ScopeKind = "all"
	ScopeWorktree ScopeKind = "worktree"
	ScopeResource ScopeKind = "resource"
)

// Scope narrows a List. The zero Scope is ScopeAll. Worktree may be any
// path; it is canonicalised.
type Scope struct {
	Kind                     ScopeKind
	Worktree                 string
	ResourceType, ResourceID string
}

// Filter selects tasks for List. The zero Filter is every open task.
type Filter struct {
	Scope            Scope
	IncludeCompleted bool
	IncludeArchived  bool       // only meaningful with IncludeCompleted
	Priorities       []Priority // empty = all
	// States narrows to these states (empty = all). It never widens:
	// selecting StateDone still needs IncludeCompleted.
	States      []State
	StarredOnly bool
}

type resKey struct{ typ, id string }

// List returns the tasks f selects, in master order (rank, then id), each
// with its links, implicit worktrees and archived state filled in.
//
// Membership is computed in Go over four small loads: every live task with
// its links, active and tombstoned `worktree:` subscriptions, and the
// registry. A worktree scope W includes a task that links W, follows W
// implicitly (W actively subscribes one of its resource links), or — when
// every link is archived — one W last followed (W is registered and holds a
// tombstoned subscription to one of its resource links).
func List(conn *sql.DB, f Filter) ([]Task, error) {
	return list(conn, f, nil)
}

func list(conn *sql.DB, f Filter, onlyID *int64) ([]Task, error) {
	sc := f.Scope
	switch sc.Kind {
	case "", ScopeAll:
	case ScopeWorktree:
		if sc.Worktree == "" {
			return nil, fmt.Errorf("%w: a worktree scope needs a path", ErrInvalid)
		}
		sc.Worktree = canonicalPath(sc.Worktree)
	case ScopeResource:
		if sc.ResourceType == "" || sc.ResourceID == "" {
			return nil, fmt.Errorf("%w: a resource scope needs a type and an id", ErrInvalid)
		}
	default:
		return nil, fmt.Errorf("%w: scope kind %q is not all, worktree or resource", ErrInvalid, sc.Kind)
	}
	var prio map[Priority]bool
	if len(f.Priorities) > 0 {
		prio = make(map[Priority]bool, len(f.Priorities))
		for _, p := range f.Priorities {
			if err := validPriority(p); err != nil {
				return nil, err
			}
			prio[p] = true
		}
	}
	var states map[State]bool
	if len(f.States) > 0 {
		states = make(map[State]bool, len(f.States))
		for _, s := range f.States {
			if err := validState(s); err != nil {
				return nil, err
			}
			states[s] = true
		}
	}

	c, err := compute(conn, onlyID)
	if err != nil {
		return nil, err
	}

	out := []Task{}
	for _, t := range c.tasks {
		if t.State == StateDone && (!f.IncludeCompleted || (t.Archived && !f.IncludeArchived)) {
			continue
		}
		if states != nil && !states[t.State] {
			continue
		}
		if prio != nil && !prio[t.Priority] {
			continue
		}
		if f.StarredOnly && !t.Starred {
			continue
		}
		if !c.inScope(t, sc) {
			continue
		}
		out = append(out, t)
	}
	return out, nil
}

// computed is every live task (or just one) with its links, subtasks,
// implicit worktrees and archived state filled in, plus what scope
// membership needs. It is the one membership compute path: List and
// OpenCounts both go through it.
type computed struct {
	tasks      []Task // master order
	tombstoned map[resKey]map[string]bool
	registered map[string]bool
}

func (c *computed) inScope(t Task, sc Scope) bool {
	return inScope(t, sc, c.tombstoned, c.registered)
}

func compute(conn *sql.DB, onlyID *int64) (*computed, error) {
	tasks, err := loadTasks(conn, onlyID)
	if err != nil {
		return nil, err
	}
	links, err := loadLinks(conn, onlyID)
	if err != nil {
		return nil, err
	}
	subtasks, err := loadSubtasks(conn, onlyID)
	if err != nil {
		return nil, err
	}
	blockerCounts, err := loadBlockerCounts(conn, onlyID)
	if err != nil {
		return nil, err
	}
	active, tombstoned, err := loadSubscriptions(conn)
	if err != nil {
		return nil, err
	}
	registered, err := loadRegistry(conn)
	if err != nil {
		return nil, err
	}

	for i := range tasks {
		t := &tasks[i]
		t.Links = links[t.ID]
		if t.Subtasks = subtasks[t.ID]; t.Subtasks == nil {
			t.Subtasks = []Subtask{}
		}
		t.BlockerCount = blockerCounts[t.ID]
		t.Blocked = t.BlockerCount > 0
		implicit := map[string]bool{}
		allArchived := len(t.Links) > 0
		for i := range t.Links {
			l := &t.Links[i]
			switch l.Kind {
			case LinkResource:
				subs := active[resKey{l.ResourceType, l.ResourceID}]
				l.Archived = len(subs) == 0
				for _, p := range subs {
					implicit[p] = true
				}
			case LinkWorktree:
				l.Archived = !registered[l.Worktree]
			}
			allArchived = allArchived && l.Archived
		}
		t.Archived = allArchived
		for p := range implicit {
			t.Implicit = append(t.Implicit, p)
		}
		sort.Strings(t.Implicit)
	}
	return &computed{tasks: tasks, tombstoned: tombstoned, registered: registered}, nil
}

// inScope reports whether t (with links, Implicit and Archived filled)
// belongs to scope sc (already canonical).
func inScope(t Task, sc Scope, tombstoned map[resKey]map[string]bool, registered map[string]bool) bool {
	switch sc.Kind {
	case ScopeWorktree:
		w := sc.Worktree
		for _, l := range t.Links {
			if l.Kind == LinkWorktree && l.Worktree == w {
				return true
			}
		}
		for _, p := range t.Implicit {
			if p == w {
				return true
			}
		}
		if t.Archived && registered[w] {
			for _, l := range t.Links {
				if l.Kind == LinkResource && tombstoned[resKey{l.ResourceType, l.ResourceID}][w] {
					return true
				}
			}
		}
		return false
	case ScopeResource:
		for _, l := range t.Links {
			if l.Kind == LinkResource && l.ResourceType == sc.ResourceType && l.ResourceID == sc.ResourceID {
				return true
			}
		}
		return false
	default:
		return true
	}
}

// loadTasks reads every live task's own columns (or just onlyID's) in
// master order.
func loadTasks(q dbtx, onlyID *int64) ([]Task, error) {
	query := `SELECT ` + taskCols + ` FROM tasks WHERE deleted_at IS NULL`
	var args []any
	if onlyID != nil {
		query += ` AND id = ?`
		args = append(args, *onlyID)
	}
	rows, err := q.QueryContext(bg, query+` ORDER BY rank, id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Task
	for rows.Next() {
		var t Task
		var starred int
		var due, started, completed sql.NullString
		if err := rows.Scan(&t.ID, &t.Title, &t.Description, &t.State, &t.Priority, &starred, &due, &t.Rank,
			&t.CreatedAt, &t.UpdatedAt, &started, &completed); err != nil {
			return nil, err
		}
		t.Starred = starred != 0
		t.Due, t.StartedAt, t.CompletedAt = due.String, started.String, completed.String
		out = append(out, t)
	}
	return out, rows.Err()
}

// loadLinks reads the links of every live task (or just onlyID's), keyed by
// task, in display order: Focus before Related, then sort_order (NULL
// last), then created_at. Archived is left false.
func loadLinks(q dbtx, onlyID *int64) (map[int64][]Link, error) {
	query := `SELECT l.id, l.task_id, l.kind, l.resource_type, l.resource_id, l.worktree_path, l.is_primary
	            FROM task_links l JOIN tasks t ON t.id = l.task_id
	           WHERE t.deleted_at IS NULL`
	var args []any
	if onlyID != nil {
		query += ` AND l.task_id = ?`
		args = append(args, *onlyID)
	}
	rows, err := q.QueryContext(bg, query+` ORDER BY l.task_id, l.is_primary DESC, l.sort_order IS NULL, l.sort_order, l.created_at, l.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][]Link{}
	for rows.Next() {
		var l Link
		var taskID int64
		var primary int
		if err := rows.Scan(&l.ID, &taskID, &l.Kind, &l.ResourceType, &l.ResourceID, &l.Worktree, &primary); err != nil {
			return nil, err
		}
		l.Primary = primary != 0
		out[taskID] = append(out[taskID], l)
	}
	return out, rows.Err()
}

// loadBlockerCounts counts the unresolved blockers of every live task (or
// just onlyID's) in one query, keyed by task. Tasks with none are absent,
// and so are done tasks: a done task is never blocked.
func loadBlockerCounts(q dbtx, onlyID *int64) (map[int64]int, error) {
	query := `SELECT b.task_id, COUNT(*) FROM task_blockers b JOIN tasks t ON t.id = b.task_id
	           WHERE t.deleted_at IS NULL AND t.state != 'done' AND b.resolved_at IS NULL`
	var args []any
	if onlyID != nil {
		query += ` AND b.task_id = ?`
		args = append(args, *onlyID)
	}
	rows, err := q.QueryContext(bg, query+` GROUP BY b.task_id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]int{}
	for rows.Next() {
		var id int64
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

// loadSubscriptions reads `worktree:` subscriptions only (every other
// subscriber, e.g. a task blocker's, does not count as following), split
// into active (resource -> paths) and tombstoned (resource -> path set).
// A subscription whose lease has expired is neither, as in
// watcherdb.ActiveResources.
func loadSubscriptions(q dbtx) (map[resKey][]string, map[resKey]map[string]bool, error) {
	rows, err := q.QueryContext(bg, `SELECT subscriber, resource_type, resource_id, deleted_at IS NULL FROM watcher_subscriptions
		  WHERE subscriber LIKE 'worktree:%'
		    AND (expires_at IS NULL OR expires_at > ?)`, now())
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	active := map[resKey][]string{}
	tombstoned := map[resKey]map[string]bool{}
	for rows.Next() {
		var sub string
		var k resKey
		var live bool
		if err := rows.Scan(&sub, &k.typ, &k.id, &live); err != nil {
			return nil, nil, err
		}
		p, ok := wdb.WorktreePathFromSubscriber(sub)
		if !ok {
			continue
		}
		if live {
			active[k] = append(active[k], p)
		} else {
			if tombstoned[k] == nil {
				tombstoned[k] = map[string]bool{}
			}
			tombstoned[k][p] = true
		}
	}
	return active, tombstoned, rows.Err()
}

// loadRegistry returns the canonical paths of every registered worktree.
func loadRegistry(conn *sql.DB) (map[string]bool, error) {
	entries, err := registry.List(conn)
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(entries))
	for _, e := range entries {
		out[canonicalPath(e.Path)] = true
	}
	return out, nil
}
