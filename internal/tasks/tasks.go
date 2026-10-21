package tasks

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// State is a task's progress.
type State string

const (
	StateNotStarted State = "not_started"
	StateInProgress State = "in_progress"
	StateDone       State = "done"
)

func (s State) valid() bool {
	return s == StateNotStarted || s == StateInProgress || s == StateDone
}

// Priority is a task's priority; PriorityNone when unset.
type Priority string

const (
	PriorityHigh   Priority = "high"
	PriorityMedium Priority = "medium"
	PriorityLow    Priority = "low"
	PriorityNone   Priority = "none"
)

func (p Priority) valid() bool {
	return p == PriorityHigh || p == PriorityMedium || p == PriorityLow || p == PriorityNone
}

// Actor kinds stamped on every event.
const (
	ActorUser  = "user"
	ActorAgent = "agent"
)

// Actor is who made a change: the user, or an agent (optionally naming its
// session).
type Actor struct {
	Kind    string // ActorUser or ActorAgent
	Session string
}

var (
	// ErrNotFound is returned for a task that does not exist or was deleted.
	ErrNotFound = errors.New("task not found")
	// ErrInvalid is wrapped with a message saying what was wrong with the input.
	ErrInvalid = errors.New("invalid task input")
)

// LinkTarget is a placeholder; Task 4 defines it in links.go.
type LinkTarget struct{}

// Link is a placeholder; Task 4 defines it.
type Link struct{}

// Subtask is a placeholder; Task 5 defines it.
type Subtask struct{}

// Task is one to-do item.
type Task struct {
	ID          int64
	Title       string
	Description string
	State       State
	Priority    Priority
	Starred     bool
	Due         string // "YYYY-MM-DD" or ""
	Rank        string
	// RFC3339 UTC; "" when unset.
	CreatedAt, UpdatedAt, StartedAt, CompletedAt string
	Links                                        []Link    // filled by Get/List (Task 4)
	Implicit                                     []string  // canonical worktree paths reached via live resource links (Task 4)
	Archived                                     bool      // every link archived (Task 4); false for a global task
	Subtasks                                     []Subtask // filled by Get/List (Task 5)
}

// NewTask is the input to Create. A zero Priority means PriorityNone.
type NewTask struct {
	Title, Description string
	Priority           Priority
	Starred            bool
	Due                string
	Focus              []LinkTarget
}

// Patch is the input to Update. A nil field is left alone; Due "" clears.
type Patch struct {
	Title, Description *string
	Priority           *Priority
	Starred            *bool
	Due                *string
}

// StateChange reports what SetState did, with the timestamps before and
// after so a caller can offer an undo. EventID is 0 when nothing changed.
type StateChange struct {
	From, To                                               State
	PrevStartedAt, PrevCompletedAt, StartedAt, CompletedAt string
	EventID                                                int64
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

func bit(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func validActor(a Actor) error {
	if a.Kind != ActorUser && a.Kind != ActorAgent {
		return fmt.Errorf("%w: actor kind %q is not %q or %q", ErrInvalid, a.Kind, ActorUser, ActorAgent)
	}
	return nil
}

func cleanTitle(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", fmt.Errorf("%w: title is empty", ErrInvalid)
	}
	return s, nil
}

func validDue(s string) error {
	if s == "" {
		return nil
	}
	if _, err := time.Parse("2006-01-02", s); err != nil {
		return fmt.Errorf("%w: due date %q is not YYYY-MM-DD", ErrInvalid, s)
	}
	return nil
}

func validPriority(p Priority) error {
	if !p.valid() {
		return fmt.Errorf("%w: priority %q is not high, medium, low or none", ErrInvalid, p)
	}
	return nil
}

// querier is satisfied by *sql.DB and *sql.Tx.
type querier interface {
	QueryRow(query string, args ...any) *sql.Row
}

const taskCols = `id, title, description, state, priority, starred, due_date, rank,
	created_at, updated_at, started_at, completed_at`

// load reads a live (not deleted) task's own columns.
func load(q querier, id int64) (Task, error) {
	var t Task
	var starred int
	var due, started, completed sql.NullString
	err := q.QueryRow(`SELECT `+taskCols+` FROM tasks WHERE id = ? AND deleted_at IS NULL`, id).Scan(
		&t.ID, &t.Title, &t.Description, &t.State, &t.Priority, &starred, &due, &t.Rank,
		&t.CreatedAt, &t.UpdatedAt, &started, &completed)
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, ErrNotFound
	}
	if err != nil {
		return Task{}, err
	}
	t.Starred = starred != 0
	t.Due, t.StartedAt, t.CompletedAt = due.String, started.String, completed.String
	return t, nil
}

// inTx runs fn in a transaction, committing only when it returns nil.
func inTx(conn *sql.DB, fn func(*sql.Tx) error) error {
	tx, err := conn.Begin()
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// Create adds a task at the bottom of the master order. n.Focus is ignored
// until Task 4 wires links in.
func Create(conn *sql.DB, a Actor, n NewTask) (Task, error) {
	if err := validActor(a); err != nil {
		return Task{}, err
	}
	title, err := cleanTitle(n.Title)
	if err != nil {
		return Task{}, err
	}
	if n.Priority == "" {
		n.Priority = PriorityNone
	}
	if err := validPriority(n.Priority); err != nil {
		return Task{}, err
	}
	if err := validDue(n.Due); err != nil {
		return Task{}, err
	}
	var id int64
	err = inTx(conn, func(tx *sql.Tx) error {
		// Max over ALL rows, deleted included, so a later restore can't
		// collide with a newer task's rank.
		var last sql.NullString
		if err := tx.QueryRow(`SELECT MAX(rank) FROM tasks`).Scan(&last); err != nil {
			return err
		}
		rank, err := KeyBetween(last.String, "")
		if err != nil {
			return err
		}
		ts := now()
		res, err := tx.Exec(
			`INSERT INTO tasks (title, description, state, priority, starred, due_date, rank, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			title, n.Description, StateNotStarted, n.Priority, bit(n.Starred), nullable(n.Due), rank, ts, ts)
		if err != nil {
			return err
		}
		if id, err = res.LastInsertId(); err != nil {
			return err
		}
		_, err = record(tx, a, id, ts, EventTaskCreated, nil)
		return err
	})
	if err != nil {
		return Task{}, err
	}
	return Get(conn, id)
}

// Get returns a task, or ErrNotFound when it is missing or deleted.
func Get(conn *sql.DB, id int64) (Task, error) {
	return load(conn, id)
}

// Update applies p, recording a task_edited event listing only the fields
// that actually changed. A patch that changes nothing writes nothing.
func Update(conn *sql.DB, a Actor, id int64, p Patch) (Task, error) {
	if err := validActor(a); err != nil {
		return Task{}, err
	}
	if p.Title != nil {
		t, err := cleanTitle(*p.Title)
		if err != nil {
			return Task{}, err
		}
		p.Title = &t
	}
	if p.Priority != nil {
		if err := validPriority(*p.Priority); err != nil {
			return Task{}, err
		}
	}
	if p.Due != nil {
		if err := validDue(*p.Due); err != nil {
			return Task{}, err
		}
	}
	err := inTx(conn, func(tx *sql.Tx) error {
		cur, err := load(tx, id)
		if err != nil {
			return err
		}
		changes := map[string]change{}
		next := cur
		if p.Title != nil && *p.Title != cur.Title {
			changes["title"] = change{cur.Title, *p.Title}
			next.Title = *p.Title
		}
		if p.Description != nil && *p.Description != cur.Description {
			changes["description"] = change{cur.Description, *p.Description}
			next.Description = *p.Description
		}
		if p.Priority != nil && *p.Priority != cur.Priority {
			changes["priority"] = change{cur.Priority, *p.Priority}
			next.Priority = *p.Priority
		}
		if p.Starred != nil && *p.Starred != cur.Starred {
			changes["starred"] = change{cur.Starred, *p.Starred}
			next.Starred = *p.Starred
		}
		if p.Due != nil && *p.Due != cur.Due {
			changes["due"] = change{cur.Due, *p.Due}
			next.Due = *p.Due
		}
		if len(changes) == 0 {
			return nil
		}
		ts := now()
		if _, err := tx.Exec(
			`UPDATE tasks SET title = ?, description = ?, priority = ?, starred = ?, due_date = ?, updated_at = ?
			 WHERE id = ?`,
			next.Title, next.Description, next.Priority, bit(next.Starred), nullable(next.Due), ts, id); err != nil {
			return err
		}
		_, err = record(tx, a, id, ts, EventTaskEdited, map[string]any{"changes": changes})
		return err
	})
	if err != nil {
		return Task{}, err
	}
	return Get(conn, id)
}

// SetState moves a task to state to, maintaining started_at (set on first
// reaching in_progress or done, cleared on returning to not_started) and
// completed_at (set on entering done, cleared on leaving it). Setting the
// current state changes nothing and returns EventID 0.
func SetState(conn *sql.DB, a Actor, id int64, to State) (StateChange, error) {
	if err := validActor(a); err != nil {
		return StateChange{}, err
	}
	if !to.valid() {
		return StateChange{}, fmt.Errorf("%w: state %q is not not_started, in_progress or done", ErrInvalid, to)
	}
	var sc StateChange
	err := inTx(conn, func(tx *sql.Tx) error {
		cur, err := load(tx, id)
		if err != nil {
			return err
		}
		sc = StateChange{
			From: cur.State, To: to,
			PrevStartedAt: cur.StartedAt, PrevCompletedAt: cur.CompletedAt,
			StartedAt: cur.StartedAt, CompletedAt: cur.CompletedAt,
		}
		if cur.State == to {
			return nil
		}
		ts := now()
		switch to {
		case StateNotStarted:
			sc.StartedAt, sc.CompletedAt = "", ""
		case StateInProgress:
			if sc.StartedAt == "" {
				sc.StartedAt = ts
			}
			sc.CompletedAt = ""
		case StateDone:
			if sc.StartedAt == "" {
				sc.StartedAt = ts
			}
			sc.CompletedAt = ts
		}
		if _, err := tx.Exec(
			`UPDATE tasks SET state = ?, started_at = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
			to, nullable(sc.StartedAt), nullable(sc.CompletedAt), ts, id); err != nil {
			return err
		}
		sc.EventID, err = record(tx, a, id, ts, EventTaskStateChanged, map[string]State{"from": cur.State, "to": to})
		return err
	})
	if err != nil {
		return StateChange{}, err
	}
	return sc, nil
}

// Delete soft-deletes a task by setting deleted_at. Its events remain.
func Delete(conn *sql.DB, a Actor, id int64) error {
	if err := validActor(a); err != nil {
		return err
	}
	return inTx(conn, func(tx *sql.Tx) error {
		ts := now()
		res, err := tx.Exec(`UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, ts, ts, id)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrNotFound
		}
		_, err = record(tx, a, id, ts, EventTaskDeleted, nil)
		return err
	})
}
