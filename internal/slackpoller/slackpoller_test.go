// internal/slackpoller/slackpoller_test.go
package slackpoller

import (
	"context"
	"runtime"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mturley/watcher/slack"
)

type fakeClient struct {
	threads []slack.Thread
	i       int
}

func (f *fakeClient) AuthTest(ctx context.Context) error { return nil }

func (f *fakeClient) WhoAmI(ctx context.Context) (string, error) { return "U_SELF", nil }

func (f *fakeClient) Channel(ctx context.Context, id string) (string, error) { return "", nil }

func (f *fakeClient) Replies(ctx context.Context, ch, ts string) (slack.Thread, error) {
	t := f.threads[f.i]
	if f.i < len(f.threads)-1 {
		f.i++
	}
	return t, nil
}
func (f *fakeClient) Users(context.Context, []string) (map[string]slack.User, error) {
	return nil, nil
}
func (f *fakeClient) Emoji(context.Context) (map[string]string, error)         { return nil, nil }
func (f *fakeClient) MarkRead(context.Context, string, string, string) error   { return nil }
func (f *fakeClient) MarkUnread(context.Context, string, string, string) error { return nil }
func (f *fakeClient) PostReply(context.Context, string, string, string) (slack.Message, error) {
	return slack.Message{}, nil
}
func (f *fakeClient) AddReaction(context.Context, string, string, string) error    { return nil }
func (f *fakeClient) RemoveReaction(context.Context, string, string, string) error { return nil }

func TestPollDetectsChange(t *testing.T) {
	fc := &fakeClient{threads: []slack.Thread{
		{Messages: []slack.Message{{TS: "1.1"}}},
		{Messages: []slack.Message{{TS: "1.1"}, {TS: "1.2"}}},
	}}
	w := New(fc, time.Second, time.Now)
	// First poll establishes baseline -> changed=true.
	_, changed, err := w.Poll(context.Background(), "C", "1.1")
	if err != nil || !changed {
		t.Fatalf("first poll changed=%v err=%v", changed, err)
	}
	// Second poll has an extra message -> changed=true.
	_, changed, _ = w.Poll(context.Background(), "C", "1.1")
	if !changed {
		t.Fatal("second poll should detect new message")
	}
	// Third poll returns same as second (fake clamps) -> changed=false.
	_, changed, _ = w.Poll(context.Background(), "C", "1.1")
	if changed {
		t.Fatal("third poll should be no change")
	}
}

// slowClient simulates a Replies call that takes real wall-clock time to
// respond and does not honor ctx cancellation (as a real HTTP round-trip in
// flight would not stop the instant its context is cancelled). This is used
// to reproduce the send-on-closed-channel race between an in-flight poll
// and a concurrent Unsubscribe/Close.
// drainClosed reads from ch until it observes the channel closed (ok ==
// false), tolerating any buffered values sent before closure. It fails the
// test if the channel does not close within a generous timeout.
func drainClosed(t *testing.T, ch <-chan ThreadUpdate) {
	t.Helper()
	timeout := time.After(2 * time.Second)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-timeout:
			t.Fatal("timed out waiting for channel to close")
		}
	}
}

type slowClient struct{ delay time.Duration }

func (s *slowClient) AuthTest(ctx context.Context) error { return nil }

func (s *slowClient) WhoAmI(ctx context.Context) (string, error) { return "U_SELF", nil }

func (s *slowClient) Channel(ctx context.Context, id string) (string, error) { return "", nil }

func (s *slowClient) Replies(ctx context.Context, ch, ts string) (slack.Thread, error) {
	time.Sleep(s.delay)
	return slack.Thread{Messages: []slack.Message{{TS: "1.1"}}}, nil
}
func (s *slowClient) Users(context.Context, []string) (map[string]slack.User, error) {
	return nil, nil
}
func (s *slowClient) Emoji(context.Context) (map[string]string, error)         { return nil, nil }
func (s *slowClient) MarkRead(context.Context, string, string, string) error   { return nil }
func (s *slowClient) MarkUnread(context.Context, string, string, string) error { return nil }
func (s *slowClient) PostReply(context.Context, string, string, string) (slack.Message, error) {
	return slack.Message{}, nil
}
func (s *slowClient) AddReaction(context.Context, string, string, string) error    { return nil }
func (s *slowClient) RemoveReaction(context.Context, string, string, string) error { return nil }

// TestUnsubscribeDuringInFlightPollDoesNotPanic reproduces the critical
// concurrency bug: Subscribe starts a loop whose first poll blocks for
// 20ms inside Replies (ignoring ctx cancellation, like a real in-flight
// HTTP call would). We Unsubscribe 5ms later, well before that poll
// returns. On the buggy implementation, Unsubscribe cancels the context
// and immediately closes s.ch while the loop goroutine is still blocked in
// Replies; when that poll finally returns (changed=true on a first poll)
// it attempts to send on the now-closed channel and panics. The fix makes
// the loop goroutine the sole closer of s.ch, and makes Unsubscribe
// synchronous (it waits for the loop to actually exit), so no such race
// can occur.
func TestUnsubscribeDuringInFlightPollDoesNotPanic(t *testing.T) {
	before := runtime.NumGoroutine()

	sc := &slowClient{delay: 20 * time.Millisecond}
	w := New(sc, time.Millisecond, time.Now)

	ch, unsubscribe := w.Subscribe("C", "1.1")
	time.Sleep(5 * time.Millisecond) // ensure the first poll is in flight
	unsubscribe()

	// unsubscribe is synchronous when it removes the last subscriber: the
	// loop goroutine must have exited and closed ch by the time it returns.
	// Drain any buffered update from the immediate first poll (which fired
	// before unsubscribe ran) before confirming the channel is closed.
	drainClosed(t, ch)

	// Give any stray goroutine a moment to actually finish, then check we
	// didn't leak the loop goroutine.
	time.Sleep(50 * time.Millisecond)
	if after := runtime.NumGoroutine(); after > before {
		t.Fatalf("goroutine leak: before=%d after=%d", before, after)
	}
}

// TestCloseDuringInFlightPollDoesNotPanic is the same scenario but via
// Close(), which must also wait for in-flight polls to finish before
// returning, and must not race a close(s.ch) against an in-flight send.
func TestCloseDuringInFlightPollDoesNotPanic(t *testing.T) {
	before := runtime.NumGoroutine()

	sc := &slowClient{delay: 20 * time.Millisecond}
	w := New(sc, time.Millisecond, time.Now)

	ch, _ := w.Subscribe("C", "1.1")
	time.Sleep(5 * time.Millisecond) // ensure the first poll is in flight
	w.Close()

	drainClosed(t, ch)

	time.Sleep(50 * time.Millisecond)
	if after := runtime.NumGoroutine(); after > before {
		t.Fatalf("goroutine leak: before=%d after=%d", before, after)
	}
}

// recvUpdate reads one ThreadUpdate from ch, failing the test if none
// arrives within a generous timeout.
func recvUpdate(t *testing.T, ch <-chan ThreadUpdate) ThreadUpdate {
	t.Helper()
	select {
	case u := <-ch:
		return u
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for update")
	}
	return ThreadUpdate{}
}

// TestFanOutToMultipleSubscribers reproduces the two-browser-windows
// scenario: two Subscribe calls for the SAME (channel, threadTS) share one
// polling loop, but each must independently receive every changed
// ThreadUpdate (a broadcast fan-out), not have it split between them the
// way a single shared Go channel would.
func TestFanOutToMultipleSubscribers(t *testing.T) {
	fc := &fakeClient{threads: []slack.Thread{
		{Messages: []slack.Message{{TS: "1.1"}}},
		{Messages: []slack.Message{{TS: "1.1"}, {TS: "1.2"}}},
	}}
	w := New(fc, 5*time.Millisecond, time.Now)
	defer w.Close()

	ch1, unsub1 := w.Subscribe("C", "1.1")
	defer unsub1()
	// Drain the immediate first-poll baseline event before ch2 joins, so
	// the next (second) poll is the one both subscribers observe together.
	recvUpdate(t, ch1)

	ch2, unsub2 := w.Subscribe("C", "1.1")
	defer unsub2()

	u1 := recvUpdate(t, ch1)
	u2 := recvUpdate(t, ch2)
	if len(u1.Thread.Messages) != 2 {
		t.Fatalf("subscriber 1: expected 2-message update, got %d", len(u1.Thread.Messages))
	}
	if len(u2.Thread.Messages) != 2 {
		t.Fatalf("subscriber 2: expected 2-message update, got %d", len(u2.Thread.Messages))
	}
}

// TestUnsubscribeOneDoesNotCloseOther verifies that unsubscribing one
// subscriber of a shared key removes and closes only that subscriber's
// channel, without disrupting the polling loop or the other subscriber's
// channel: the earlier bug closed the one shared channel for everyone.
func TestUnsubscribeOneDoesNotCloseOther(t *testing.T) {
	fc := &fakeClient{threads: []slack.Thread{
		{Messages: []slack.Message{{TS: "1.1"}}},
		{Messages: []slack.Message{{TS: "1.1"}, {TS: "1.2"}}},
		{Messages: []slack.Message{{TS: "1.1"}, {TS: "1.2"}, {TS: "1.3"}}},
	}}
	w := New(fc, 5*time.Millisecond, time.Now)
	defer w.Close()

	ch1, unsub1 := w.Subscribe("C", "1.1")
	recvUpdate(t, ch1) // baseline from the first poll

	ch2, unsub2 := w.Subscribe("C", "1.1")
	defer unsub2()

	// Second poll: both subscribers see the 2-message update.
	recvUpdate(t, ch1)
	recvUpdate(t, ch2)

	unsub1()
	// ch1 must be closed (tolerating any update sent before the close won).
	drainClosed(t, ch1)

	// ch2 must be unaffected: the loop keeps running and the third poll's
	// 3-message update must still reach it.
	u2 := recvUpdate(t, ch2)
	if len(u2.Thread.Messages) != 3 {
		t.Fatalf("expected remaining subscriber to keep receiving updates, got %d messages", len(u2.Thread.Messages))
	}
}

// countingClient counts Replies calls, letting a test observe how many
// polls have actually run without depending on wall-clock guesses about
// timing beyond generous, deterministic margins.
type countingClient struct {
	n int64
}

func (c *countingClient) count() int64 { return atomic.LoadInt64(&c.n) }

func (c *countingClient) AuthTest(ctx context.Context) error { return nil }

func (c *countingClient) WhoAmI(ctx context.Context) (string, error) { return "U_SELF", nil }

func (c *countingClient) Channel(ctx context.Context, id string) (string, error) { return "", nil }

func (c *countingClient) Replies(ctx context.Context, ch, ts string) (slack.Thread, error) {
	atomic.AddInt64(&c.n, 1)
	return slack.Thread{Messages: []slack.Message{{TS: "1.1"}}}, nil
}
func (c *countingClient) Users(context.Context, []string) (map[string]slack.User, error) {
	return nil, nil
}
func (c *countingClient) Emoji(context.Context) (map[string]string, error)         { return nil, nil }
func (c *countingClient) MarkRead(context.Context, string, string, string) error   { return nil }
func (c *countingClient) MarkUnread(context.Context, string, string, string) error { return nil }
func (c *countingClient) PostReply(context.Context, string, string, string) (slack.Message, error) {
	return slack.Message{}, nil
}
func (c *countingClient) AddReaction(context.Context, string, string, string) error    { return nil }
func (c *countingClient) RemoveReaction(context.Context, string, string, string) error { return nil }

// TestLoopStopsAfterLastUnsubscribe verifies that a shared polling loop
// keeps running while any subscriber remains, and stops polling only once
// the LAST subscriber for its key has unsubscribed.
func TestLoopStopsAfterLastUnsubscribe(t *testing.T) {
	cc := &countingClient{}
	w := New(cc, 3*time.Millisecond, time.Now)
	defer w.Close()

	_, unsub1 := w.Subscribe("C", "1.1")
	_, unsub2 := w.Subscribe("C", "1.1")

	time.Sleep(40 * time.Millisecond) // let several polls happen

	unsub1()
	afterFirstUnsub := cc.count()
	time.Sleep(40 * time.Millisecond) // loop must still be polling for sub2

	if cc.count() <= afterFirstUnsub {
		t.Fatal("expected polling to continue while a subscriber remains")
	}

	unsub2()
	afterSecondUnsub := cc.count()
	time.Sleep(40 * time.Millisecond) // loop must have stopped polling now

	if cc.count() != afterSecondUnsub {
		t.Fatalf("expected polling to stop after the last unsubscribe: count went from %d to %d", afterSecondUnsub, cc.count())
	}
}

// controlledClient blocks its FIRST Replies call until the test releases it
// (via unblockFirst), signalling firstCallStarted the instant that call
// begins so the test can synchronize on "the poll is now in flight" without
// guessing at timing. Every call (blocked or not) returns a thread whose
// signature is unique to that call number, so every successful poll is
// reported as a change -- useful for proving a loop keeps delivering
// updates over time, not just once.
type controlledClient struct {
	calls            int32
	firstCallStarted chan struct{}
	unblockFirst     chan struct{}
}

func (c *controlledClient) AuthTest(ctx context.Context) error { return nil }

func (c *controlledClient) WhoAmI(ctx context.Context) (string, error) { return "U_SELF", nil }

func (c *controlledClient) Channel(ctx context.Context, id string) (string, error) { return "", nil }

func (c *controlledClient) Replies(ctx context.Context, ch, ts string) (slack.Thread, error) {
	n := atomic.AddInt32(&c.calls, 1)
	if n == 1 {
		close(c.firstCallStarted)
		<-c.unblockFirst
	}
	return slack.Thread{Messages: []slack.Message{{TS: strconv.Itoa(int(n))}}}, nil
}
func (c *controlledClient) Users(context.Context, []string) (map[string]slack.User, error) {
	return nil, nil
}
func (c *controlledClient) Emoji(context.Context) (map[string]string, error)         { return nil, nil }
func (c *controlledClient) MarkRead(context.Context, string, string, string) error   { return nil }
func (c *controlledClient) MarkUnread(context.Context, string, string, string) error { return nil }
func (c *controlledClient) PostReply(context.Context, string, string, string) (slack.Message, error) {
	return slack.Message{}, nil
}
func (c *controlledClient) AddReaction(context.Context, string, string, string) error    { return nil }
func (c *controlledClient) RemoveReaction(context.Context, string, string, string) error { return nil }

// drainBuffered discards any values already buffered on ch without
// blocking, so a subsequent read is guaranteed to observe a fresh delivery
// rather than a stale one.
func drainBuffered(ch <-chan ThreadUpdate) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

// TestResubscribeDuringTeardownDoesNotOrphanNewLoop is a regression test
// for the bug where the loop's shutdown unconditionally deleted
// w.loops[k]. Because cancelling a loop's context cannot abort a poll
// already blocked inside client.Replies, a brand-new Subscribe for the
// same key (e.g. an SSE reconnect racing the old connection's teardown)
// can install a new loopState in that same map slot WHILE the old loop is
// still winding down. If the old loop's shutdown then deletes the slot
// unconditionally, it deletes the NEW loopState instead of its own
// (already-removed) one: the new loop is orphaned (its context is never
// cancelled, so it leaks its goroutine forever), its fan-out silently
// stops working (looks up w.loops[k], finds nothing), and its subscriber's
// channel is never closed on unsubscribe (another leak). The fix compares
// identity (w.loops[k] == ls) before deleting.
func TestResubscribeDuringTeardownDoesNotOrphanNewLoop(t *testing.T) {
	before := runtime.NumGoroutine()

	cc := &controlledClient{
		firstCallStarted: make(chan struct{}),
		unblockFirst:     make(chan struct{}),
	}
	w := New(cc, 3*time.Millisecond, time.Now)
	defer w.Close()

	chA, unsubA := w.Subscribe("C", "1.1")
	select {
	case <-cc.firstCallStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for the first poll to start")
	}

	// unsubA is the last (only) subscriber, so unsubscribing it detaches
	// the old loop from w.loops and blocks until the old loop has fully
	// stopped. The old loop's first poll is currently blocked inside
	// Replies, so this won't return until we release it below. Run it in
	// the background so we can resubscribe on the same key while the old
	// loop is still tearing down.
	unsubDone := make(chan struct{})
	go func() {
		unsubA()
		close(unsubDone)
	}()

	// Give unsubA's synchronous "detach from w.loops + cancel" step time
	// to run before we resubscribe. This margin is generous but not
	// load-bearing for correctness: if the detach happened later than
	// this sleep, the resubscribe below would simply join the (still
	// registered) old loop instead of creating a new one, and the test
	// would fail to exercise the bug rather than falsely pass.
	time.Sleep(20 * time.Millisecond)

	chB, unsubB := w.Subscribe("C", "1.1")

	// Release the old, in-flight poll so its loop can finish tearing down
	// (its fan-out will target whatever loopState currently owns the key,
	// i.e. the new one, which is fine -- the update is still valid data
	// for this thread; what matters is that the new loop's own entry
	// survives).
	close(cc.unblockFirst)

	select {
	case <-unsubDone:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for the old loop to finish tearing down")
	}

	// The old loop's own shutdown must still close A's channel (the
	// single-owner-close discipline is unaffected by this fix).
	drainClosed(t, chA)

	// The bug under test: if the old loop's shutdown had deleted the new
	// loop's entry, the new loop would be orphaned and would stop
	// delivering updates from this point on. Drain any updates that
	// arrived before/around the teardown, then require a FRESH one,
	// proving the new loop's polling and fan-out are still alive after
	// the old loop finished tearing down.
	drainBuffered(chB)
	recvUpdate(t, chB)

	unsubB()
	drainClosed(t, chB)

	time.Sleep(50 * time.Millisecond)
	if after := runtime.NumGoroutine(); after > before {
		t.Fatalf("goroutine leak: before=%d after=%d", before, after)
	}
}
