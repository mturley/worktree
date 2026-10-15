package webui

import (
	"fmt"
	"path/filepath"
	"sync"
	"time"

	"github.com/mturley/worktree/internal/cmux"
)

const (
	notifyModeCmux    = "cmux"
	notifyModeBrowser = "browser"
)

// notifyMaxPerPass caps how many notifications one pass may fire; past it the
// pass sends a single summary instead.
const notifyMaxPerPass = 5

// notifyMode is the delivery path: cmux while cmux features are enabled
// (see cmuxEnabled), else browser tabs. The two never both fire. It is
// decided on every delivery, so the Settings toggle takes effect at once.
func (s *Server) notifyMode() string {
	if s.transport == nil && s.cmuxEnabled() {
		return notifyModeCmux
	}
	return notifyModeBrowser // or a transport pinned by a test
}

// deliver sends b through the active transport, and runs the custom
// notification command alongside it. With notifications turned off in
// Settings it does nothing.
func (s *Server) deliver(b notifyBatch, o deliverOpts) {
	if !s.notificationsEnabled() {
		return
	}
	if cmd := s.notifyCommandLine(); cmd != "" {
		go s.runNotifyCommand(cmd, b)
	}
	switch {
	case s.transport != nil:
		s.transport.Deliver(b, o)
	case s.notifyMode() == notifyModeCmux:
		(&cmuxTransport{s: s}).Deliver(b, o)
	default:
		s.tabRegistry().Deliver(b, o)
	}
}

// cmuxTransport posts `cmux notify` targeted at the worktree's workspace, so
// clicking the banner switches to it. With no matching workspace it posts
// untargeted (landing on the UI server's own workspace) rather than dropping
// the notification; the subtitle still names the worktree. A failure is
// logged and dropped: retrying a broken cmux would only stack up banners.
type cmuxTransport struct{ s *Server }

func (t *cmuxTransport) Deliver(b notifyBatch, _ deliverOpts) {
	s := t.s
	list := s.listCmuxWorkspaces
	notify := cmux.Notify
	if s.cmuxNotify != nil {
		notify = s.cmuxNotify
	}
	// A summary spanning worktrees has no one workspace to switch to.
	target := ""
	if b.WorktreePath != "" {
		if ws, err := list(); err != nil {
			s.logger().Printf("notify: listing cmux workspaces: %v", err)
		} else if hits := cmux.Match(ws, []string{b.WorktreePath})[b.WorktreePath]; len(hits) > 0 {
			target = hits[0].ID
			if target == "" {
				target = hits[0].Ref
			}
		}
	}
	if err := notify(cmux.NotifyOptions{Title: b.Title, Subtitle: b.Subtitle, Body: b.Body, Workspace: target}); err != nil {
		s.logger().Printf("notify: %v", err)
	}
}

// notifyPass reads past the cursor and delivers one notification per
// (worktree, resource). The cursor advances whether or not delivery works.
func (s *Server) notifyPass(c *notifyCursor) {
	if !c.ready {
		// Never read with an uninitialised cursor: it would treat the whole
		// history as new. Retry the initialisation instead, and start
		// notifying from the pass after it succeeds.
		nc, err := initNotifyCursor(s.DB)
		if err != nil {
			s.logger().Printf("notify: starting cursor: %v", err)
			return
		}
		*c = nc
		return
	}
	events, next, err := readNewEvents(s.DB, *c)
	if err != nil {
		s.logger().Printf("notify: reading events: %v", err)
		return
	}
	*c = next
	batches, err := s.notifyBatches(events)
	if err != nil {
		s.logger().Printf("notify: matching events: %v", err)
		return
	}
	if len(batches) > notifyMaxPerPass {
		batches = []notifyBatch{summarizeBatches(batches)}
	}
	for _, b := range batches {
		s.deliver(b, deliverOpts{})
	}
}

// summarizeBatches folds a burst into one notification. Whatever caused the
// burst (a backlog after sleep, a poll after a long outage, a bug), it must
// never become a wall of banners. A summary for a single worktree still
// targets it; one spanning several targets none.
func summarizeBatches(batches []notifyBatch) notifyBatch {
	paths := map[string]bool{}
	for _, b := range batches {
		paths[b.WorktreePath] = true
	}
	sum := notifyBatch{
		Title: "New activity",
		Body:  fmt.Sprintf("%d resources have new events", len(batches)),
		Tag:   "worktree:summary",
	}
	sum.Event, sum.Description = sum.Title, sum.Body
	if len(paths) == 1 {
		sum.WorktreePath = batches[0].WorktreePath
		sum.Subtitle = filepath.Base(sum.WorktreePath)
		sum.Tag = notifyTag(sum.WorktreePath, "", "")
	} else {
		sum.Subtitle = fmt.Sprintf("in %d worktrees", len(paths))
	}
	return sum
}

// StartNotifier runs notifyPass every interval until stop is called. It
// keeps its own cursor rather than hooking the pollers: they write straight
// to the DB, and on-demand polls (handlePollWorktree) write too.
func (s *Server) StartNotifier(interval time.Duration) (stop func()) {
	// On failure c stays not-ready, and each pass retries the initialisation.
	c, err := initNotifyCursor(s.DB)
	if err != nil {
		s.logger().Printf("notify: starting cursor: %v", err)
		c = notifyCursor{}
	}
	if s.notificationsEnabled() {
		s.logger().Printf("notifications: %s mode", s.notifyMode())
	} else {
		s.logger().Printf("notifications: disabled in settings")
	}
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				s.notifyPass(&c)
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(done) }) }
}
