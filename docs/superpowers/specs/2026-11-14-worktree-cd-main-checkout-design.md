# `worktree cd` with no argument — design

## Intent

From inside a worktree, a bare `wt cd` takes you to that worktree's repo's
main checkout. This is a quick way back to the repo after working in a
worktree. It extends `docs/superpowers/specs/2026-11-14-worktree-cd-design.md`.

## Design

- `worktree cd` accepts zero or one argument (`cobra.MaximumNArgs(1)`).
- **No argument:**
  - Resolve the current registered worktree from cwd (git toplevel, so any
    subdirectory works) with `resolveWorktreeFlag(conn, ".")`.
  - Its registry entry's `RepoRoot` is the destination.
- **Errors:**
  - Not inside a registered worktree (including when already in the main
    checkout): `not inside a registered worktree; pass a worktree name`.
  - `RepoRoot` missing on disk: error, as for a missing worktree directory.
- **Output:** prints only the path on stdout, as before. The shell function
  is unchanged: a bare `wt cd` reaches the binary with no argument, then cds
  and runs `worktree info`. `info` in a main checkout prints just the git
  line.
- **Docs:** update the README line and `cd`'s Use/Long.
- **Also in this change:** a test that `ShellRC.Uninstall()` removes a
  pre-version (v1) block.

## Approaches

The one sensible way is a registry lookup of the current worktree's
`repo_root`. Alternatives rejected:
- `cd -`-like behaviour, and a picker: neither is what was asked.
- `git rev-parse --git-common-dir`: it would work for unregistered
  worktrees too, but every other `worktree` command keys off the registry,
  and `repo_root` is already stored.

## Non-goals

- Going from the main checkout to a worktree.
- Unregistered worktrees.
