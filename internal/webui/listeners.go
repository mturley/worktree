package webui

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"
	"time"

	"github.com/mturley/worktree/internal/listeners"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
)

// listenersIntervalDefault is how often the scanner runs while a stream
// that consumes listeners is open.
const listenersIntervalDefault = 10 * time.Second

// listenersDisabledJSON is the snapshot published while port scanning is
// off in Settings (ui.port_scan_disabled).
var listenersDisabledJSON = []byte(`{"enabled":false,"ports":{},"ranges":{}}`)

// listenersHub fans listening-port snapshots out to the open event streams,
// as cmuxFocusHub does for focus. Unlike that hub it also owns the scanner:
// the first subscriber starts the scan loop and the last one to leave stops
// it, so lsof runs only while someone is looking. last is the JSON most
// recently published; a scan that produces the same JSON sends nothing.
type listenersHub struct {
	s *Server

	mu   sync.Mutex
	subs map[chan []byte]struct{}
	last []byte
	// stop cancels the running loop; nil while none runs. done is closed
	// when the most recently started loop has exited, so the next one can
	// wait for it and two loops never scan at once.
	stop context.CancelFunc
	done chan struct{}

	kicks chan struct{}
}

func (s *Server) listenersHub() *listenersHub {
	s.listenersOnce.Do(func() {
		s.listeners = &listenersHub{
			s:     s,
			subs:  make(map[chan []byte]struct{}),
			kicks: make(chan struct{}, 1),
		}
	})
	return s.listeners
}

// SetPortScanDisabled sets the Settings toggle (ui.port_scan_disabled). It
// does not rescan by itself; a live change also calls listenersHub().kick().
func (s *Server) SetPortScanDisabled(disabled bool) {
	s.portScanDisabled.Store(disabled)
}

// subscribe registers a stream. The channel holds the current snapshot
// already, when there is one, so a reconnecting tab is correct at once.
// Sends never block: a stalled stream misses an update that a later one
// supersedes.
func (h *listenersHub) subscribe() (<-chan []byte, func()) {
	ch := make(chan []byte, 4)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	if h.last != nil {
		ch <- h.last
	}
	if h.stop == nil {
		ctx, cancel := context.WithCancel(context.Background())
		prev, done := h.done, make(chan struct{})
		h.stop, h.done = cancel, done
		go h.run(ctx, prev, done)
	}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if _, ok := h.subs[ch]; !ok {
			return
		}
		delete(h.subs, ch)
		if len(h.subs) == 0 && h.stop != nil {
			h.stop()
			h.stop = nil
		}
	}
}

// kick asks the running loop to scan now. A no-op without subscribers
// beyond leaving one pending kick, which costs at most one extra scan.
func (h *listenersHub) kick() {
	select {
	case h.kicks <- struct{}{}:
	default:
	}
}

// run is the scan loop: once at start, then every interval or kick, until
// ctx is cancelled. It first waits for the previous loop, which may still
// be finishing a scan after its last subscriber left.
func (h *listenersHub) run(ctx context.Context, prev <-chan struct{}, done chan struct{}) {
	defer close(done)
	// Wait even when cancelled meanwhile: done must not close before prev
	// has, or a later loop would start alongside the one still scanning.
	if prev != nil {
		<-prev
	}
	if ctx.Err() != nil {
		return
	}
	interval := h.s.listenersInterval
	if interval <= 0 {
		interval = listenersIntervalDefault
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		h.tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-h.kicks:
		}
	}
}

func (h *listenersHub) tick(ctx context.Context) {
	if h.s.portScanDisabled.Load() {
		h.offer(ctx, listenersDisabledJSON)
		return
	}
	scan := h.s.listenersScan
	if scan == nil {
		scan = h.s.scanListeners
	}
	snap, err := scan(ctx)
	if err != nil {
		if ctx.Err() == nil {
			h.s.logger().Printf("listening ports: scan failed: %v", err)
		}
		return
	}
	b, err := json.Marshal(snap)
	if err != nil {
		h.s.logger().Printf("listening ports: %v", err)
		return
	}
	h.offer(ctx, b)
}

// offer publishes b when it differs from the last snapshot. A loop that has
// been stopped publishes nothing, so a scan finishing after its last
// subscriber left can't overwrite what a newer loop found.
func (h *listenersHub) offer(ctx context.Context, b []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if ctx.Err() != nil || bytes.Equal(b, h.last) {
		return
	}
	h.last = b
	for ch := range h.subs {
		select {
		case ch <- b:
		default:
		}
	}
}

// scanListeners is the production listenersScan: every registered worktree
// with its reserved port range, scanned with lsof.
func (s *Server) scanListeners(ctx context.Context) (listeners.Snapshot, error) {
	if s.DB == nil {
		return listeners.Snapshot{}, errors.New("no database")
	}
	entries, err := registry.List(s.DB)
	if err != nil {
		return listeners.Snapshot{}, err
	}
	wts := make([]listeners.Worktree, 0, len(entries))
	for _, e := range entries {
		alloc, ok, err := ports.Lookup(s.DB, filepath.Base(e.Path))
		if err != nil {
			return listeners.Snapshot{}, err
		}
		wt := listeners.Worktree{Path: e.Path, Canon: listeners.Canonical(e.Path), HasRange: ok}
		if ok {
			wt.Start, wt.End = alloc.Start(), alloc.End()
		}
		wts = append(wts, wt)
	}
	return listeners.Scan(ctx, listeners.ExecRunner, wts)
}
