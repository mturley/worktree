package webui

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/listeners"
)

// fakeScan is a listenersScan that counts its calls and returns whatever
// next is set to.
type fakeScan struct {
	calls atomic.Int64
	mu    sync.Mutex
	snap  listeners.Snapshot
	err   error
	// active and maxActive count overlapping calls; delay slows each call.
	active, maxActive atomic.Int64
	delay             time.Duration
}

func (f *fakeScan) set(snap listeners.Snapshot, err error) {
	f.mu.Lock()
	f.snap, f.err = snap, err
	f.mu.Unlock()
}

func (f *fakeScan) scan(ctx context.Context) (listeners.Snapshot, error) {
	f.calls.Add(1)
	n := f.active.Add(1)
	defer f.active.Add(-1)
	for {
		m := f.maxActive.Load()
		if n <= m || f.maxActive.CompareAndSwap(m, n) {
			break
		}
	}
	if f.delay > 0 {
		time.Sleep(f.delay) // ignores ctx on purpose: a scan that finishes late
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap, f.err
}

func snapWith(path string, port int) listeners.Snapshot {
	return listeners.Snapshot{
		Enabled: true,
		Ports:   map[string][]listeners.Port{path: {{Port: port, Addresses: []string{"*"}, PID: 1, Process: "node", InRange: true}}},
		Ranges:  map[string]string{},
	}
}

func listenersTestServer(f *fakeScan) *Server {
	return &Server{listenersScan: f.scan, listenersInterval: 20 * time.Millisecond}
}

// recv waits up to d for a message.
func recv(ch <-chan []byte, d time.Duration) ([]byte, bool) {
	select {
	case b := <-ch:
		return b, true
	case <-time.After(d):
		return nil, false
	}
}

// drain collects every message that arrives within d.
func drain(ch <-chan []byte, d time.Duration) [][]byte {
	var got [][]byte
	deadline := time.After(d)
	for {
		select {
		case b := <-ch:
			got = append(got, b)
		case <-deadline:
			return got
		}
	}
}

func TestListenersScanOnlyWhileSubscribed(t *testing.T) {
	t.Parallel()
	f := &fakeScan{}
	f.set(snapWith("/a", 4000), nil)
	s := listenersTestServer(f)
	hub := s.listenersHub()

	time.Sleep(100 * time.Millisecond)
	if n := f.calls.Load(); n != 0 {
		t.Fatalf("%d scans with no subscriber, want 0", n)
	}

	_, unsubscribe := hub.subscribe()
	time.Sleep(100 * time.Millisecond)
	if f.calls.Load() < 1 {
		t.Fatal("no scan while subscribed")
	}
	unsubscribe()
	time.Sleep(50 * time.Millisecond) // let a scan in flight finish
	stopped := f.calls.Load()
	time.Sleep(100 * time.Millisecond)
	if n := f.calls.Load(); n != stopped {
		t.Fatalf("scans kept running after the last unsubscribe: %d → %d", stopped, n)
	}
}

func TestListenersPublishOnlyOnChange(t *testing.T) {
	t.Parallel()
	f := &fakeScan{}
	f.set(snapWith("/a", 4000), nil)
	s := listenersTestServer(f)
	ch, unsubscribe := s.listenersHub().subscribe()
	defer unsubscribe()

	got := drain(ch, 150*time.Millisecond)
	if len(got) != 1 {
		t.Fatalf("%d messages for an unchanging snapshot, want 1", len(got))
	}
	if f.calls.Load() < 2 {
		t.Fatalf("only %d scans in 150ms at a 20ms interval", f.calls.Load())
	}

	f.set(snapWith("/a", 4001), nil)
	b, ok := recv(ch, 200*time.Millisecond)
	if !ok {
		t.Fatal("no message after the snapshot changed")
	}
	if !strings.Contains(string(b), `"port":4001`) {
		t.Fatalf("message %s lacks the new port", b)
	}
}

func TestListenersFailedScanKeepsLast(t *testing.T) {
	t.Parallel()
	f := &fakeScan{}
	f.set(snapWith("/a", 4000), nil)
	s := listenersTestServer(f)
	s.Logger = log.New(io.Discard, "", 0)
	ch, unsubscribe := s.listenersHub().subscribe()
	defer unsubscribe()

	first, ok := recv(ch, 200*time.Millisecond)
	if !ok {
		t.Fatal("no first snapshot")
	}
	f.set(listeners.Snapshot{}, errors.New("lsof: boom"))
	if extra := drain(ch, 100*time.Millisecond); len(extra) != 0 {
		t.Fatalf("a failed scan published %s", extra[0])
	}

	ch2, unsubscribe2 := s.listenersHub().subscribe()
	defer unsubscribe2()
	b, ok := recv(ch2, 50*time.Millisecond)
	if !ok {
		t.Fatal("a new subscriber got no snapshot")
	}
	if string(b) != string(first) {
		t.Fatalf("new subscriber got %s, want the last good %s", b, first)
	}
}

func TestListenersDisabledPublishesOff(t *testing.T) {
	t.Parallel()
	f := &fakeScan{}
	f.set(snapWith("/a", 4000), nil)
	s := listenersTestServer(f)
	s.listenersInterval = time.Hour // only kick() may rescan
	s.SetPortScanDisabled(true)
	ch, unsubscribe := s.listenersHub().subscribe()
	defer unsubscribe()

	b, ok := recv(ch, 200*time.Millisecond)
	if !ok {
		t.Fatal("no message while disabled")
	}
	if string(b) != `{"enabled":false,"ports":{},"ranges":{}}` {
		t.Fatalf("disabled payload %s", b)
	}
	if n := f.calls.Load(); n != 0 {
		t.Fatalf("%d scans while disabled", n)
	}

	s.SetPortScanDisabled(false)
	s.listenersHub().kick()
	b, ok = recv(ch, 200*time.Millisecond)
	if !ok {
		t.Fatal("no message after re-enabling and kicking")
	}
	if !strings.Contains(string(b), `"enabled":true`) {
		t.Fatalf("message after re-enabling: %s", b)
	}
	if f.calls.Load() < 1 {
		t.Fatal("kick did not scan")
	}
}

// A stream that closes and reopens while a slow scan is still in flight
// must not leave two loops scanning at once, and the stopped loop must not
// publish its late result.
func TestListenersResubscribeNeverOverlapsScans(t *testing.T) {
	t.Parallel()
	f := &fakeScan{delay: 30 * time.Millisecond}
	f.set(snapWith("/a", 4000), nil)
	s := listenersTestServer(f)
	hub := s.listenersHub()
	for i := 0; i < 5; i++ {
		_, unsubscribe := hub.subscribe()
		time.Sleep(5 * time.Millisecond)
		unsubscribe()
	}
	ch, unsubscribe := hub.subscribe()
	if _, ok := recv(ch, 500*time.Millisecond); !ok {
		t.Fatal("no snapshot after resubscribing")
	}
	time.Sleep(100 * time.Millisecond)
	unsubscribe()
	if m := f.maxActive.Load(); m != 1 {
		t.Fatalf("%d scans overlapped, want 1 at a time", m)
	}
	hub.wait()
	settled := f.calls.Load()
	time.Sleep(100 * time.Millisecond)
	if n := f.calls.Load(); n != settled {
		t.Fatalf("a loop outlived its subscribers: %d → %d scans", settled, n)
	}
}

// wait blocks until the most recently started loop has exited.
func (h *listenersHub) wait() {
	h.mu.Lock()
	done := h.done
	h.mu.Unlock()
	if done != nil {
		<-done
	}
}

func streamTestServer(t *testing.T, f *fakeScan) *httptest.Server {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	s := listenersTestServer(f)
	s.DB = conn
	ts := httptest.NewServer(http.HandlerFunc(s.handleStream))
	t.Cleanup(ts.Close)
	return ts
}

// streamLines reads ts's stream at query into a channel of lines.
func streamLines(t *testing.T, ts *httptest.Server, query string) <-chan string {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/stream"+query, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	out := make(chan string, 64)
	go func() {
		defer close(out)
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			out <- sc.Text()
		}
	}()
	return out
}

func TestStreamSendsCurrentListeners(t *testing.T) {
	t.Parallel()
	f := &fakeScan{}
	f.set(snapWith("/a", 4000), nil)
	lines := streamLines(t, streamTestServer(t, f), "")
	want := `{"enabled":true,"ports":{"/a":[{"port":4000,"addresses":["*"],"pid":1,"process":"node","in_range":true}]},"ranges":{}}`
	timeout := time.After(2 * time.Second)
	for {
		select {
		case l, ok := <-lines:
			if !ok {
				t.Fatal("stream ended")
			}
			if l != "event: listeners_changed" {
				continue
			}
			if data := <-lines; data != "data: "+want {
				t.Fatalf("listeners_changed %q, want data: %s", data, want)
			}
			return
		case <-timeout:
			t.Fatal("no listeners_changed event")
		}
	}
}

func TestMiniStreamSkipsListeners(t *testing.T) {
	t.Parallel()
	f := &fakeScan{}
	f.set(snapWith("/a", 4000), nil)
	lines := streamLines(t, streamTestServer(t, f), "?listeners=0")
	timeout := time.After(100 * time.Millisecond)
	for {
		select {
		case l := <-lines:
			if strings.Contains(l, "listeners_changed") {
				t.Fatal("the mini stream got listeners_changed")
			}
		case <-timeout:
			if n := f.calls.Load(); n != 0 {
				t.Fatalf("%d scans for an opted-out stream", n)
			}
			return
		}
	}
}

func TestListenersLatestSnapshotWins(t *testing.T) {
	t.Parallel()
	f := &fakeScan{}
	f.set(listeners.Snapshot{}, errors.New("no scan results")) // the loop publishes nothing
	s := listenersTestServer(f)
	hub := s.listenersHub()
	ch, unsubscribe := hub.subscribe()
	defer unsubscribe()

	for _, p := range []int{4001, 4002, 4003, 4004} {
		hub.offer(context.Background(), []byte(`{"p":`+strconv.Itoa(p)+`}`))
	}
	b, ok := recv(ch, time.Second)
	if !ok || string(b) != `{"p":4004}` {
		t.Fatalf("got %q (ok=%v), want the latest snapshot", b, ok)
	}
	if extra := drain(ch, 50*time.Millisecond); len(extra) != 0 {
		t.Fatalf("%d stale snapshots still queued", len(extra))
	}
}

func TestListenersHungScanTimesOut(t *testing.T) {
	t.Parallel()
	var calls atomic.Int64
	s := &Server{
		listenersInterval:    10 * time.Millisecond,
		listenersScanTimeout: 50 * time.Millisecond,
		listenersScan: func(ctx context.Context) (listeners.Snapshot, error) {
			if calls.Add(1) == 1 {
				<-ctx.Done() // a hung lsof: only the timeout frees it
				return listeners.Snapshot{}, ctx.Err()
			}
			return snapWith("/a", 4000), nil
		},
		Logger: log.New(io.Discard, "", 0),
	}
	ch, unsubscribe := s.listenersHub().subscribe()
	defer unsubscribe()
	if _, ok := recv(ch, 2*time.Second); !ok {
		t.Fatal("loop never moved past the hung scan")
	}
	if calls.Load() < 2 {
		t.Fatalf("%d scans, want at least 2", calls.Load())
	}
}
