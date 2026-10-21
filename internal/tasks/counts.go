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
	c, err := compute(conn, nil)
	if err != nil {
		return Counts{}, err
	}
	out := Counts{ByWorktree: map[string]int{}, ByResource: map[string]int{}}
	for _, t := range c.tasks {
		if t.State == StateDone {
			continue
		}
		out.Total++
		// Candidate worktrees: every registered one (the fallback needs a
		// registered worktree), plus any a link or implicit follow names.
		// inScope makes the actual decision, so membership stays defined in
		// one place.
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
					out.ByResource[l.ResourceType+":"+l.ResourceID]++
				}
			}
		}
		for p := range cands {
			if c.inScope(t, Scope{Kind: ScopeWorktree, Worktree: p}) {
				out.ByWorktree[p]++
			}
		}
	}
	return out, nil
}
