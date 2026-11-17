package webui

import (
	"fmt"
	"sync"
	"time"

	"github.com/mturley/worktree/internal/gitutil"
)

// workingTTL bounds how long the working tier (counts and fingerprints) is
// trusted: unstaged edits touch no stamped file, so only time reveals them.
const workingTTL = 10 * time.Second

// gitComputed is the cached part of a /api/worktree-git response plus what a
// later request needs to refresh it or to start a fetch.
type gitComputed struct {
	dto        worktreeGitDTO // everything except Fetch, OnDisk, Directory
	refs       []string       // [main upstream, tracking], those present; for fetch=1 RemotesFor and fingerprints
	baseRemote string

	// The ref tier's view of HEAD, for the working refresh's safety net, and
	// the ref SHAs folded into the full fingerprint.
	headSHA, branch, upstream string
	refSHAs                   map[string]string
}

type gitCacheEntry struct {
	stamp     gitutil.Stamp // taken before the compute that produced val
	prKey     string
	workingAt time.Time
	val       gitComputed
}

type gitCall struct {
	done chan struct{}
	val  gitComputed
}

// worktreeGitCache holds one entry per worktree path in two tiers (see
// get) and lets concurrent requests for a path share one computation.
type worktreeGitCache struct {
	mu       sync.Mutex
	entries  map[string]*gitCacheEntry
	inflight map[string]*gitCall
	now      func() time.Time
}

func newWorktreeGitCache() *worktreeGitCache {
	return &worktreeGitCache{
		entries:  map[string]*gitCacheEntry{},
		inflight: map[string]*gitCall{},
		now:      time.Now,
	}
}

// get returns path's git state. The ref tier is valid while the refs stamp
// and prKey are unchanged; the working tier additionally needs the index
// stamp unchanged and to be younger than workingTTL. Both valid: the stored
// value. Ref tier only: refresh(stored) (nil, or false from it, falls back
// to compute). Otherwise compute. The stamp is taken before either runs and
// stored with the result, so a change landing mid-compute shows on the next
// call. Concurrent calls for the same path wait for one leader's result.
func (c *worktreeGitCache) get(path, prKey string, compute func() gitComputed, refresh func(gitComputed) (gitComputed, bool)) gitComputed {
	c.mu.Lock()
	if call, ok := c.inflight[path]; ok {
		c.mu.Unlock()
		<-call.done
		return call.val
	}
	call := &gitCall{done: make(chan struct{})}
	c.inflight[path] = call
	prev := c.entries[path]
	c.mu.Unlock()

	// Deferred so a panicking compute still releases waiters (they get the
	// zero value, which renders as an empty status) and later calls.
	defer func() {
		c.mu.Lock()
		delete(c.inflight, path)
		c.mu.Unlock()
		close(call.done)
	}()
	call.val = c.load(path, prKey, prev, compute, refresh)
	return call.val
}

// load runs outside c.mu; only the singleflight leader for path calls it.
func (c *worktreeGitCache) load(path, prKey string, prev *gitCacheEntry, compute func() gitComputed, refresh func(gitComputed) (gitComputed, bool)) gitComputed {
	stamp, err := gitutil.StateStamp(path)
	if err != nil {
		// Unstampable (not a repository?): compute uncached.
		c.store(path, nil)
		return compute()
	}
	now := c.now()
	if prev != nil && prev.stamp.Refs == stamp.Refs && prev.prKey == prKey {
		if prev.stamp.Index == stamp.Index && now.Sub(prev.workingAt) < workingTTL {
			return prev.val
		}
		if refresh != nil {
			if v, ok := refresh(prev.val); ok {
				c.store(path, &gitCacheEntry{stamp: stamp, prKey: prKey, workingAt: now, val: v})
				return v
			}
		}
	}
	v := compute()
	c.store(path, &gitCacheEntry{stamp: stamp, prKey: prKey, workingAt: now, val: v})
	return v
}

func (c *worktreeGitCache) store(path string, e *gitCacheEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e == nil {
		delete(c.entries, path)
		return
	}
	c.entries[path] = e
}

// expireWorking marks path's working tier stale, so the next get refreshes
// it (one status via the ref-tier path) even though the index stamp has not
// moved. Called after the diff endpoint computed a fresher working
// fingerprint, which would otherwise disagree with the cached one for up to
// workingTTL.
func (c *worktreeGitCache) expireWorking(path string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.entries[path]; ok {
		e.workingAt = time.Time{}
	}
}

// forget drops path's entry (the worktree is gone from disk).
func (c *worktreeGitCache) forget(path string) { c.store(path, nil) }

// worktreeGitCache returns the server's cache, creating it on first use.
func (s *Server) worktreeGitCache() *worktreeGitCache {
	s.gitCacheMu.Lock()
	defer s.gitCacheMu.Unlock()
	if s.gitCache == nil {
		s.gitCache = newWorktreeGitCache()
	}
	return s.gitCache
}

// cachedWorktreeGit is computeWorktreeGit through the cache.
func (s *Server) cachedWorktreeGit(path string) gitComputed {
	// The PR candidates come from the database (no process); the git inputs
	// that pick among them (branch upstream config, remote URLs) are stamped.
	prKey := fmt.Sprintf("%+v", s.worktreePRCandidates(path))
	return s.worktreeGitCache().get(path, prKey,
		func() gitComputed { return s.computeWorktreeGit(path) },
		func(prev gitComputed) (gitComputed, bool) { return refreshWorking(path, prev) })
}

// computeWorktreeGit is the full compute: one status for branch, tracking,
// working state and HEAD, then the merge-base ref and its comparisons.
func (s *Server) computeWorktreeGit(path string) gitComputed {
	var c gitComputed
	bs, ws, fp, statusErr := gitutil.StatusV2(path)
	c.headSHA, c.branch, c.upstream = bs.HeadSHA, bs.Branch, bs.Upstream
	c.dto.Branch = bs.Branch

	up, pr, ok, baseRemote := s.mergeBaseRefFetch(path)
	c.baseRemote = baseRemote
	c.refSHAs = map[string]string{}
	if pr != nil {
		id := pr.ID
		c.dto.PR = &id
	}
	if ok {
		c.dto.MainUpstream = &up
		c.refs = append(c.refs, up)
		c.refSHAs[up], _ = gitutil.RevSHA(path, up)
		if mb, ok := gitutil.MergeBase(path, up); ok {
			c.dto.MergeBase = &mb
		}
		if a, b, ok := gitutil.AheadBehind(path, up); ok {
			c.dto.VsMergeBase = &aheadBehindDTO{Ahead: a, Behind: b}
		}
	}
	// branch.ab is present only when the upstream resolves, matching what
	// HEAD@{upstream} reported before.
	if bs.Upstream != "" && bs.HasAB {
		tr := bs.Upstream
		c.dto.Tracking = &tr
		c.dto.VsTracking = &aheadBehindDTO{Ahead: bs.Ahead, Behind: bs.Behind}
		c.refs = append(c.refs, tr)
		if _, seen := c.refSHAs[tr]; !seen {
			c.refSHAs[tr], _ = gitutil.RevSHA(path, tr)
		}
	}
	if statusErr == nil {
		setWorking(&c, ws, fp)
	}
	return c
}

// refreshWorking rebuilds the working tier with one status, reusing the ref
// tier. false (forcing a full compute) when status fails or HEAD, branch or
// upstream moved without the refs stamp noticing.
func refreshWorking(path string, prev gitComputed) (gitComputed, bool) {
	bs, ws, fp, err := gitutil.StatusV2(path)
	if err != nil || bs.HeadSHA != prev.headSHA || bs.Branch != prev.branch || bs.Upstream != prev.upstream {
		return gitComputed{}, false
	}
	c := prev
	setWorking(&c, ws, fp)
	return c, true
}

func setWorking(c *gitComputed, ws gitutil.WorkingSummary, fp gitutil.Fingerprint) {
	c.dto.Working = workingDTO{Staged: ws.Staged, Modified: ws.Modified, Untracked: ws.Untracked, Files: ws.Files}
	c.dto.WorkingFingerprint = fp.Working
	c.dto.Fingerprint = gitutil.FullFingerprint(c.headSHA, c.refs, c.refSHAs, fp.Working)
}
