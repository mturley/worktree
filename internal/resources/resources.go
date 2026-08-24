package resources

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
)

type Resource struct {
	Type              string // "pr", "jira", "slack"
	ID                string // "owner/repo#123" or "RHOAIENG-456" or "<channel>:<thread_ts>"
	URL               string
	Related           bool   // true when NOT the primary resource of its type
	CustomName        string // user-supplied; empty => consumer falls back to platform name
	CustomDescription string // user-supplied; empty => no description
	UpdatedAt         string // RFC3339 UTC of the last name/description write; "" if never set
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
		r := Resource{
			Type:    s.Resource.Type,
			ID:      s.Resource.ID,
			URL:     s.Resource.URL,
			Related: !primary[key], // absent flag => related (not primary)
		}
		meta, err := watcherdb.GetResourceMeta(conn, s.Resource.Type, s.Resource.ID)
		if err != nil {
			return nil, err
		}
		if meta != nil {
			r.CustomName = meta.CustomName
			r.CustomDescription = meta.CustomDescription
			r.UpdatedAt = meta.UpdatedAt
		}
		out = append(out, r)
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

// Add tracks r for the worktree (reviving a prior user-unwatch) and records
// its primary/related flag (is_primary = !Related). Multiple resources of
// the same type may be primary.
func Add(conn *sql.DB, worktreePath string, r Resource) error {
	// Reject empty type/id before any DB write — an empty ID produces a
	// malformed subscription that pollers can't act on (e.g. the slack poller
	// logs "bad slack resource id" on every cycle). Guarding here covers all
	// callers (the `worktree resources add` CLI, jira/pr add paths, handler).
	if strings.TrimSpace(r.Type) == "" {
		return fmt.Errorf("resource type is required")
	}
	if strings.TrimSpace(r.ID) == "" {
		return fmt.Errorf("resource id is required")
	}

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

	// The subscription revive/refresh and the primary-flag upsert are wrapped in a
	// transaction so a failure can't leave the flag row and subscription inconsistent.
	tx, err := conn.BeginTx(context.Background(), nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	isPrimary := 0
	if !r.Related {
		isPrimary = 1
	}
	if _, err := tx.Exec(
		`INSERT INTO worktree_primary (subscriber, resource_type, resource_id, is_primary)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT (subscriber, resource_type, resource_id)
		 DO UPDATE SET is_primary = excluded.is_primary`,
		sub, r.Type, r.ID, isPrimary); err != nil {
		return err
	}
	return tx.Commit()
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

// RemoveAll hard-removes every tracked resource for the worktree at
// worktreePath: it hard-unsubscribes each resource (watcher Unsubscribe) and
// deletes all worktree_primary rows for the worktree's subscriber. Used when a
// worktree is deleted or cleaned up so no dead subscriptions linger.
func RemoveAll(conn *sql.DB, worktreePath string) error {
	sub := wdb.Subscriber(worktreePath)
	// Enumerate current active resources and hard-unsubscribe each.
	rs, err := Load(conn, worktreePath)
	if err != nil {
		return err
	}
	for _, r := range rs {
		if err := watcherdb.Unsubscribe(conn, sub, watcher.Resource{Type: r.Type, ID: r.ID}); err != nil {
			return err
		}
	}
	// Delete all primary-flag rows for this subscriber (covers any rows whose
	// subscription was already tombstoned and thus not returned by Load).
	_, err = conn.Exec(`DELETE FROM worktree_primary WHERE subscriber = ?`, sub)
	return err
}

// SetMeta upserts the user-supplied custom name/description for a resource.
// Custom metadata is per-resource (not per-worktree), so worktreePath is not
// needed. Empty strings clear the respective field.
func SetMeta(conn *sql.DB, resType, id, name, description string) error {
	return watcherdb.SetResourceMeta(conn, watcher.Resource{Type: resType, ID: id}, name, description)
}

// SetMetaAt is SetMeta with an explicit updated_at timestamp. Use it to
// replicate a name from another database (e.g. handler pushing a newer name):
// passing the origin timestamp lets both sides converge instead of
// ping-ponging. An empty updatedAt falls back to SetMeta (stamps now).
func SetMetaAt(conn *sql.DB, resType, id, name, description, updatedAt string) error {
	if updatedAt == "" {
		return SetMeta(conn, resType, id, name, description)
	}
	return watcherdb.SetResourceMetaAt(conn, watcher.Resource{Type: resType, ID: id}, name, description, updatedAt)
}

// Unwatch soft-unsubscribes as a user tombstone (distinct from Remove). The
// worktree_primary row is left in place, but note that a later Add overwrites
// is_primary from the caller-supplied Related flag — it does not restore the
// prior classification.
func Unwatch(conn *sql.DB, worktreePath, resType, id string) error {
	sub := wdb.Subscriber(worktreePath)
	return watcherdb.UserUnsubscribe(conn, sub, watcher.Resource{Type: resType, ID: id})
}

// PrimariesOfType returns all primary (non-related) resources of the given type.
func PrimariesOfType(resources []Resource, resType string) []Resource {
	var out []Resource
	for _, r := range resources {
		if r.Type == resType && !r.Related {
			out = append(out, r)
		}
	}
	return out
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
