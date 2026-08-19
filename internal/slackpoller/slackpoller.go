// internal/slackpoller/slackpoller.go
package slackpoller

import (
	"context"
	"strconv"
	"sync"
	"time"

	"github.com/mturley/watcher/slack"
)

// ThreadUpdate is emitted whenever a poll detects a change in a thread.
type ThreadUpdate struct {
	Channel, ThreadTS string
	Thread            slack.Thread
}

// sub is one Subscribe() caller's private channel. Multiple subs can share a
// single polling loop (one per (channel, threadTS) key); the loop fans out
// each changed ThreadUpdate to every sub registered for its key.
//
// A sub's channel (ch) is only ever closed while holding Poller.mu, and
// only by whichever code path removed it from its loopState.subs set in
// that same critical section (either Poller.unsubscribe, for a
// non-last subscriber, or the owning loop's shutdown, for the last
// subscriber / Close()). This single-owner-under-lock discipline is what
// the earlier send-on-closed-channel panic fix depended on: cancelling a
// loop's context does not stop a poll that is already in flight (e.g.
// blocked inside client.Replies), so any close(s.ch) that could race a
// concurrent fan-out send would reintroduce that panic. Because both the
// fan-out send and every close happen only while holding mu, and removal
// from loopState.subs always happens-before the corresponding close, a
// send can never observe a channel that is being (or has been) closed
// concurrently.
type sub struct {
	ch chan ThreadUpdate
}

// loopState is the shared state for one (channel, threadTS) polling loop:
// its cancellation handle, a synchronization point for "the loop has fully
// stopped", and the set of subscriber channels it currently fans out to.
// subs is only ever read or mutated while holding Poller.mu.
type loopState struct {
	cancel context.CancelFunc
	done   chan struct{}
	subs   map[*sub]struct{}
}

// Poller polls Slack threads for changes and emits ThreadUpdate events on
// per-subscriber channels. It depends only on slack.Client, so it can be
// lifted into a standalone Jira/GitHub watcher library later.
type Poller struct {
	client   slack.Client
	interval time.Duration

	mu      sync.Mutex
	loops   map[string]*loopState
	lastSig map[string]string // last-seen signature per (channel, threadTS) key
}

func key(ch, ts string) string { return ch + "\x00" + ts }

// New returns a Poller that polls c on interval. now is accepted as a
// reserved injection seam for future testable-clock use (e.g. stamping
// poll times or driving backoff) and is not currently read; it is not
// stored on Poller.
func New(c slack.Client, interval time.Duration, now func() time.Time) *Poller {
	return &Poller{
		client:   c,
		interval: interval,
		loops:    map[string]*loopState{},
		lastSig:  map[string]string{},
	}
}

// signature computes a cheap fingerprint of a thread's messages, based on
// each message's (ts, reaction count, edited) so Poll can cheaply detect
// changes without deep comparison.
func signature(t slack.Thread) string {
	sig := ""
	for _, m := range t.Messages {
		sig += m.TS + ":" + strconv.Itoa(len(m.Reactions)) + "|"
		if m.Edited {
			sig += "e"
		}
	}
	return sig
}

// Poll fetches the current state of a thread and reports whether it has
// changed since the last poll for this (channel, threadTS) key. The first
// poll for a key always reports changed=true.
func (w *Poller) Poll(ctx context.Context, ch, ts string) (ThreadUpdate, bool, error) {
	th, err := w.client.Replies(ctx, ch, ts)
	if err != nil {
		return ThreadUpdate{}, false, err
	}
	sig := signature(th)
	k := key(ch, ts)
	w.mu.Lock()
	prev, ok := w.lastSig[k]
	w.lastSig[k] = sig
	w.mu.Unlock()
	changed := !ok || sig != prev
	return ThreadUpdate{Channel: ch, ThreadTS: ts, Thread: th}, changed, nil
}

// Subscribe registers a new subscriber for (channel, threadTS) and returns
// a fresh channel of ThreadUpdate events for it, along with a function that
// unsubscribes it. Multiple Subscribe calls for the same key share a single
// polling loop, but each call gets its own channel: every changed
// ThreadUpdate is fanned out to all of them, and unsubscribing one does not
// affect the others. The polling loop for a key runs only while at least
// one subscriber is registered for it, and stops once the last one
// unsubscribes (or Close is called).
func (w *Poller) Subscribe(ch, ts string) (<-chan ThreadUpdate, func()) {
	w.mu.Lock()
	k := key(ch, ts)
	ls, ok := w.loops[k]
	if !ok {
		ctx, cancel := context.WithCancel(context.Background())
		ls = &loopState{cancel: cancel, done: make(chan struct{}), subs: map[*sub]struct{}{}}
		w.loops[k] = ls
		go w.loop(ctx, ch, ts, k, ls)
	}
	s := &sub{ch: make(chan ThreadUpdate, 4)}
	ls.subs[s] = struct{}{}
	w.mu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() { w.unsubscribe(k, s) })
	}
	return s.ch, unsubscribe
}

// unsubscribe removes s from the loop for k. If s is the last remaining
// subscriber for k, it detaches the loop from w.loops (so a subsequent
// Subscribe for the same key starts a fresh loop rather than joining the
// dying one), then cancels the loop and waits for it to fully stop; the
// loop's own shutdown closes s.ch as part of closing all of its remaining
// subscriber channels. Otherwise, s is removed from the loop's fan-out set
// and its channel is closed here, under the same lock used by the loop's
// fan-out send, so no send-after-close race is possible.
func (w *Poller) unsubscribe(k string, s *sub) {
	w.mu.Lock()
	ls, ok := w.loops[k]
	if !ok {
		w.mu.Unlock()
		return
	}
	if _, present := ls.subs[s]; !present {
		w.mu.Unlock()
		return
	}
	if len(ls.subs) == 1 {
		// s is the last subscriber: detach the loop so new Subscribers
		// start fresh, then let the loop's own shutdown close s.ch.
		delete(w.loops, k)
		w.mu.Unlock()
		ls.cancel()
		<-ls.done
		return
	}
	delete(ls.subs, s)
	w.mu.Unlock()
	close(s.ch)
}

// fanout delivers u to every subscriber currently registered for k, using a
// non-blocking send so a slow or dead consumer cannot block delivery to
// others (or block the polling loop). It holds w.mu for the whole
// operation, which is what keeps it mutually exclusive with the
// removal-then-close sequences in unsubscribe and in the loop's own
// shutdown: a send here can never race a close of the same channel.
func (w *Poller) fanout(k string, u ThreadUpdate) {
	w.mu.Lock()
	defer w.mu.Unlock()
	ls, ok := w.loops[k]
	if !ok {
		return
	}
	for s := range ls.subs {
		select {
		case s.ch <- u:
		default: // drop if consumer is slow; next poll will catch up
		}
	}
}

// loop is the sole owner of every channel referenced by ls.subs at the time
// it exits: it is the only code that closes those channels (besides
// unsubscribe's own non-last-subscriber path, which is mutually exclusive
// with this shutdown per the locking discipline described on sub and
// fanout). It runs until ctx is cancelled, which happens only when the
// last subscriber for k unsubscribes or Close is called.
func (w *Poller) loop(ctx context.Context, ch, ts, k string, ls *loopState) {
	t := time.NewTicker(w.interval)
	poll := func() {
		u, changed, err := w.Poll(ctx, ch, ts)
		if err == nil && changed {
			w.fanout(k, u)
		}
	}
	poll() // immediate first poll
loopBody:
	for {
		select {
		case <-ctx.Done():
			break loopBody
		case <-t.C:
			poll()
		}
	}
	t.Stop()

	// Shutdown: close every subscriber channel still registered for this
	// loop, under mu (so no fanout send can race these closes), then
	// remove the loops entry -- but ONLY if it still points at this exact
	// ls. cancel() cannot abort a poll already blocked inside
	// client.Replies, so a new Subscribe for the same key can install a
	// fresh ls (ls_new) in w.loops[k] and start a new loop while this
	// (older) loop's in-flight poll is still finishing. If we deleted
	// unconditionally here, we would clobber that newer entry: ls_new
	// would be orphaned (never cancelled -> goroutine leak), its fanout
	// would find w.loops[k] absent and silently drop every update, and
	// its subscribers would never get their channels closed on
	// unsubscribe. Comparing identity before deleting makes this a no-op
	// in the normal case (the entry was already removed by unsubscribe's
	// last-subscriber path or by Close), and a correct skip in the
	// resubscribe-during-teardown case.
	w.mu.Lock()
	for s := range ls.subs {
		close(s.ch)
	}
	if w.loops[k] == ls {
		delete(w.loops, k)
	}
	w.mu.Unlock()
	close(ls.done)
}

// Close stops all polling loops and blocks until every one of them has
// fully stopped and closed all of its subscriber channels.
func (w *Poller) Close() {
	w.mu.Lock()
	loops := make([]*loopState, 0, len(w.loops))
	for k, ls := range w.loops {
		loops = append(loops, ls)
		delete(w.loops, k)
	}
	w.mu.Unlock()
	for _, ls := range loops {
		ls.cancel()
	}
	for _, ls := range loops {
		<-ls.done
	}
}
