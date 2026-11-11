package webui

import (
	wgithub "github.com/mturley/watcher/github"

	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/prcomments"
)

// mergeBaseRef names the ref dir's branch is compared against: the base
// branch of the worktree's PR, on the remote whose URL is the PR's base
// repo, when that remote has the branch fetched. Otherwise it is
// gitutil.MainUpstream. The PR, if any, is returned either way.
func (s *Server) mergeBaseRef(dir string) (ref string, pr *prcomments.Candidate, ok bool) {
	ref, pr, ok, _ = s.mergeBaseRefFetch(dir)
	return ref, pr, ok
}

// mergeBaseRefFetch is mergeBaseRef that also reports, when the PR's base
// remote is known but does not have the base branch yet, that remote's name
// as fetchRemote, so a background fetch can bring the branch in.
func (s *Server) mergeBaseRefFetch(dir string) (ref string, pr *prcomments.Candidate, ok bool, fetchRemote string) {
	if c, found := s.worktreePR(dir); found {
		pr = &c
		if c.BaseRef != "" {
			if base, err := wgithub.ParsePRResourceID(c.ID); err == nil {
				if remote, err := gitutil.FindRemoteForRepo(dir, base.Owner, base.Repo); err == nil {
					cand := remote + "/" + c.BaseRef
					if _, ok := gitutil.RevSHA(dir, cand); ok {
						return cand, pr, true, ""
					}
					fetchRemote = remote
				}
			}
		}
	}
	ref, ok = gitutil.MainUpstream(dir)
	return ref, pr, ok, fetchRemote
}
