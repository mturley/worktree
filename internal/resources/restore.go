package resources

import (
	"context"
	"database/sql"
	"fmt"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/notifyprefs"
)

// Removed is what unfollowing a resource takes away from a worktree, recorded
// so the web UI's Undo can put it back: the subscription itself (type, id,
// URL), its group, its place in that group, and its own notify toggle.
//
// The custom name/description and the read cursor are per resource, not per
// worktree, and Remove leaves them alone, so they need no recording here.
type Removed struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	URL     string `json:"url"`
	Primary bool   `json:"primary"`
	// Index is the resource's 0-based place within its group.
	Index int `json:"index"`
	// Notify is the resource's own toggle, not the worktree-wide one, which
	// unfollowing does not touch.
	Notify bool `json:"notify"`
}

// RemoveWithSnapshot is Remove, returning what it removed for Restore. ok is
// false when the worktree was not following the resource, in which case
// there is nothing to restore (Remove still runs, so stale rows go anyway).
func RemoveWithSnapshot(conn *sql.DB, worktreePath, resType, id string) (snap Removed, ok bool, err error) {
	snap, ok, err = snapshot(conn, worktreePath, resType, id)
	if err != nil {
		return Removed{}, false, err
	}
	if err := Remove(conn, worktreePath, resType, id); err != nil {
		return Removed{}, false, err
	}
	return snap, ok, nil
}

func snapshot(conn *sql.DB, worktreePath, resType, id string) (Removed, bool, error) {
	current, err := Load(conn, worktreePath)
	if err != nil {
		return Removed{}, false, err
	}
	// Load lists each group whole and in order, so a resource's index in its
	// group is how many of its group came before it.
	var found *Resource
	seen := map[bool]int{} // related → count so far
	index := 0
	for i := range current {
		r := &current[i]
		if r.Type == resType && r.ID == id {
			found, index = r, seen[r.Related]
			break
		}
		seen[r.Related]++
	}
	if found == nil {
		return Removed{}, false, nil
	}
	prefs, err := notifyprefs.Get(conn, worktreePath)
	if err != nil {
		return Removed{}, false, err
	}
	return Removed{
		Type:    found.Type,
		ID:      found.ID,
		URL:     found.URL,
		Primary: !found.Related,
		Index:   index,
		Notify:  prefs.Resources[notifyprefs.Key{Type: resType, ID: id}],
	}, true, nil
}

// Restore follows a resource again as RemoveWithSnapshot recorded it: in the
// same group, at the same index (or the group's end, if the group has since
// shrunk past it), with its notify toggle back on if it was on.
//
// Other cards keep their relative order: only the restored one is placed. It
// is safe to repeat; a resource that is already followed is moved to the
// recorded place rather than added twice.
func Restore(conn *sql.DB, worktreePath string, snap Removed) error {
	if err := Add(conn, worktreePath, Resource{Type: snap.Type, ID: snap.ID, URL: snap.URL, Related: !snap.Primary}); err != nil {
		return err
	}

	current, err := Load(conn, worktreePath)
	if err != nil {
		return err
	}
	var restored *Resource
	var group []Resource
	for i := range current {
		r := current[i]
		if r.Type == snap.Type && r.ID == snap.ID {
			restored = &r
			continue
		}
		if r.Related == !snap.Primary {
			group = append(group, r)
		}
	}
	if restored == nil {
		return fmt.Errorf("resource %s/%s is not tracked by %s after restoring it", snap.Type, snap.ID, worktreePath)
	}
	at := min(max(snap.Index, 0), len(group))
	group = append(group[:at], append([]Resource{*restored}, group[at:]...)...)

	tx, err := conn.BeginTx(context.Background(), nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()
	if err := writeRanks(tx, wdb.Subscriber(worktreePath), snap.Primary, group); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	if snap.Notify {
		return notifyprefs.SetResource(conn, worktreePath, snap.Type, snap.ID, true)
	}
	return nil
}
