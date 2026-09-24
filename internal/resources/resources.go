package resources

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/discovery"
	"github.com/mturley/worktree/internal/unread"
)

// isWorktree reports whether a path is a linked git worktree. It is a package
// var so tests can drive both answers without building real worktrees, and so
// every Add caller — CLI, web UI, agent-handler shell-outs — shares one rule.
var isWorktree = discovery.IsInsideWorktree

// ErrNotAWorktree is returned by Add for a path that is not a linked git
// worktree. Callers that answer a user — the web API — report it as bad input
// rather than a server fault.
var ErrNotAWorktree = errors.New("not a git worktree")

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
	class, err := loadClassification(conn, sub)
	if err != nil {
		return nil, err
	}
	var out []Resource
	ranks := make(map[string]sql.NullInt64, len(subs))
	for _, s := range subs {
		key := s.Resource.Type + "\x00" + s.Resource.ID
		c := class[key] // absent row => related (not primary), unranked
		ranks[key] = c.rank
		r := Resource{
			Type:    s.Resource.Type,
			ID:      s.Resource.ID,
			URL:     s.Resource.URL,
			Related: !c.primary,
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

	// subs arrives in subscription-creation order, and the sort below is
	// stable, so anything the user has never ranked by hand keeps exactly the
	// order this function has always returned.
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		// Focus before related. Ranks are numbered per group, so the two
		// groups have to stay apart for those numbers to mean anything.
		if a.Related != b.Related {
			return !a.Related
		}
		ra := ranks[a.Type+"\x00"+a.ID]
		rb := ranks[b.Type+"\x00"+b.ID]
		if ra.Valid != rb.Valid {
			// An unranked resource has never been placed by hand, so it
			// belongs after everything that has been — which is also what
			// puts a newly followed resource at the bottom of its group
			// without anyone having to write a rank for it.
			return ra.Valid
		}
		if ra.Valid && ra.Int64 != rb.Int64 {
			return ra.Int64 < rb.Int64
		}
		return false // equal keys: leave subscription order alone
	})
	return out, nil
}

// classification is a worktree's own opinion about a resource: which group it
// sits in, and where within that group the user dragged it.
type classification struct {
	primary bool
	rank    sql.NullInt64
}

func loadClassification(conn *sql.DB, sub string) (map[string]classification, error) {
	rows, err := conn.Query(
		`SELECT resource_type, resource_id, is_primary, sort_order
		   FROM worktree_primary WHERE subscriber = ?`, sub)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := make(map[string]classification)
	for rows.Next() {
		var t, id string
		var p int
		var rank sql.NullInt64
		if err := rows.Scan(&t, &id, &p, &rank); err != nil {
			return nil, err
		}
		m[t+"\x00"+id] = classification{primary: p == 1, rank: rank}
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

	// Resources belong to a worktree. Tracking one against a repo's main
	// worktree (or a path that is no longer a worktree at all) produces a
	// subscription nothing ever cleans up: `worktree delete` and the cleanup
	// paths only ever run against registered worktrees, so those rows outlive
	// whatever created them and keep getting polled forever.
	if _, ok := isWorktree(worktreePath); !ok {
		return fmt.Errorf(
			"%s is %w; resources can only be tracked in a worktree",
			worktreePath, ErrNotAWorktree)
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

	// Add overwrites is_primary from the caller's flag, so re-adding an
	// already-tracked resource in the other group is a reclassification and
	// gets the same treatment as the UI's focus/related toggle: it moves to
	// the bottom of the group it just joined, rather than keeping a rank that
	// described where it sat in the group it left.
	if err := setGroupAndPlace(conn, worktreePath, r.Type, r.ID, !r.Related); err != nil {
		return err
	}

	// A newly tracked resource starts fully read: its history predates the
	// decision to follow it, so counting it as unread would announce a
	// backlog rather than news. INSERT OR IGNORE inside EnsureCursor means a
	// second worktree subscribing to a resource someone already reads
	// inherits that cursor instead of resetting it.
	//
	// Deliberately after the commit and NOT part of the transaction: failing
	// to seed a cursor must not undo a successful subscription.
	//
	// The seed is therefore BEST-EFFORT, and its error is dropped rather than
	// returned: by this point the resource is tracked, so surfacing a failure
	// here would report "adding the resource failed" for a resource that was
	// in fact added, and the caller has no way to tell the two apart. The
	// migration backfill in internal/db re-seeds anything missed here on the
	// next open. Until then the resource has no cursor row, which Counts
	// reads as nothing unread, so the only cost of dropping the error is that
	// events arriving before that next open are seeded as already seen. This
	// package has no logger — a returned error is its only channel — so there
	// is nowhere else to report it.
	_ = unread.EnsureCursor(conn, r.Type, r.ID)
	return nil
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

// SetPrimary marks an already-tracked resource as focus (primary) or related.
//
// The related flag was previously settable only at creation, so reclassifying
// meant removing and re-adding a resource — losing its custom metadata and
// its place in the timeline. This flips it in place.
//
// It errors rather than silently inserting when the worktree does not track
// the resource: a no-op that reports success would look in the UI exactly
// like a change that stuck.
func SetPrimary(conn *sql.DB, worktreePath, resType, id string, primary bool) error {
	sub := wdb.Subscriber(worktreePath)

	var exists int
	if err := conn.QueryRow(
		`SELECT COUNT(1) FROM watcher_subscriptions
		 WHERE subscriber = ? AND resource_type = ? AND resource_id = ? AND deleted_at IS NULL`,
		sub, resType, id).Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return fmt.Errorf("resource %s/%s is not tracked by %s", resType, id, worktreePath)
	}

	return setGroupAndPlace(conn, worktreePath, resType, id, primary)
}

// setGroupAndPlace records a resource's group and, when that group actually
// changes, moves it to the bottom of the group it joined.
//
// A rank only ever means something relative to the other members of its own
// group, so carrying one across a flip would drop the resource at an arbitrary
// depth in a list it has never been part of. Re-setting the group a resource
// is already in is left alone entirely: the UI fires the toggle with no
// confirmation step, so a repeat must not shuffle anything.
func setGroupAndPlace(conn *sql.DB, worktreePath, resType, id string, primary bool) error {
	sub := wdb.Subscriber(worktreePath)

	var wasPrimary bool
	var known bool
	var p int
	switch err := conn.QueryRow(
		`SELECT is_primary FROM worktree_primary
		  WHERE subscriber = ? AND resource_type = ? AND resource_id = ?`,
		sub, resType, id).Scan(&p); {
	case err == nil:
		known, wasPrimary = true, p == 1
	case errors.Is(err, sql.ErrNoRows):
		// No row yet: a newly followed resource, which is unranked and so
		// already sorts to the bottom of its group without a rank written.
	default:
		return err
	}

	// The destination group's running order, with the moved resource taken
	// out and put back at the end. Read from Load so the ranks written here
	// are numbered against exactly the order the UI and CLI display.
	var placement []Resource
	if known && wasPrimary != primary {
		current, err := Load(conn, worktreePath)
		if err != nil {
			return err
		}
		for _, r := range current {
			if r.Type == resType && r.ID == id {
				continue
			}
			if !r.Related == primary {
				placement = append(placement, r)
			}
		}
		placement = append(placement, Resource{Type: resType, ID: id, Related: !primary})
	}

	tx, err := conn.BeginTx(context.Background(), nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	isPrimary := 0
	if primary {
		isPrimary = 1
	}
	if _, err := tx.Exec(
		`INSERT INTO worktree_primary (subscriber, resource_type, resource_id, is_primary)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT (subscriber, resource_type, resource_id)
		 DO UPDATE SET is_primary = excluded.is_primary`,
		sub, resType, id, isPrimary); err != nil {
		return err
	}
	if err := writeRanks(tx, sub, primary, placement); err != nil {
		return err
	}
	return tx.Commit()
}

// writeRanks numbers group densely from 1, upserting rather than updating
// because a resource that has only ever been related may have no
// worktree_primary row at all — absence of a row is itself a classification.
func writeRanks(tx *sql.Tx, sub string, primary bool, group []Resource) error {
	isPrimary := 0
	if primary {
		isPrimary = 1
	}
	for i, r := range group {
		if _, err := tx.Exec(
			`INSERT INTO worktree_primary
				(subscriber, resource_type, resource_id, is_primary, sort_order)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (subscriber, resource_type, resource_id)
			 DO UPDATE SET is_primary = excluded.is_primary,
			               sort_order = excluded.sort_order`,
			sub, r.Type, r.ID, isPrimary, i+1); err != nil {
			return err
		}
	}
	return nil
}

// Key identifies a tracked resource within a worktree.
type Key struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// SetOrder declares the full running order of both groups at once: a
// resource's group comes from which list it appears in, and its rank from its
// index in that list.
//
// Stating both lists in full — rather than "move X to index 3" — is what makes
// a reorder safe to replay. Two clients dragging at once resolve to
// last-writer-wins instead of to an ambiguous relative move, and a repeat of
// the same call changes nothing.
//
// It is deliberately forgiving about a client whose view is behind:
//   - a tracked resource named in neither list keeps its group and is appended
//     to that group's end, so a page loaded before something was followed
//     reorders what it can see without dropping or reclassifying the rest;
//   - a key that is not tracked at all is ignored, because failing an entire
//     reorder over one resource that has since been removed helps nobody.
//
// Unlike SetPrimary, a reclassification here lands exactly where it was
// dropped: a drag says where the card goes, a toggle does not.
func SetOrder(conn *sql.DB, worktreePath string, focus, related []Key) error {
	sub := wdb.Subscriber(worktreePath)

	current, err := Load(conn, worktreePath)
	if err != nil {
		return err
	}
	tracked := make(map[Key]Resource, len(current))
	for _, r := range current {
		tracked[Key{Type: r.Type, ID: r.ID}] = r
	}

	claimed := make(map[Key]bool, len(focus)+len(related))
	build := func(requested []Key) []Resource {
		var group []Resource
		for _, k := range requested {
			r, ok := tracked[k]
			if !ok || claimed[k] {
				continue
			}
			claimed[k] = true
			group = append(group, r)
		}
		return group
	}
	wantFocus, wantRelated := build(focus), build(related)

	// Anything the caller left out keeps the group it is already in. current
	// is in display order, so the leftovers land at the end of their group in
	// the order they already had relative to each other.
	for _, r := range current {
		if claimed[Key{Type: r.Type, ID: r.ID}] {
			continue
		}
		if r.Related {
			wantRelated = append(wantRelated, r)
		} else {
			wantFocus = append(wantFocus, r)
		}
	}

	tx, err := conn.BeginTx(context.Background(), nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	if err := writeRanks(tx, sub, true, wantFocus); err != nil {
		return err
	}
	if err := writeRanks(tx, sub, false, wantRelated); err != nil {
		return err
	}
	return tx.Commit()
}
