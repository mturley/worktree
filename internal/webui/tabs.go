package webui

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
)

// deliverOpts narrows a delivery. Both fields are for the browser path only:
// a test notification goes to the session that asked for it, starting with
// the tab that asked.
type deliverOpts struct {
	PreferTab   string
	OnlySession string
}

// notifyTransport is the server's single delivery path: cmux or browser tabs.
type notifyTransport interface {
	Deliver(b notifyBatch, o deliverOpts)
}

// notificationMsg is the `notification` SSE payload.
type notificationMsg struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Subtitle     string `json:"subtitle"`
	Body         string `json:"body"`
	WorktreePath string `json:"worktree_path"`
	ResourceType string `json:"resource_type"`
	ResourceID   string `json:"resource_id"`
	Tag          string `json:"tag"`
}

type tabEntry struct {
	session    string
	route      string
	visible    bool
	lastActive time.Time
	send       chan notificationMsg
}

// tabRegistry knows every open tab's stream, session, route and visibility,
// so a browser notification can come out of exactly one tab per session.
type tabRegistry struct {
	mu         sync.Mutex
	tabs       map[string]*tabEntry
	acks       map[string]chan bool
	ackTimeout time.Duration
	now        func() time.Time
}

func newTabRegistry() *tabRegistry {
	return &tabRegistry{
		tabs:       map[string]*tabEntry{},
		acks:       map[string]chan bool{},
		ackTimeout: 5 * time.Second,
		now:        time.Now,
	}
}

func (s *Server) tabRegistry() *tabRegistry {
	s.tabsOnce.Do(func() { s.tabs = newTabRegistry() })
	return s.tabs
}

// register adds or replaces tab id. done removes it only if it is still this
// registration: a reconnecting tab registers again before the old stream's
// handler returns, and that late cleanup must not remove the new one.
func (r *tabRegistry) register(id, session, route string, visible bool) (<-chan notificationMsg, func()) {
	e := &tabEntry{session: session, route: route, visible: visible, lastActive: r.now(), send: make(chan notificationMsg, 4)}
	r.mu.Lock()
	r.tabs[id] = e
	r.mu.Unlock()
	return e.send, func() {
		r.mu.Lock()
		if r.tabs[id] == e {
			delete(r.tabs, id)
		}
		r.mu.Unlock()
	}
}

// update records a presence report. False when the tab is unknown or belongs
// to another session, which the handler reports as 404.
func (r *tabRegistry) update(id, session, route string, visible bool) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.tabs[id]
	if e == nil || e.session != session {
		return false
	}
	e.route, e.visible = route, visible
	if visible {
		e.lastActive = r.now()
	}
	return true
}

// ack resolves a pending notification; false for an unknown tab, another
// session's tab, or a notification nobody is waiting on any more.
func (r *tabRegistry) ack(id, session, notificationID string, shown bool) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e := r.tabs[id]; e == nil || e.session != session {
		return false
	}
	ch := r.acks[notificationID]
	if ch == nil {
		return false
	}
	delete(r.acks, notificationID)
	ch <- shown // buffered 1
	return true
}

// routeWorktree extracts the worktree path from a /worktree/<escaped> route.
func routeWorktree(route string) (string, bool) {
	rest, ok := strings.CutPrefix(route, "/worktree/")
	if !ok || rest == "" {
		return "", false
	}
	p, err := url.PathUnescape(rest)
	return p, err == nil
}

func urlPathEscape(p string) string { return url.PathEscape(p) }

// candidates orders session's tabs for a notification about path: the
// preferred tab, then tabs on that worktree's page, then the home page, then
// the rest; visible before hidden, then most recently active.
func (r *tabRegistry) candidates(path, session, prefer string) []string {
	want := wdb.Subscriber(path)
	rank := func(id string, e *tabEntry) int {
		if id == prefer {
			return 0
		}
		if wt, ok := routeWorktree(e.route); ok && wdb.Subscriber(wt) == want {
			return 1
		}
		if e.route == "/" {
			return 2
		}
		return 3
	}
	type cand struct {
		id      string
		rank    int
		visible bool
		active  time.Time
	}
	r.mu.Lock()
	var cs []cand
	for id, e := range r.tabs {
		if e.session == session {
			cs = append(cs, cand{id, rank(id, e), e.visible, e.lastActive})
		}
	}
	r.mu.Unlock()
	sort.Slice(cs, func(i, j int) bool {
		a, b := cs[i], cs[j]
		if a.rank != b.rank {
			return a.rank < b.rank
		}
		if a.visible != b.visible {
			return a.visible
		}
		return a.active.After(b.active)
	})
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.id
	}
	return out
}

func newNotificationID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// deliverToSession offers b to session's tabs in candidate order until one
// shows it. A negative ack moves on at once; silence moves on after
// ackTimeout, which covers a tab the browser has frozen with its stream
// still open. Each offer has its own ID, so a late ack from an earlier tab
// can never be mistaken for the current one.
func (r *tabRegistry) deliverToSession(b notifyBatch, session, prefer string) bool {
	for _, id := range r.candidates(b.WorktreePath, session, prefer) {
		r.mu.Lock()
		e := r.tabs[id]
		r.mu.Unlock()
		if e == nil {
			continue
		}
		msg := notificationMsg{ID: newNotificationID(), Title: b.Title, Subtitle: b.Subtitle, Body: b.Body,
			WorktreePath: b.WorktreePath, ResourceType: b.ResourceType, ResourceID: b.ResourceID, Tag: b.Tag}
		ch := make(chan bool, 1)
		r.mu.Lock()
		r.acks[msg.ID] = ch
		r.mu.Unlock()
		// Several batches can land in one pass, each in its own goroutine,
		// and the stream writes them one at a time; wait for room rather
		// than treating a briefly busy stream as a decline. A stream that
		// stays full for a whole ack timeout is as good as frozen.
		select {
		case e.send <- msg:
		case <-time.After(r.ackTimeout):
			r.mu.Lock()
			delete(r.acks, msg.ID)
			r.mu.Unlock()
			continue
		}
		shown := false
		select {
		case shown = <-ch:
		case <-time.After(r.ackTimeout):
		}
		r.mu.Lock()
		delete(r.acks, msg.ID)
		r.mu.Unlock()
		if shown {
			return true
		}
	}
	return false
}

// Deliver offers b once per session with an open tab (or only o.OnlySession),
// each in its own goroutine so a slow session never delays another.
func (r *tabRegistry) Deliver(b notifyBatch, o deliverOpts) {
	r.mu.Lock()
	sessions := map[string]bool{}
	for _, e := range r.tabs {
		if o.OnlySession == "" || e.session == o.OnlySession {
			sessions[e.session] = true
		}
	}
	r.mu.Unlock()
	for sess := range sessions {
		go r.deliverToSession(b, sess, o.PreferTab)
	}
}

type tabPresenceRequest struct {
	Tab     string `json:"tab"`
	Route   string `json:"route"`
	Visible bool   `json:"visible"`
}

// handleTabPresence: POST /api/tabs/presence
func (s *Server) handleTabPresence(w http.ResponseWriter, r *http.Request) {
	var req tabPresenceRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil || req.Tab == "" {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	sess, _ := currentSession(r)
	if !s.tabRegistry().update(req.Tab, sess.Handle, req.Route, req.Visible) {
		writeError(w, http.StatusNotFound, "unknown tab")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type tabAckRequest struct {
	Tab            string `json:"tab"`
	NotificationID string `json:"notification_id"`
	Shown          bool   `json:"shown"`
}

// handleTabAck: POST /api/tabs/ack
func (s *Server) handleTabAck(w http.ResponseWriter, r *http.Request) {
	var req tabAckRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil || req.Tab == "" {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	sess, _ := currentSession(r)
	if !s.tabRegistry().ack(req.Tab, sess.Handle, req.NotificationID, req.Shown) {
		writeError(w, http.StatusNotFound, "unknown tab or notification")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
