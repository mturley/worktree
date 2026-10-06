package webui

import (
	"sync"
	"time"

	"github.com/mturley/worktree/internal/cmux"
)

const (
	notifyModeCmux    = "cmux"
	notifyModeBrowser = "browser"
)

// notifyMode picks the delivery path once per process: cmux when the server
// can reach it (IsAvailable, not InPane: the server drives cmux from wherever
// it runs), else browser tabs. The two never both fire.
func (s *Server) notifyMode() string {
	s.notifyOnce.Do(func() {
		avail := cmux.IsAvailable
		if s.cmuxAvailable != nil {
			avail = s.cmuxAvailable
		}
		if avail() {
			s.notifyModeName, s.transport = notifyModeCmux, &cmuxTransport{s: s}
		} else {
			s.notifyModeName, s.transport = notifyModeBrowser, s.tabRegistry()
		}
	})
	if s.notifyModeName == "" { // transport pinned by a test
		return notifyModeBrowser
	}
	return s.notifyModeName
}

// deliver sends b through the active transport.
func (s *Server) deliver(b notifyBatch, o deliverOpts) {
	s.notifyMode()
	s.transport.Deliver(b, o)
}

// cmuxTransport posts `cmux notify` targeted at the worktree's workspace, so
// clicking the banner switches to it. With no matching workspace it posts
// untargeted (landing on the UI server's own workspace) rather than dropping
// the notification; the subtitle still names the worktree. A failure is
// logged and dropped: retrying a broken cmux would only stack up banners.
type cmuxTransport struct{ s *Server }

func (t *cmuxTransport) Deliver(b notifyBatch, _ deliverOpts) {
	s := t.s
	list := cmux.ListWorkspaces
	if s.cmuxList != nil {
		list = s.cmuxList
	}
	notify := cmux.Notify
	if s.cmuxNotify != nil {
		notify = s.cmuxNotify
	}
	target := ""
	if ws, err := list(); err != nil {
		s.logger().Printf("notify: listing cmux workspaces: %v", err)
	} else if hits := cmux.Match(ws, []string{b.WorktreePath})[b.WorktreePath]; len(hits) > 0 {
		target = hits[0].ID
		if target == "" {
			target = hits[0].Ref
		}
	}
	if err := notify(cmux.NotifyOptions{Title: b.Title, Subtitle: b.Subtitle, Body: b.Body, Workspace: target}); err != nil {
		s.logger().Printf("notify: %v", err)
	}
}

// notifyPass reads past the cursor and delivers one notification per
// (worktree, resource). The cursor advances whether or not delivery works.
func (s *Server) notifyPass(c *notifyCursor) {
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
	for _, b := range batches {
		s.deliver(b, deliverOpts{})
	}
}

// StartNotifier runs notifyPass every interval until stop is called. It
// keeps its own cursor rather than hooking the pollers: they write straight
// to the DB, and on-demand polls (handlePollWorktree) write too.
func (s *Server) StartNotifier(interval time.Duration) (stop func()) {
	c, err := initNotifyCursor(s.DB)
	if err != nil {
		s.logger().Printf("notify: starting cursor: %v", err)
	}
	s.logger().Printf("notifications: %s mode", s.notifyMode())
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
