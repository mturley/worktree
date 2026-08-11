# Phase 1 — `worktree env` cold-start measurement (PC-1 decision)

**Date:** 2026-08-11
**Machine:** macOS (darwin 25.6.0), Apple Silicon, `mturley`'s dev machine.
**Binary:** `bin/worktree` built at commit `36f4791` via `make build`. **Size: 16 MB** (no embedded web UI yet — that lands in Phase 2 and is the reason this measurement exists).
**Threshold for splitting a separate binary:** ~50 ms warm per invocation (runs on every `cd` via the shell hook).

## What was measured

`worktree env` is invoked by the shell chpwd/PROMPT_COMMAND hook (Task 10) on every directory change, so the relevant number is the **warm** per-invocation wall time (the binary is page-cached after first use in a session), on both the common paths:

- **registry-miss** (outside any managed worktree — the most common `cd`): opens the DB, migrates, `registry.Get` returns nil → prints nothing.
- **DB-hit** (inside a registered worktree with a port allocation): opens the DB, `registry.Get` + `ports.Lookup` → prints the 4 export lines.

Method: `/usr/bin/time -p` over 8 runs each, with a scratch `HOME`/`WORKTREE_DB` so the real user DB/config were never touched.

## Results

```
binary: 16M

worktree env — outside any worktree (registry-miss, the common cd case), 8 runs:
  real 0.48   <- cold (first run: OS page-caches the 16M binary + first DB open/migrate)
  real 0.01
  real 0.01
  real 0.01
  real 0.01
  real 0.01
  real 0.01
  real 0.01

worktree env — DB HIT path (registered worktree + port allocation), 8 runs:
  real 0.01  (x8)

baseline 'true' (process-spawn floor), 3 runs: real 0.00 (x3)
```

- **Cold start (first invocation in a fresh session): ~480 ms** — one-time, dominated by faulting the 16 MB binary into the page cache plus the first SQLite open/migrate.
- **Warm start (every subsequent `cd`): ~10 ms**, identical on both the registry-miss and DB-hit paths. This is the number that matters for the per-`cd` hook.

## Decision

**Warm cost (~10 ms) is far below the ~50 ms threshold → ship `worktree env` in the main binary. The separate tiny `worktree-env` binary is DEFERRED (not needed) for Phase 1.**

Rationale:
- 10 ms per `cd` is imperceptible and well within budget.
- The only large number is the ~480 ms *first* invocation per shell session, which is a one-time page-cache warm-up, not a per-`cd` cost. It is not worth a second build artifact.

## Revisit trigger (Phase 2)

The embedded Vite/React web UI (Phase 2) will grow the binary well beyond 16 MB, which raises the **cold-start** (first-`cd`-per-session) faulting cost. Re-run this measurement after the UI is embedded. If the **warm** per-`cd` figure climbs above ~50 ms — or the cold first-run becomes annoying in practice — reconsider the separate minimal `worktree-env` binary (DB read + print exports, no cobra/UI deps) invoked by the shell hook instead of `worktree env`. Until then, one binary.
