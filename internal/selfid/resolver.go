package selfid

import (
	"context"
	"database/sql"
	"time"
)

// Lookup returns the user's ID for one source.
type Lookup func(ctx context.Context) (string, error)

// Resolver looks up the user's ID for each configured source and stores it.
// Only configured sources get a Lookup; a source that fails keeps whatever
// was stored before, so a transient outage never stops exclusion.
type Resolver struct {
	DB      *sql.DB
	Lookups map[string]Lookup
	Logf    func(format string, args ...any)
}

// ResolveOnce tries every source not yet resolved in this Resolver's
// lifetime and returns how many are still pending.
func (r *Resolver) ResolveOnce(ctx context.Context) (pending int) {
	for src, look := range r.Lookups {
		id, err := look(ctx)
		if err == nil && id != "" {
			err = Set(r.DB, src, id)
		}
		if err != nil || id == "" {
			pending++
			if r.Logf != nil {
				r.Logf("self identity: %s: %v", src, err)
			}
			continue
		}
		delete(r.Lookups, src)
	}
	return pending
}

// Run resolves now, then retries the pending sources every retry interval
// until all have succeeded or ctx is done.
func (r *Resolver) Run(ctx context.Context, retry time.Duration) {
	if r.ResolveOnce(ctx) == 0 {
		return
	}
	t := time.NewTicker(retry)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if r.ResolveOnce(ctx) == 0 {
				return
			}
		}
	}
}
