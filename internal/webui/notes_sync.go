package webui

import (
	"fmt"
	"sync"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/notes"
)

// notesSyncTries bounds how often one sync re-reads the notes after a
// concurrent write (the CLI, another process) changed them under it.
const notesSyncTries = 3

// notesLock locks path's notes sync and returns the unlock. It is an
// in-memory mutex, never a DB lock: it is held across cmux calls.
func (s *Server) notesLock(path string) func() {
	v, _ := s.notesMu.LoadOrStore(path, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// setCmuxDescription sets a cmux workspace's description through the
// cmuxSetDescription test seam when one is set.
func (s *Server) setCmuxDescription(id, text string) error {
	if s.cmuxSetDescription != nil {
		return s.cmuxSetDescription(id, text)
	}
	return cmux.SetWorkspaceDescription(id, text)
}

// syncNotesLocked brings path's notes and its cmux workspace description into
// agreement (notes.Decide's direction table) and returns one of the cmuxSync*
// outcomes, with why when it is not ok. The caller holds notesLock(path).
//
// listed is path's workspace from a listing the caller took earlier, or nil
// to list now. A listing taken before the lock may be stale, so a pull or
// merge decided from it is re-decided against a fresh listing first: a save
// landing between that listing and the lock must not be undone.
//
// The base advances only once both sides hold the same text. A pull or merge
// written into the notes records the description it incorporated as the base
// in the same write, so if the push that follows fails, the next sync sees
// "notes changed, cmux unchanged" and pushes again, rather than merging the
// merge result against an older base (which would nest conflict markers).
func (s *Server) syncNotesLocked(path string, listed *cmux.Workspace) (outcome, errMsg string) {
	var ws *cmux.Workspace
	fresh := false
	// agreed is text both sides were seen to hold after a push whose base
	// write lost a race with another writer; it stands in for the stored
	// base on the retry.
	var agreed *string

	for range notesSyncTries {
		n, err := notes.Get(s.DB, path)
		if err != nil {
			return cmuxSyncFailed, err.Error()
		}
		if !n.SyncCmux {
			return cmuxSyncOff, ""
		}
		if ws == nil {
			if !s.cmuxEnabled() {
				return cmuxSyncSkipped, "cmux is not available"
			}
			if listed != nil {
				w := *listed
				ws = &w
			} else {
				if ws, outcome, errMsg = s.notesWorkspace(path); ws == nil {
					return outcome, errMsg
				}
				fresh = true
			}
		}

		base, baseWS := n.CmuxBase, n.CmuxBaseWorkspace
		if agreed != nil {
			base, baseWS = agreed, ws.ID
		}
		a := notes.Decide(n.Text, ws.DescriptionText(), base, baseWS, ws.ID)
		if (a.Kind == notes.ActPull || a.Kind == notes.ActMerge) && !fresh {
			if ws, outcome, errMsg = s.relistWorkspace(ws.ID); ws == nil {
				return outcome, errMsg
			}
			fresh = true
			a = notes.Decide(n.Text, ws.DescriptionText(), base, baseWS, ws.ID)
		}

		if a.Kind == notes.ActNone {
			// Already in agreement; record it as the base unless it is.
			text := notes.Normalize(n.Text)
			if n.CmuxBase != nil && n.CmuxBaseWorkspace == ws.ID && notes.Normalize(*n.CmuxBase) == text {
				return cmuxSyncOK, ""
			}
			ok, err := notes.SetBase(s.DB, path, n.Version, &text, ws.ID)
			if err != nil {
				return cmuxSyncFailed, err.Error()
			}
			if !ok {
				continue
			}
			return cmuxSyncOK, ""
		}

		version := n.Version
		desc := notes.Normalize(ws.DescriptionText())
		if (a.Kind == notes.ActPull || a.Kind == notes.ActMerge) && notes.Normalize(n.Text) != a.Text {
			written, ok, err := notes.CompareAndSet(s.DB, path, n.Version, a.Text, n.SyncCmux, n.ShowOnHome, &desc, ws.ID)
			if err != nil {
				return cmuxSyncFailed, err.Error()
			}
			if !ok {
				continue
			}
			version = written.Version
		}

		if desc != a.Text {
			target := ws.ID
			if target == "" {
				target = ws.Ref
			}
			if err := s.setCmuxDescription(target, a.Text); err != nil {
				return cmuxSyncFailed, err.Error()
			}
			pushed := a.Text
			ws.Description = &pushed
		}

		ok, err := notes.SetBase(s.DB, path, version, &a.Text, ws.ID)
		if err != nil {
			return cmuxSyncFailed, err.Error()
		}
		if !ok {
			agreed = &a.Text
			continue
		}
		return cmuxSyncOK, ""
	}
	return cmuxSyncFailed, "notes kept changing during sync; will retry"
}

// notesWorkspace lists cmux and returns path's one workspace, or nil with the
// outcome when there is not exactly one.
func (s *Server) notesWorkspace(path string) (*cmux.Workspace, string, string) {
	workspaces, err := s.listCmuxWorkspaces()
	if err != nil {
		return nil, cmuxSyncFailed, err.Error()
	}
	hits := cmux.Match(workspaces, []string{path})[path]
	if len(hits) != 1 {
		return nil, cmuxSyncSkipped, fmt.Sprintf("expected exactly one cmux workspace, found %d", len(hits))
	}
	return &hits[0], "", ""
}

// relistWorkspace lists cmux again and returns the workspace with id, or nil
// with the outcome when it is gone.
func (s *Server) relistWorkspace(id string) (*cmux.Workspace, string, string) {
	workspaces, err := s.listCmuxWorkspaces()
	if err != nil {
		return nil, cmuxSyncFailed, err.Error()
	}
	for i := range workspaces {
		if workspaces[i].ID == id {
			return &workspaces[i], "", ""
		}
	}
	return nil, cmuxSyncSkipped, "the cmux workspace is gone"
}
