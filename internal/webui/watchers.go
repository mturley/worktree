package webui

import (
	"context"
	"errors"
	"net/http"

	watcherdb "github.com/mturley/watcher/db"
	"github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/config"
)

// Per-service watcher gates (config.WatchersConfig), set from config at
// startup and live from the Settings modal. A service whose watcher is off
// is never contacted and its credentials are never used: no polling, no
// linked-resource fetches, no self-identity lookup, and (Slack) no thread
// view, composer, live poller or authenticated file proxy. Rows already in
// the DB keep showing.

// ErrWatcherDisabled is returned by a gated client while its watcher is off.
var ErrWatcherDisabled = errors.New("watcher disabled in Settings")

func (s *Server) watcherGate(svc string) interface {
	Load() bool
	Store(bool)
} {
	switch svc {
	case config.ServiceGitHub:
		return &s.githubOff
	case config.ServiceJira:
		return &s.jiraOff
	default:
		return &s.slackOff
	}
}

// WatcherEnabled reports whether worktree may contact svc right now.
func (s *Server) WatcherEnabled(svc string) bool { return !s.watcherGate(svc).Load() }

// SetWatchersDisabled sets every gate; services absent from off are on.
func (s *Server) SetWatchersDisabled(off map[string]bool) {
	for _, svc := range config.Services {
		s.watcherGate(svc).Store(off[svc])
	}
}

// applyWatchers moves the live gates to a saved state. A service switched
// back on is polled straight away (when the poll loop runs), so it catches
// up without waiting a full interval.
func (s *Server) applyWatchers(off map[string]bool) {
	reenabled := false
	for _, svc := range config.Services {
		was := s.WatcherEnabled(svc)
		s.watcherGate(svc).Store(off[svc])
		if now := !off[svc]; now != was {
			s.logger().Printf("settings: %s watcher %s", svc, map[bool]string{true: "enabled", false: "disabled"}[now])
			reenabled = reenabled || now
		}
	}
	if reenabled && s.pollingStarted.Load() {
		go s.safePollAll()
	}
}

// watcherStates is the DTO form: service → enabled.
func (s *Server) watcherStates() map[string]bool {
	out := map[string]bool{}
	for _, svc := range config.Services {
		out[svc] = s.WatcherEnabled(svc)
	}
	return out
}

// watcherHealth is one service's entry in GET /api/watchers/health.
type watcherHealth struct {
	Enabled bool `json:"enabled"`
	// Failing: every one of the service's polled resources failed its
	// latest poll — bad credentials or no network, most likely. One
	// successful poll clears it. Always false while disabled.
	Failing bool `json:"failing"`
	// Error is the newest failure message, when Failing.
	Error string `json:"error,omitempty"`
}

// handleWatcherHealth: GET /api/watchers/health — per service, whether its
// watcher is on and whether it is failing. Read from the per-resource poll
// status the library records, so it needs no state of its own and clears
// itself on the first successful poll.
func (s *Server) handleWatcherHealth(w http.ResponseWriter, r *http.Request) {
	out := map[string]watcherHealth{}
	for _, svc := range config.Services {
		h := watcherHealth{Enabled: s.WatcherEnabled(svc)}
		if h.Enabled && s.DB != nil {
			h.Failing, h.Error = s.serviceFailing(resourceTypeFor(svc))
		}
		out[svc] = h
	}
	writeJSON(w, http.StatusOK, out)
}

func resourceTypeFor(svc string) string {
	return map[string]string{config.ServiceGitHub: "pr", config.ServiceJira: "jira", config.ServiceSlack: "slack"}[svc]
}

// serviceFailing reports whether every active resource of resourceType that
// has been polled failed its latest poll, and the newest error message.
func (s *Server) serviceFailing(resourceType string) (bool, string) {
	rs, err := watcherdb.ActiveResources(s.DB, resourceType)
	if err != nil || len(rs) == 0 {
		return false, ""
	}
	statuses, err := watcherdb.GetResourcePollStatuses(s.DB, rs)
	if err != nil || len(statuses) == 0 {
		return false, ""
	}
	newest, msg := "", ""
	for _, st := range statuses {
		if !st.Failing() {
			return false, ""
		}
		if st.LastError > newest {
			newest, msg = st.LastError, st.LastErrorMessage
		}
	}
	return true, msg
}

// serviceForType maps a resource type to its service, or "" for a type no
// watcher covers (links).
func serviceForType(resourceType string) string {
	switch resourceType {
	case "pr":
		return config.ServiceGitHub
	case "jira":
		return config.ServiceJira
	case "slack":
		return config.ServiceSlack
	}
	return ""
}

// serviceName is svc's display name.
func serviceName(svc string) string {
	return map[string]string{config.ServiceGitHub: "GitHub", config.ServiceJira: "Jira", config.ServiceSlack: "Slack"}[svc]
}

// slackOn is the guard every Slack-backed handler checks first.
func (s *Server) slackOn() bool { return s.SlackClient != nil && s.WatcherEnabled(config.ServiceSlack) }

// watcherOffError writes the 503 for a request that needs svc while its
// watcher is off. The UI shows the message as is.
func watcherOffError(w http.ResponseWriter, name string) {
	writeError(w, http.StatusServiceUnavailable, "The "+name+" watcher is disabled in Settings")
}

// GateSlack wraps c so that every call fails with ErrWatcherDisabled while
// on() is false, without touching the network. cmd/ui.go installs it as
// both the server's client and the live-thread poller's, so no Slack call
// anywhere can slip past the Settings toggle.
func GateSlack(c slack.Client, on func() bool) slack.Client {
	if c == nil {
		return nil
	}
	return gatedSlack{c: c, on: on}
}

type gatedSlack struct {
	c  slack.Client
	on func() bool
}

func (g gatedSlack) ok() error {
	if !g.on() {
		return ErrWatcherDisabled
	}
	return nil
}

func (g gatedSlack) AuthTest(ctx context.Context) error {
	if err := g.ok(); err != nil {
		return err
	}
	return g.c.AuthTest(ctx)
}

func (g gatedSlack) WhoAmI(ctx context.Context) (string, error) {
	if err := g.ok(); err != nil {
		return "", err
	}
	return g.c.WhoAmI(ctx)
}

func (g gatedSlack) Replies(ctx context.Context, channel, threadTS string) (slack.Thread, error) {
	if err := g.ok(); err != nil {
		return slack.Thread{}, err
	}
	return g.c.Replies(ctx, channel, threadTS)
}

func (g gatedSlack) Users(ctx context.Context, ids []string) (map[string]slack.User, error) {
	if err := g.ok(); err != nil {
		return nil, err
	}
	return g.c.Users(ctx, ids)
}

func (g gatedSlack) Channel(ctx context.Context, id string) (string, error) {
	if err := g.ok(); err != nil {
		return "", err
	}
	return g.c.Channel(ctx, id)
}

func (g gatedSlack) Emoji(ctx context.Context) (map[string]string, error) {
	if err := g.ok(); err != nil {
		return nil, err
	}
	return g.c.Emoji(ctx)
}

func (g gatedSlack) UserGroups(ctx context.Context) (map[string]slack.UserGroup, error) {
	if err := g.ok(); err != nil {
		return nil, err
	}
	return g.c.UserGroups(ctx)
}

func (g gatedSlack) UserGroupsInfo(ctx context.Context, ids []string) (map[string]slack.UserGroup, error) {
	if err := g.ok(); err != nil {
		return nil, err
	}
	return g.c.UserGroupsInfo(ctx, ids)
}

func (g gatedSlack) SearchUsers(ctx context.Context, query, currentChannel string, limit int) ([]slack.User, error) {
	if err := g.ok(); err != nil {
		return nil, err
	}
	return g.c.SearchUsers(ctx, query, currentChannel, limit)
}

func (g gatedSlack) SearchUserGroups(ctx context.Context, query string, limit int) ([]slack.UserGroup, error) {
	if err := g.ok(); err != nil {
		return nil, err
	}
	return g.c.SearchUserGroups(ctx, query, limit)
}

func (g gatedSlack) SearchChannels(ctx context.Context, query string, limit int) ([]slack.Channel, error) {
	if err := g.ok(); err != nil {
		return nil, err
	}
	return g.c.SearchChannels(ctx, query, limit)
}

func (g gatedSlack) MarkRead(ctx context.Context, channel, threadTS, ts string) error {
	if err := g.ok(); err != nil {
		return err
	}
	return g.c.MarkRead(ctx, channel, threadTS, ts)
}

func (g gatedSlack) MarkUnread(ctx context.Context, channel, threadTS, ts string) error {
	if err := g.ok(); err != nil {
		return err
	}
	return g.c.MarkUnread(ctx, channel, threadTS, ts)
}

func (g gatedSlack) PostReply(ctx context.Context, channel, threadTS, text string) (slack.Message, error) {
	if err := g.ok(); err != nil {
		return slack.Message{}, err
	}
	return g.c.PostReply(ctx, channel, threadTS, text)
}

func (g gatedSlack) AddReaction(ctx context.Context, channel, ts, name string) error {
	if err := g.ok(); err != nil {
		return err
	}
	return g.c.AddReaction(ctx, channel, ts, name)
}

func (g gatedSlack) RemoveReaction(ctx context.Context, channel, ts, name string) error {
	if err := g.ok(); err != nil {
		return err
	}
	return g.c.RemoveReaction(ctx, channel, ts, name)
}
