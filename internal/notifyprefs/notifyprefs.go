// Package notifyprefs stores which worktrees and resources the user wants
// notifications for. A row means "on"; the row with an empty resource is the
// worktree-wide toggle. Rows are keyed by wdb.Subscriber(path) so they join
// to watcher_subscriptions the same way every other per-worktree table does.
package notifyprefs

import (
	"database/sql"
	"errors"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
)

// Key names one resource.
type Key struct{ Type, ID string }

// Prefs is one worktree's toggles. Resources holds the explicit per-resource
// choices, which are kept while All is on so turning All off restores them.
type Prefs struct {
	All       bool
	Resources map[Key]bool
}

// Notifies is the effective state for k: the worktree-wide toggle covers
// every resource, including ones added after it was turned on.
func (p Prefs) Notifies(k Key) bool { return p.All || p.Resources[k] }

// Get returns path's toggles; a worktree with no rows reads as all off.
func Get(conn *sql.DB, path string) (Prefs, error) {
	all, err := list(conn, `WHERE subscriber = ?`, wdb.Subscriber(path))
	if err != nil {
		return Prefs{}, err
	}
	return all[wdb.Subscriber(path)], nil
}

// ListAll returns every worktree's toggles, keyed by subscriber. Worktrees
// with no rows are absent.
func ListAll(conn *sql.DB) (map[string]Prefs, error) {
	return list(conn, ``)
}

func list(conn *sql.DB, where string, args ...any) (map[string]Prefs, error) {
	rows, err := conn.Query(`SELECT subscriber, resource_type, resource_id FROM worktree_notify `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Prefs{}
	for rows.Next() {
		var sub, typ, id string
		if err := rows.Scan(&sub, &typ, &id); err != nil {
			return nil, err
		}
		p := out[sub]
		if typ == "" && id == "" {
			p.All = true
		} else {
			if p.Resources == nil {
				p.Resources = map[Key]bool{}
			}
			p.Resources[Key{typ, id}] = true
		}
		out[sub] = p
	}
	return out, rows.Err()
}

// SetAll turns the worktree-wide toggle on or off.
func SetAll(conn *sql.DB, path string, on bool) error {
	return set(conn, path, "", "", on)
}

// SetResource turns one resource's toggle on or off.
func SetResource(conn *sql.DB, path, typ, id string, on bool) error {
	if typ == "" || id == "" {
		return errors.New("notifyprefs: resource type and id are required")
	}
	return set(conn, path, typ, id, on)
}

func set(conn *sql.DB, path, typ, id string, on bool) error {
	sub := wdb.Subscriber(path)
	if !on {
		_, err := conn.Exec(
			`DELETE FROM worktree_notify WHERE subscriber = ? AND resource_type = ? AND resource_id = ?`,
			sub, typ, id)
		return err
	}
	_, err := conn.Exec(
		`INSERT INTO worktree_notify (subscriber, resource_type, resource_id, created_at)
		 VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
		sub, typ, id, time.Now().UTC().Format(time.RFC3339))
	return err
}

// RemoveResource deletes one resource's toggle (resources.Remove calls it).
func RemoveResource(conn *sql.DB, path, typ, id string) error {
	return set(conn, path, typ, id, false)
}

// RemoveAll deletes every toggle for the worktree, the worktree-wide one
// included (resources.RemoveAll calls it).
func RemoveAll(conn *sql.DB, path string) error {
	_, err := conn.Exec(`DELETE FROM worktree_notify WHERE subscriber = ?`, wdb.Subscriber(path))
	return err
}
