package tasks

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"

	wdb "github.com/mturley/worktree/internal/db"
)

// LinkKind says what a link points at.
type LinkKind string

const (
	LinkResource LinkKind = "resource"
	LinkWorktree LinkKind = "worktree"
)

// LinkTarget is what a link points at: a resource (ResourceType +
// ResourceID) or a worktree (Worktree). Worktree may be any path on input;
// it is canonicalised through wdb.Subscriber on write, and always holds the
// canonical path on output.
type LinkTarget struct {
	Kind                     LinkKind
	ResourceType, ResourceID string
	Worktree                 string
}

// Link is one of a task's links.
type Link struct {
	ID int64
	LinkTarget
	Primary  bool // Focus; false means Related
	Archived bool // a resource no live worktree follows, or a worktree gone from the registry
	// FollowingWorktrees: for a resource link, the canonical paths of the
	// worktrees that actively follow it (`worktree:` subscribers only),
	// sorted. Empty for a worktree link and for an archived resource.
	FollowingWorktrees []string
}

// canonicalPath is the canonical form of a worktree path, the same one
// wdb.Subscriber keys subscriptions by. A path that does not exist falls
// back to its absolute, cleaned form.
func canonicalPath(p string) string {
	c, _ := wdb.WorktreePathFromSubscriber(wdb.Subscriber(p))
	return c
}

// normalize validates t and returns it with only the fields its kind uses,
// each trimmed of surrounding space, and a worktree path canonicalised.
func normalize(t LinkTarget) (LinkTarget, error) {
	switch t.Kind {
	case LinkResource:
		typ, id := strings.TrimSpace(t.ResourceType), strings.TrimSpace(t.ResourceID)
		if typ == "" || id == "" {
			return LinkTarget{}, fmt.Errorf("%w: a resource link needs a type and an id", ErrInvalid)
		}
		return LinkTarget{Kind: LinkResource, ResourceType: typ, ResourceID: id}, nil
	case LinkWorktree:
		p := strings.TrimSpace(t.Worktree)
		if p == "" {
			return LinkTarget{}, fmt.Errorf("%w: a worktree link needs a path", ErrInvalid)
		}
		return LinkTarget{Kind: LinkWorktree, Worktree: canonicalPath(p)}, nil
	default:
		return LinkTarget{}, fmt.Errorf("%w: link kind %q is not %q or %q", ErrInvalid, t.Kind, LinkResource, LinkWorktree)
	}
}

// findLink returns the row id and group of taskID's link to t (already
// normalised), or sql.ErrNoRows.
func findLink(tx dbtx, taskID int64, t LinkTarget) (id int64, primary bool, err error) {
	var p int
	err = tx.QueryRowContext(bg,
		`SELECT id, is_primary FROM task_links
		  WHERE task_id = ? AND kind = ? AND resource_type = ? AND resource_id = ? AND worktree_path = ?`,
		taskID, t.Kind, t.ResourceType, t.ResourceID, t.Worktree).Scan(&id, &p)
	return id, p != 0, err
}

// nextSortOrder is the sort_order that puts a link at the bottom of
// taskID's focus or related group.
func nextSortOrder(tx dbtx, taskID int64, focus bool) (int64, error) {
	var n int64
	err := tx.QueryRowContext(bg,
		`SELECT COALESCE(MAX(sort_order), 0) + 1 FROM task_links WHERE task_id = ? AND is_primary = ?`,
		taskID, bit(focus)).Scan(&n)
	return n, err
}

// insertLink adds a new link (t already normalised) at the bottom of its
// group and bumps the task's updated_at.
func insertLink(tx dbtx, taskID int64, t LinkTarget, focus bool, ts string) error {
	order, err := nextSortOrder(tx, taskID, focus)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(bg,
		`INSERT INTO task_links (task_id, kind, resource_type, resource_id, worktree_path, is_primary, sort_order, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		taskID, t.Kind, t.ResourceType, t.ResourceID, t.Worktree, bit(focus), order, ts); err != nil {
		return err
	}
	return touch(tx, taskID, ts)
}

// moveLinkGroup moves link row id to the bottom of the other group and
// bumps the task's updated_at.
func moveLinkGroup(tx dbtx, taskID, id int64, focus bool) error {
	order, err := nextSortOrder(tx, taskID, focus)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(bg, `UPDATE task_links SET is_primary = ?, sort_order = ? WHERE id = ?`, bit(focus), order, id); err != nil {
		return err
	}
	return touch(tx, taskID, now())
}

// AddLink links taskID to t, as Focus when focus is set and Related
// otherwise, at the bottom of that group. Adding an existing link in the
// same group changes nothing; in the other group it behaves as SetLinkFocus.
func AddLink(conn *sql.DB, a Actor, taskID int64, t LinkTarget, focus bool) (Link, error) {
	if err := validActor(a); err != nil {
		return Link{}, err
	}
	t, err := normalize(t)
	if err != nil {
		return Link{}, err
	}
	err = inTx(conn, func(tx dbtx) error {
		if _, err := load(tx, taskID); err != nil {
			return err
		}
		id, primary, err := findLink(tx, taskID, t)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			return insertLink(tx, taskID, t, focus, now())
		case err != nil:
			return err
		case primary == focus:
			return nil
		default:
			return moveLinkGroup(tx, taskID, id, focus)
		}
	})
	if err != nil {
		return Link{}, err
	}
	tk, err := Get(conn, taskID)
	if err != nil {
		return Link{}, err
	}
	for _, l := range tk.Links {
		if l.LinkTarget == t {
			return l, nil
		}
	}
	return Link{}, fmt.Errorf("link %+v vanished after AddLink", t)
}

// RemoveLink removes taskID's link to t. Removing a Focus link promotes
// nothing. A link that does not exist is ErrLinkNotFound.
func RemoveLink(conn *sql.DB, a Actor, taskID int64, t LinkTarget) error {
	if err := validActor(a); err != nil {
		return err
	}
	t, err := normalize(t)
	if err != nil {
		return err
	}
	return inTx(conn, func(tx dbtx) error {
		if _, err := load(tx, taskID); err != nil {
			return err
		}
		id, _, err := findLink(tx, taskID, t)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrLinkNotFound
		}
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(bg, `DELETE FROM task_links WHERE id = ?`, id); err != nil {
			return err
		}
		return touch(tx, taskID, now())
	})
}

// SetLinkFocus moves taskID's link to t into the Focus group (focus) or
// the Related group, landing at the bottom of it. Setting the group it is
// already in changes nothing. A link that does not exist is ErrLinkNotFound.
func SetLinkFocus(conn *sql.DB, a Actor, taskID int64, t LinkTarget, focus bool) error {
	if err := validActor(a); err != nil {
		return err
	}
	t, err := normalize(t)
	if err != nil {
		return err
	}
	return inTx(conn, func(tx dbtx) error {
		if _, err := load(tx, taskID); err != nil {
			return err
		}
		id, primary, err := findLink(tx, taskID, t)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrLinkNotFound
		}
		if err != nil {
			return err
		}
		if primary == focus {
			return nil
		}
		return moveLinkGroup(tx, taskID, id, focus)
	})
}

// SetLinkOrder declares the full order of taskID's links: a link's group
// comes from which list names it, and its position from its index there.
// Like resources.SetOrder it forgives a stale caller: a link named in
// neither list keeps its group and goes to that group's end (in its current
// relative order), and a target that is not linked, or is invalid, is
// ignored. A target named twice counts once, at its first mention. It
// records no event. Any change bumps the task's updated_at; a request that
// leaves the order as it was writes nothing.
func SetLinkOrder(conn *sql.DB, a Actor, taskID int64, focus, related []LinkTarget) error {
	if err := validActor(a); err != nil {
		return err
	}
	return inTx(conn, func(tx dbtx) error {
		if _, err := load(tx, taskID); err != nil {
			return err
		}
		current, err := loadLinks(tx, &taskID)
		if err != nil {
			return err
		}
		links := current[taskID]
		byTarget := make(map[LinkTarget]Link, len(links))
		for _, l := range links {
			byTarget[l.LinkTarget] = l
		}
		claimed := make(map[LinkTarget]bool, len(links))
		build := func(requested []LinkTarget) []Link {
			var group []Link
			for _, r := range requested {
				n, err := normalize(r)
				if err != nil {
					continue
				}
				l, ok := byTarget[n]
				if !ok || claimed[n] {
					continue
				}
				claimed[n] = true
				group = append(group, l)
			}
			return group
		}
		wantFocus, wantRelated := build(focus), build(related)
		for _, l := range links {
			if claimed[l.LinkTarget] {
				continue
			}
			if l.Primary {
				wantFocus = append(wantFocus, l)
			} else {
				wantRelated = append(wantRelated, l)
			}
		}
		// links is in display order (Focus, then Related), so the request
		// changes nothing exactly when it yields the same sequence.
		changed := false
		for i, l := range append(append([]Link{}, wantFocus...), wantRelated...) {
			if l.ID != links[i].ID || (i < len(wantFocus)) != links[i].Primary {
				changed = true
				break
			}
		}
		if !changed {
			return nil
		}
		if err := touch(tx, taskID, now()); err != nil {
			return err
		}
		write := func(group []Link, primary bool) error {
			for i, l := range group {
				if _, err := tx.ExecContext(bg, `UPDATE task_links SET is_primary = ?, sort_order = ? WHERE id = ?`,
					bit(primary), i+1, l.ID); err != nil {
					return err
				}
			}
			return nil
		}
		if err := write(wantFocus, true); err != nil {
			return err
		}
		return write(wantRelated, false)
	})
}
