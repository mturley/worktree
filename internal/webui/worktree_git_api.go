package webui

import (
	"context"
	"net/http"
	"os"
	"time"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/gitfetch"
	"github.com/mturley/worktree/internal/gitutil"
)

type aheadBehindDTO struct {
	Ahead  int `json:"ahead"`
	Behind int `json:"behind"`
}

type workingDTO struct {
	Staged    int `json:"staged"`
	Modified  int `json:"modified"`
	Untracked int `json:"untracked"`
	Files     int `json:"files"`
}

type worktreeGitDTO struct {
	OnDisk bool `json:"on_disk"`
	// Fingerprint moves on commits, fetches, branch switches and working-tree
	// edits; WorkingFingerprint only on the latter. The Code tab polls this
	// endpoint and refetches the diff when one of them changes.
	Fingerprint        string          `json:"fingerprint"`
	WorkingFingerprint string          `json:"working_fingerprint"`
	Branch             string          `json:"branch"` // empty when detached
	MainUpstream       *string         `json:"main_upstream,omitempty"`
	MergeBase          *string         `json:"merge_base,omitempty"`
	VsMergeBase        *aheadBehindDTO `json:"vs_merge_base,omitempty"`
	Tracking           *string         `json:"tracking,omitempty"`
	VsTracking         *aheadBehindDTO `json:"vs_tracking,omitempty"`
	Working            workingDTO      `json:"working"`
	Fetch              gitfetch.State  `json:"fetch"`
}

// handleWorktreeGit: GET /api/worktree-git?path=<path>[&fetch=1]
//
// The Code tab's polled status: where the branch forks from main, how it
// relates to its tracking branch, working-tree counts and fingerprints. It
// sits beside /api/worktree-info rather than replacing its `git` field, which
// the delete button still reads.
//
// With fetch=1 it also nudges the background fetch scheduler (when the
// setting is on); the response never waits for it — the fetch state reported
// is whatever it is at that moment.
func (s *Server) handleWorktreeGit(w http.ResponseWriter, r *http.Request) {
	path, ok := s.registeredWorktreePath(w, r)
	if !ok {
		return
	}

	// A registered worktree can be gone from disk; report that and compute
	// nothing, so the UI can say so instead of showing a git error.
	if st, err := os.Stat(path); err != nil || !st.IsDir() {
		writeJSON(w, http.StatusOK, worktreeGitDTO{})
		return
	}

	// Read per request, like the editor endpoint, so the Settings switch
	// applies at once.
	e, _, err := config.ReadEditable(s.configPath())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reading config: "+err.Error())
		return
	}
	fetcher := s.fetchScheduler(config.GitConfig{FetchInterval: e.FetchInterval}.Interval())

	out := worktreeGitDTO{OnDisk: true}
	if b, ok := gitutil.CurrentBranch(path); ok {
		out.Branch = b
	}

	var refs []string
	if up, ok := gitutil.MainUpstream(path); ok {
		out.MainUpstream = &up
		refs = append(refs, up)
		if mb, ok := gitutil.MergeBase(path, up); ok {
			out.MergeBase = &mb
		}
		if a, b, ok := gitutil.AheadBehind(path, up); ok {
			out.VsMergeBase = &aheadBehindDTO{Ahead: a, Behind: b}
		}
	}
	if tr, ok := gitutil.TrackingBranch(path); ok {
		out.Tracking = &tr
		refs = append(refs, tr)
		if a, b, ok := gitutil.AheadBehind(path, tr); ok {
			out.VsTracking = &aheadBehindDTO{Ahead: a, Behind: b}
		}
	}
	if ws, ok := gitutil.WorkingCounts(path); ok {
		out.Working = workingDTO{Staged: ws.Staged, Modified: ws.Modified, Untracked: ws.Untracked, Files: ws.Files}
	}
	if fp, err := gitutil.ComputeFingerprint(path, refs...); err == nil {
		out.Fingerprint, out.WorkingFingerprint = fp.Full, fp.Working
	}

	if r.URL.Query().Get("fetch") == "1" && e.BackgroundFetch {
		if remotes := gitfetch.RemotesFor(path, refs...); len(remotes) > 0 {
			fetcher.Maybe(path, remotes)
		}
	}
	out.Fetch = fetcher.State(path)
	writeJSON(w, http.StatusOK, out)
}

// fetchScheduler returns the server's fetch scheduler, creating it on first
// use with the server-lifetime context that Serve cancels.
func (s *Server) fetchScheduler(interval time.Duration) *gitfetch.Scheduler {
	s.fetcherMu.Lock()
	defer s.fetcherMu.Unlock()
	if s.fetcher == nil {
		ctx, cancel := context.WithCancel(context.Background())
		s.fetcherCancel = cancel
		s.fetcher = gitfetch.New(ctx, interval)
	}
	return s.fetcher
}

// stopFetcher cancels any in-flight background fetch; Serve defers it.
func (s *Server) stopFetcher() {
	s.fetcherMu.Lock()
	defer s.fetcherMu.Unlock()
	if s.fetcherCancel != nil {
		s.fetcherCancel()
	}
}
