package webui

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCacheServesWithinTTLAndReexpires(t *testing.T) {
	var calls int32
	c := newAutocompleteCache(time.Minute)
	now := time.Unix(1000, 0)
	c.now = func() time.Time { return now }

	fn := func() ([]AutocompleteItem, error) {
		atomic.AddInt32(&calls, 1)
		return []AutocompleteItem{{Kind: "user", ID: "U1"}}, nil
	}

	if _, err := c.Do("k", fn); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Do("k", fn); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("fn called %d times within TTL, want 1", got)
	}

	now = now.Add(2 * time.Minute)
	if _, err := c.Do("k", fn); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("fn called %d times after TTL, want 2", got)
	}
}

func TestCacheSingleFlightsConcurrentIdenticalQueries(t *testing.T) {
	var calls int32
	release := make(chan struct{})
	c := newAutocompleteCache(time.Minute)

	fn := func() ([]AutocompleteItem, error) {
		atomic.AddInt32(&calls, 1)
		<-release // hold the call open so both goroutines are in flight
		return []AutocompleteItem{{Kind: "user", ID: "U1"}}, nil
	}

	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Do("k", fn); err != nil {
				t.Errorf("Do: %v", err)
			}
		}()
	}
	time.Sleep(20 * time.Millisecond) // let both reach the cache
	close(release)
	wg.Wait()

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("fn called %d times concurrently, want 1", got)
	}
}

func TestCacheDoesNotCacheErrors(t *testing.T) {
	var calls int32
	c := newAutocompleteCache(time.Minute)
	fn := func() ([]AutocompleteItem, error) {
		atomic.AddInt32(&calls, 1)
		return nil, errTest
	}
	c.Do("k", fn)
	c.Do("k", fn)
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("fn called %d times, want 2 — a failed lookup must not be cached", got)
	}
}

func TestCacheReleasesWaitersAndRecoversAfterPanic(t *testing.T) {
	c := newAutocompleteCache(time.Minute)
	registered := make(chan struct{})
	proceed := make(chan struct{})
	panicking := func() ([]AutocompleteItem, error) {
		close(registered) // let the waiter join before we panic
		<-proceed
		panic("boom")
	}

	// The leader triggers the panicking call and re-panics (it owns the
	// panicking stack). The waiter takes the in-flight branch for the same
	// key and must be released with a non-nil error rather than deadlocking
	// or silently seeing (nil, nil) as if the lookup found zero matches.
	leaderDone := make(chan struct{})
	go func() {
		defer func() {
			recover() // the leader owns the panic; swallow it here so the test doesn't fail
			close(leaderDone)
		}()
		c.Do("k", panicking)
	}()

	select {
	case <-registered:
	case <-time.After(2 * time.Second):
		t.Fatal("leader never registered the in-flight call")
	}

	waiterDone := make(chan struct{})
	var waiterErr error
	go func() {
		_, waiterErr = c.Do("k", panicking)
		close(waiterDone)
	}()
	time.Sleep(20 * time.Millisecond) // let the waiter reach the in-flight branch
	close(proceed)

	timeout := time.After(2 * time.Second)
	select {
	case <-leaderDone:
	case <-timeout:
		t.Fatal("leader did not return after fn panicked — cache is wedged")
	}
	select {
	case <-waiterDone:
	case <-timeout:
		t.Fatal("waiter did not return after fn panicked — cache is wedged")
	}
	if waiterErr == nil {
		t.Fatal("waiter got (items, nil) after a panicking lookup — a failed lookup must not look like an empty success")
	}

	// The key must not be permanently wedged: a later call for the same key
	// makes progress instead of hanging on a stale in-flight entry.
	var calls int32
	fn := func() ([]AutocompleteItem, error) {
		atomic.AddInt32(&calls, 1)
		return []AutocompleteItem{{Kind: "user", ID: "U1"}}, nil
	}
	resultCh := make(chan struct{})
	go func() {
		if _, err := c.Do("k", fn); err != nil {
			t.Errorf("Do after panic: %v", err)
		}
		close(resultCh)
	}()
	select {
	case <-resultCh:
	case <-time.After(2 * time.Second):
		t.Fatal("Do hung on the same key after a prior panic")
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("fn called %d times after recovery, want 1", got)
	}
}

var errTest = errorString("boom")

type errorString string

func (e errorString) Error() string { return string(e) }
