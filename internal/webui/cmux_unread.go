package webui

import (
	"sync"
	"time"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

// StartCmuxUnreadSync runs cmuxUnreadPass every interval until stop is
// called.
//
// It reconciles rather than reacting to transitions: unread state changes
// from the pollers, from the UI, and from other processes writing the same
// DB (`worktree resources mark-read`, agent-handler), none of which this
// process can observe as an event. Comparing the wanted state with the
// titles cmux reports also makes a restart self-correcting.
func (s *Server) StartCmuxUnreadSync(interval time.Duration) (stop func()) {
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				s.cmuxUnreadPass()
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(done) }) }
}

// cmuxUnreadPass puts cmux.UnreadPrefix on the custom title of every cmux
// workspace whose worktree has unread resources, and takes it off those whose
// worktree has none. It changes nothing else about any title, and renames
// only a workspace whose prefix is wrong, so a settled pass makes no cmux
// writes.
//
// Auto-titled workspaces (no custom title) are skipped: prefixing one would
// freeze cmux's own name for as long as the mailbox stayed. Workspaces not
// open on a registered worktree are never touched.
func (s *Server) cmuxUnreadPass() {
	if !s.cmuxEnabled() {
		return
	}
	ix := s.newUnreadIndex()
	s.syncUnreadPrefixes(func(path string) (bool, bool) {
		return s.worktreeHasUnread(ix, path)
	}, true)
}

// cmuxUnreadStrip takes cmux.UnreadPrefix off every registered worktree's
// workspace. Turning cmux features off in Settings calls it, so the mailboxes
// the sync put there do not linger once nothing keeps them up to date.
func (s *Server) cmuxUnreadStrip() {
	if !s.cmuxReachable() {
		return
	}
	s.syncUnreadPrefixes(func(string) (bool, bool) { return false, true }, false)
}

// syncUnreadPrefixes renames each workspace on a registered worktree whose
// prefix disagrees with want(path). want's ok=false leaves that worktree
// alone. gated re-checks cmuxEnabled under the title lock, so a pass that was
// waiting on it cannot re-add prefixes a strip just removed.
func (s *Server) syncUnreadPrefixes(want func(path string) (has, ok bool), gated bool) {
	// Held from list to rename so a rename typed in the UI cannot land in
	// between and be overwritten with the title read here.
	s.cmuxTitleMu.Lock()
	defer s.cmuxTitleMu.Unlock()
	if gated && !s.cmuxEnabled() {
		return
	}

	workspaces, err := s.listCmuxWorkspaces()
	if err != nil {
		return // cmux is reachable but failing; the next pass retries
	}
	entries, err := registry.List(s.DB)
	if err != nil {
		s.logger().Printf("cmux unread sync: registry.List: %v", err)
		return
	}
	paths := make([]string, 0, len(entries))
	for _, e := range entries {
		paths = append(paths, e.Path)
	}
	matches := cmux.Match(workspaces, paths)
	if len(matches) == 0 {
		return
	}

	rename := s.tabOps().rename
	for path, hits := range matches {
		has, ok := want(path)
		if !ok {
			continue // unknown is not "read": leave the mailbox as it is
		}
		for _, ws := range hits {
			if ws.CustomTitle == "" || ws.HasUnreadPrefix() == has {
				continue
			}
			if err := rename(ws.ID, cmux.WithUnreadPrefix(ws.CustomTitle, has)); err != nil {
				s.logger().Printf("cmux unread sync: %v", err)
			}
		}
	}
}

// worktreeHasUnread answers the question /api/worktrees answers with
// has_unread — any focus or related resource unread — through the same
// ix.fill and resourceHasUnread, so the mailbox and the UI's unread accent
// cannot disagree. ok is false when the worktree's resources could not be
// read.
func (s *Server) worktreeHasUnread(ix *unreadIndex, path string) (has, ok bool) {
	rs, err := resources.Load(s.DB, path)
	if err != nil {
		s.logger().Printf("cmux unread sync: resources.Load(%s): %v", path, err)
		return false, false
	}
	for _, res := range rs {
		dto := s.newResourceDTO(res)
		ix.fill(&dto)
		if resourceHasUnread(dto) {
			return true, true
		}
	}
	return false, true
}
