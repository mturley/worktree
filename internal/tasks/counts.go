package tasks

import "database/sql"

// Counts is how many open (not done) tasks each scope holds.
type Counts struct {
	ByWorktree map[string]int // canonical worktree path -> open tasks in worktree scope (direct, implicit, fallback)
	ByResource map[string]int // "type:id" -> open tasks linking that resource
	Total      int            // open tasks in all scope
}

// OpenCounts counts open tasks per worktree, per resource and overall, from
// ONE load through List's compute path, so each count equals the length of
// the matching default List (open tasks only).
func OpenCounts(conn *sql.DB) (Counts, error) {
	c, _, err := CountsAndScope(conn)
	return c, err
}

// CountsAndScope is OpenCounts and BuildScopeIndex from the SAME single
// load, for a request that needs both (the worktree list: open-task counts
// and unread task badges).
func CountsAndScope(conn *sql.DB) (Counts, ScopeIndex, error) {
	c, err := compute(conn, nil)
	if err != nil {
		return Counts{}, ScopeIndex{}, err
	}
	counts := Counts{ByWorktree: map[string]int{}, ByResource: map[string]int{}}
	scope := ScopeIndex{ByWorktree: map[string][]int64{}, ByResource: map[string][]int64{}}
	for _, t := range c.tasks {
		open := t.State != StateDone
		if open {
			counts.Total++
		}
		wts, res := c.memberships(t)
		for _, p := range wts {
			scope.ByWorktree[p] = append(scope.ByWorktree[p], t.ID)
			if open {
				counts.ByWorktree[p]++
			}
		}
		for _, k := range res {
			scope.ByResource[k] = append(scope.ByResource[k], t.ID)
			if open {
				counts.ByResource[k]++
			}
		}
	}
	return counts, scope, nil
}

// ScopeIndex is the feed membership ScopeTaskIDs computes for one scope —
// every non-deleted task, done and archived included — for every worktree
// and resource at once. Each id appears at most once per key.
type ScopeIndex struct {
	ByWorktree map[string][]int64 // canonical worktree path -> task ids in its scope
	ByResource map[string][]int64 // "type:id" -> ids of tasks linking that resource
}

// BuildScopeIndex computes a ScopeIndex from ONE load, for callers that need
// many worktrees' or resources' task membership in one request (the worktree
// list's unread badges) and so must not call ScopeTaskIDs per worktree.
func BuildScopeIndex(conn *sql.DB) (ScopeIndex, error) {
	_, s, err := CountsAndScope(conn)
	return s, err
}

// memberships returns the canonical worktrees whose scope holds t and the
// "type:id" keys of the resources t links, each once.
//
// Candidate worktrees: every registered one (the fallback needs a registered
// worktree), plus any a link or implicit follow names. inScope makes the
// actual decision, so membership stays defined in one place.
func (c *computed) memberships(t Task) (worktrees, resources []string) {
	cands := map[string]bool{}
	for p := range c.registered {
		cands[p] = true
	}
	for _, p := range t.Implicit {
		cands[p] = true
	}
	seenRes := map[resKey]bool{}
	for _, l := range t.Links {
		switch l.Kind {
		case LinkWorktree:
			cands[l.Worktree] = true
		case LinkResource:
			k := resKey{l.ResourceType, l.ResourceID}
			if !seenRes[k] {
				seenRes[k] = true
				resources = append(resources, l.ResourceType+":"+l.ResourceID)
			}
		}
	}
	for p := range cands {
		if c.inScope(t, Scope{Kind: ScopeWorktree, Worktree: p}) {
			worktrees = append(worktrees, p)
		}
	}
	return worktrees, resources
}
