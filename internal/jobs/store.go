package jobs

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// ErrNotFound is returned when no job has the requested id.
var ErrNotFound = errors.New("job not found")

const columns = `id, kind, title, target, request, state, steps, question, result,
	error, pid, created_at, updated_at, finished_at`

func nullableJSON(m json.RawMessage) any {
	if len(m) == 0 {
		return nil
	}
	return string(m)
}

// save inserts or replaces the job with j's id.
func save(conn *sql.DB, j Job) error {
	steps := j.Steps
	if steps == nil {
		steps = []Step{}
	}
	stepsJSON, err := json.Marshal(steps)
	if err != nil {
		return err
	}
	var finished any
	if j.FinishedAt != "" {
		finished = j.FinishedAt
	}
	_, err = conn.Exec(`INSERT INTO jobs (`+columns+`)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			kind = excluded.kind, title = excluded.title, target = excluded.target,
			request = excluded.request, state = excluded.state, steps = excluded.steps,
			question = excluded.question, result = excluded.result, error = excluded.error,
			pid = excluded.pid, created_at = excluded.created_at,
			updated_at = excluded.updated_at, finished_at = excluded.finished_at`,
		j.ID, j.Kind, j.Title, j.Target, string(j.Request), string(j.State), string(stepsJSON),
		nullableJSON(j.Question), nullableJSON(j.Result), j.Error, j.PID,
		j.CreatedAt, j.UpdatedAt, finished)
	return err
}

type scanner interface{ Scan(dest ...any) error }

func scan(r scanner) (Job, error) {
	var j Job
	var state, request, steps string
	var question, result, finished sql.NullString
	if err := r.Scan(&j.ID, &j.Kind, &j.Title, &j.Target, &request, &state, &steps,
		&question, &result, &j.Error, &j.PID, &j.CreatedAt, &j.UpdatedAt, &finished); err != nil {
		return Job{}, err
	}
	j.State = State(state)
	if request != "" {
		j.Request = json.RawMessage(request)
	}
	if question.Valid {
		j.Question = json.RawMessage(question.String)
	}
	if result.Valid {
		j.Result = json.RawMessage(result.String)
	}
	j.FinishedAt = finished.String
	if err := json.Unmarshal([]byte(steps), &j.Steps); err != nil {
		return Job{}, err
	}
	if j.Steps == nil {
		j.Steps = []Step{}
	}
	return j, nil
}

// load returns the job with id, or ErrNotFound.
func load(conn *sql.DB, id string) (Job, error) {
	j, err := scan(conn.QueryRow(`SELECT `+columns+` FROM jobs WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, ErrNotFound
	}
	return j, err
}

// remove deletes the job with id; a missing job is not an error.
func remove(conn *sql.DB, id string) error {
	_, err := conn.Exec(`DELETE FROM jobs WHERE id = ?`, id)
	return err
}

func query(conn *sql.DB, where string) ([]Job, error) {
	rows, err := conn.Query(`SELECT ` + columns + ` FROM jobs ` + where +
		` ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Job
	for rows.Next() {
		j, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// all lists every job, oldest first.
func all(conn *sql.DB) ([]Job, error) { return query(conn, "") }

// Unfinished lists running and needs_answer jobs, oldest first. A DB with no
// jobs table (older schema) is an empty list, not an error.
func Unfinished(conn *sql.DB) ([]Job, error) {
	out, err := query(conn, `WHERE state IN ('running', 'needs_answer')`)
	if err != nil && strings.Contains(err.Error(), "no such table") {
		return nil, nil
	}
	return out, err
}
