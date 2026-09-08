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

	call.items, call.err = fn()

	c.mu.Lock()
	delete(c.calls, key)
	if call.err == nil {
		c.entries[key] = autocompleteEntry{items: call.items, expires: c.now().Add(c.ttl)}
	}
	c.mu.Unlock()

	close(call.done)
	return call.items, call.err
}
