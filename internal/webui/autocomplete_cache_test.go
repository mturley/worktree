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

var errTest = errorString("boom")

type errorString string

func (e errorString) Error() string { return string(e) }
