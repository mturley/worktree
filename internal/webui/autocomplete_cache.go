package webui

import (
	"sync"
	"time"
)

// autocompleteCache is a small TTL cache with single-flight, sitting in front
// of every Slack-backed autocomplete lookup.
//
// This is a REQUIREMENT, not an optimisation: autocomplete is driven by
// keystrokes, and docs/reverse-engineering/slack-web-api.md records that
// bursts of calls got the user's session token revoked. Repeated prefixes and
// two panes open on the same thread must not multiply Slack traffic.
//
// Errors are deliberately not cached — a transient failure should not blank
// the menu for a minute.
type autocompleteCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	now     func() time.Time // swappable in tests
	entries map[string]autocompleteEntry
	calls   map[string]*autocompleteCall
}

type autocompleteEntry struct {
	items   []AutocompleteItem
	expires time.Time
}

type autocompleteCall struct {
	done  chan struct{}
	items []AutocompleteItem
	err   error
}

func newAutocompleteCache(ttl time.Duration) *autocompleteCache {
	return &autocompleteCache{
		ttl:     ttl,
		now:     time.Now,
		entries: map[string]autocompleteEntry{},
		calls:   map[string]*autocompleteCall{},
	}
}

// Do returns the cached items for key, or runs fn once — even if several
// callers ask concurrently — and caches a successful result for the TTL.
func (c *autocompleteCache) Do(key string, fn func() ([]AutocompleteItem, error)) ([]AutocompleteItem, error) {
	c.mu.Lock()
	if e, ok := c.entries[key]; ok && c.now().Before(e.expires) {
		c.mu.Unlock()
		return e.items, nil
	}
	if call, ok := c.calls[key]; ok {
		c.mu.Unlock()
		<-call.done
		return call.items, call.err
	}
	call := &autocompleteCall{done: make(chan struct{})}
	c.calls[key] = call
	c.mu.Unlock()

	// fn runs unlocked and outside any recover in the caller's own stack, so a
	// panic in fn (a Slack client choking on unexpected nil JSON is realistic)
	// must not leave this key permanently wedged: every goroutine already
	// waiting on call.done, and every later caller for the same key, would
	// block forever otherwise. The deferred cleanup always deletes the
	// in-flight entry and closes done; we re-panic afterward rather than
	// swallowing it into an error, because a panic is a bug and hiding it
	// behind a returned error would make it silently disappear from the menu.
	func() {
		defer func() {
			p := recover()
			c.mu.Lock()
			delete(c.calls, key)
			// A panicking fn never reaches the assignment below, so call.err
			// is still its zero value (nil) here — don't let that read as
			// "succeeded with nil items" and get cached.
			if p == nil && call.err == nil {
				c.entries[key] = autocompleteEntry{items: call.items, expires: c.now().Add(c.ttl)}
			}
			c.mu.Unlock()
			close(call.done)
			if p != nil {
				panic(p)
			}
		}()
		call.items, call.err = fn()
	}()

	return call.items, call.err
}
