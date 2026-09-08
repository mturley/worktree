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
	panicking := func() ([]AutocompleteItem, error) {
		panic("boom")
	}

	// Goroutine A triggers the panicking call; goroutine B waits on the same
	// key. Both must be released rather than deadlocking on call.done.
	done := make(chan struct{}, 2)
	for i := 0; i < 2; i++ {
		go func() {
			defer func() {
				recover() // Do re-panics; the waiter goroutine also panics via the shared call
				done <- struct{}{}
			}()
			c.Do("k", panicking)
		}()
	}

	timeout := time.After(2 * time.Second)
	for i := 0; i < 2; i++ {
		select {
		case <-done:
		case <-timeout:
			t.Fatal("Do did not release waiters after fn panicked — cache is wedged")
		}
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
