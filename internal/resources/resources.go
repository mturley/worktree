package resources

import (
	"database/sql"
	"fmt"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
)

type Resource struct {
	Type    string // "pr", "jira"
	ID      string // "owner/repo#123" or "RHOAIENG-456"
	URL     string
	Related bool // true when NOT the primary resource of its type
}

// Load returns the active tracked resources for a worktree.
func Load(conn *sql.DB, worktreePath string) ([]Resource, error) {
	sub := wdb.Subscriber(worktreePath)
	subs, err := watcherdb.ActiveSubscriptions(conn, sub, false)
	if err != nil {
		return nil, err
	}
	primary, err := loadPrimaryFlags(conn, sub)
	if err != nil {
		return nil, err
	}
	var out []Resource
	for _, s := range subs {
		key := s.Resource.Type + "\x00" + s.Resource.ID
		out = append(out, Resource{
			Type:    s.Resource.Type,
			ID:      s.Resource.ID,
			URL:     s.Resource.URL,
			Related: !primary[key], // absent flag => related (not primary)
		})
	}
	return out, nil
}

func loadPrimaryFlags(conn *sql.DB, sub string) (map[string]bool, error) {
	rows, err := conn.Query(
		`SELECT resource_type, resource_id, is_primary FROM worktree_primary WHERE subscriber = ?`, sub)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := make(map[string]bool)
	for rows.Next() {
		var t, id string
		var p int
		if err := rows.Scan(&t, &id, &p); err != nil {
			return nil, err
		}
		m[t+"\x00"+id] = p == 1
	}
	return m, rows.Err()
}

// Add tracks r for the worktree (reviving a prior user-unwatch), and records
// its primary/related flag. Adding a primary demotes the existing primary of
// the same type to related.
func Add(conn *sql.DB, worktreePath string, r Resource) error {
	sub := wdb.Subscriber(worktreePath)
	wr := watcher.Resource{Type: r.Type, ID: r.ID, URL: r.URL}

	// Explicit Add is a user re-watch: revive even a user tombstone, then
	// refresh the URL / keep it live.
	if err := watcherdb.Reinstate(conn, sub, wr); err != nil {
		return fmt.Errorf("reinstate: %w", err)
	}
	if err := watcherdb.Subscribe(conn, sub, wr, watcherdb.SubscribeOpts{}); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}

	if !r.Related {
		// Demote any existing primary of this type.
		if _, err := conn.Exec(
			`UPDATE worktree_primary SET is_primary = 0 WHERE subscriber = ? AND resource_type = ?`,
			sub, r.Type); err != nil {
			return err
		}
	}
	isPrimary := 0
	if !r.Related {
		isPrimary = 1
	}
	_, err := conn.Exec(
		`INSERT INTO worktree_primary (subscriber, resource_type, resource_id, is_primary)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT (subscriber, resource_type, resource_id)
		 DO UPDATE SET is_primary = excluded.is_primary`,
		sub, r.Type, r.ID, isPrimary)
	return err
}

// Remove hard-deletes the resource (no user tombstone) and its primary flag.
func Remove(conn *sql.DB, worktreePath, resType, id string) error {
	sub := wdb.Subscriber(worktreePath)
	wr := watcher.Resource{Type: resType, ID: id}
	if err := watcherdb.Unsubscribe(conn, sub, wr); err != nil {
		return err
	}
	_, err := conn.Exec(
		`DELETE FROM worktree_primary WHERE subscriber = ? AND resource_type = ? AND resource_id = ?`,
		sub, resType, id)
	return err
}

// Unwatch soft-unsubscribes as a user tombstone (distinct from Remove). The
// primary flag row is retained so a later Add restores the prior classification.
func Unwatch(conn *sql.DB, worktreePath, resType, id string) error {
	sub := wdb.Subscriber(worktreePath)
	return watcherdb.UserUnsubscribe(conn, sub, watcher.Resource{Type: resType, ID: id})
}

func PrimaryOfType(resources []Resource, resType string) *Resource {
	for i := range resources {
		if resources[i].Type == resType && !resources[i].Related {
			return &resources[i]
		}
	}
	return nil
}

func OfType(resources []Resource, resType string) []Resource {
	var result []Resource
	for _, r := range resources {
		if r.Type == resType {
			result = append(result, r)
		}
	}
	return result
}
