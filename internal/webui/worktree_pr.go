package webui

import (
	"encoding/json"
	"strings"

	watcherdb "github.com/mturley/watcher/db"
	wgithub "github.com/mturley/watcher/github"

	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/prcomments"
	"github.com/mturley/worktree/internal/resources"
)

// prHeadState is the part of a PR's cached state (watcher_resource_state)
// that says where its head branch lives. State written before watcher
// v0.25.0 has none of it.
type prHeadState struct {
	HeadRefName   string `json:"head_ref_name"`
	BaseRefName   string `json:"base_ref_name"`
	HeadRepoOwner string `json:"head_repo_owner"`
	HeadRepoName  string `json:"head_repo_name"`
}

// worktreePR is the followed PR dir's current branch tracks
// (prcomments.PickPR has the rule), judged from local git and the PR's
// cached state alone: it never contacts GitHub, so it is not gated on the
// GitHub watcher.
func (s *Server) worktreePR(dir string) (prcomments.Candidate, bool) {
	tracked, err := resources.Load(s.DB, dir)
	if err != nil {
		return prcomments.Candidate{}, false
	}
	prs := resources.OfType(tracked, "pr")
	if len(prs) == 0 {
		return prcomments.Candidate{}, false
	}
	remote, merge, ok := gitutil.BranchUpstream(dir)
	if !ok {
		return prcomments.Candidate{}, false
	}
	var cands []prcomments.Candidate
	for _, r := range prs {
		ref, err := wgithub.ParsePRResourceID(r.ID)
		if err != nil {
			continue
		}
		c := prcomments.Candidate{
			ID: r.ID, Primary: !r.Related, Number: ref.Number,
			BaseSlug: strings.ToLower(ref.Owner + "/" + ref.Repo),
		}
		if st, err := watcherdb.GetResourceState(s.DB, "pr", r.ID); err == nil && st != nil {
			// When the PR last changed on GitHub, else when the row was written.
			c.UpdatedAt = st.ResourceUpdatedAt
			if c.UpdatedAt == "" {
				c.UpdatedAt = st.WatcherUpdatedAt
			}
			var h prHeadState
			if json.Unmarshal([]byte(st.StateJSON), &h) == nil {
				c.HeadRef, c.BaseRef = h.HeadRefName, h.BaseRefName
				if h.HeadRepoOwner != "" && h.HeadRepoName != "" {
					c.HeadSlug = strings.ToLower(h.HeadRepoOwner + "/" + h.HeadRepoName)
				}
			}
		}
		cands = append(cands, c)
	}
	return prcomments.PickPR(cands, prcomments.Upstream{Slug: gitutil.RemoteSlug(dir, remote), Merge: merge})
}
