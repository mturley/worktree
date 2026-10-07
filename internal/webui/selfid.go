package webui

import (
	"context"
	"time"

	wconfig "github.com/mturley/watcher/config"
	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/worktree/internal/selfid"
)

// StartSelfIdentity resolves the user's per-source IDs in the background (see
// internal/selfid) and retries failures every retry interval.
func (s *Server) StartSelfIdentity(retry time.Duration) (stop func()) {
	lookups := map[string]selfid.Lookup{}
	if cfg, err := wconfig.Load(wconfig.DefaultPath()); err == nil {
		if gh, err := cfg.GitHub(); err == nil {
			lookups["github"] = func(context.Context) (string, error) { return wgithub.ViewerID(gh.Token) }
		}
		if jc, err := cfg.Jira(); err == nil {
			lookups["jira"] = func(context.Context) (string, error) { return wjira.AccountID(jc.Host, jc.Email, jc.Token) }
		}
	}
	if s.SlackClient != nil {
		lookups["slack"] = s.whoAmI
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &selfid.Resolver{DB: s.DB, Lookups: lookups, Logf: s.logger().Printf}
	go r.Run(ctx, retry)
	return cancel
}
