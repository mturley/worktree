# `worktree cd` (no argument → main checkout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bare `worktree cd` / `wt cd` inside a registered worktree goes to its repo's main checkout.

**Architecture:** `runCd` branches on `len(args)`. With no argument it
resolves the current worktree through `resolveWorktreeFlag(conn, ".")`,
looks up its `registry.Entry`, and prints its `RepoRoot` after an existence
check. The shell function is unchanged.

**Tech Stack:** Go, cobra.

**Spec:** `docs/superpowers/specs/2026-11-14-worktree-cd-main-checkout-design.md`

## Global Constraints

- stdout carries only the path. Errors go to stderr through cobra.
- The not-in-a-worktree error is exactly `not inside a registered worktree; pass a worktree name`.
- Every commit uses `--signoff`.

## Review Focus

- Running from a subdirectory of a worktree must still resolve that worktree, not error.
- Running from the main checkout itself must error, not cd to itself.
- `wt cd` (no argument) through the shell function must cd, not print usage.

---

### Task 1: no-argument `cd` + v1 uninstall test

**Files:**
- Modify: `cmd/cd.go`, `cmd/cd_test.go`
- Modify: `internal/setup/shellrc_test.go`
- Modify: `README.md`

**Interfaces:**
- Produces: `func mainCheckoutFor(entries []registry.Entry, wtPath string) (string, error)`
  - Finds the entry whose `wdb.Subscriber(Path)` equals `wdb.Subscriber(wtPath)`.
  - Errors when none is found, or when its `RepoRoot` does not exist or is
    not a directory.
  - `runCd`'s no-argument path calls it with the path from
    `resolveWorktreePath(nil)`. It maps a "not a worktree" result to the
    exact error above.

- [ ] **Step 1: Write failing tests** (`cmd/cd_test.go`, `t.Parallel()`, real temp dirs)
  - `TestMainCheckoutForReturnsRepoRoot`: an entry with `Path: wt` (temp dir)
    and `RepoRoot: root` (temp dir) gives `root`.
  - `TestMainCheckoutForNotAWorktreeErrors`: calling it with `root` errors
    with the exact constraint message.
  - `TestMainCheckoutForMissingRootErrors`: when `RepoRoot` doesn't exist,
    the error mentions the path.
  - `TestCdAcceptsZeroArgs`: `cdCmd.Args(cdCmd, nil) == nil`, and
    `cdCmd.Args(cdCmd, []string{"a","b"}) != nil`.
  - `internal/setup`: `TestUninstallRemovesOldBlock`: given
    `"before\n"+v1ZshBlock+"\n"`, `Uninstall()` leaves `"before\n"`. This
    covers existing behaviour, so it passes from the start; that's expected.
- [ ] **Step 2: Run them**
  - Run: `go test ./cmd/ -run 'MainCheckout|ZeroArgs'`
  - Expected: FAIL (undefined `mainCheckoutFor`; Args rejects zero args)
- [ ] **Step 3: Implement**
  - `Args: cobra.MaximumNArgs(1)`; `Use: "cd [name]"`.
  - In the Long text, add a line about the no-argument form.
  - In `runCd`, branch on `len(args)`.
- [ ] **Step 4: README**
  - Change the command line to `worktree cd [name]` and add "with no name,
    the current worktree's main checkout" to the description paragraph.
- [ ] **Step 5: Verify**
  - Run: `go test ./cmd/ ./internal/setup/`
  - Expected: PASS
  - Then `go build -o bin/worktree .` and, in zsh with the function (as
    before), run `wt cd` from inside a real worktree's subdirectory, then
    `pwd`.
  - Expected: the repo's main checkout path, then `worktree info` output.
- [ ] **Step 6: Commit** `feat(cli): bare worktree cd goes to the repo's main checkout`
