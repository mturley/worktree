# `worktree cd` — design

## Intent

`worktree cd <name>` (or `wt cd <name>`) moves the current shell into a
registered worktree, then prints `worktree info` for it. Today the only help
is `cdHint`'s printed `cd …` line after `worktree add`.

## Goals

- Resolve `<name>` against every registered worktree, matching either the
  directory basename or the branch name.
- One match: cd there. Several matches (same name in different repos, or one
  worktree's directory name equal to another's branch): prompt with a
  numbered list (repo, branch, path) and cd to the pick. No match: error.
- After the cd, run `worktree info` in the new directory.
- Works as both `worktree cd` and `wt cd` (`wt` is the existing symlink
  `make install` creates).
- zsh, bash and fish.

## Non-goals

- Fuzzy or prefix matching. Exact name or branch only.
- cd by path or by resource (PR/Jira URL).

## Constraints

- A child process cannot change its parent shell's cwd, so the cd has to
  happen in a shell function.
- `ShellRC.IsInstalled()` treats any existing managed block as installed, so
  users with the older snippet would never get the function.

## Approaches

1. **Shell function in the managed rc block + binary resolves the name.**
   (Chosen.) The binary does lookup and prompting and prints only the chosen
   path on stdout. The prompt is drawn on stderr/tty so `$(…)` capture works.
   The function cds and runs `info`.
2. **Spawn a subshell in the worktree.** Rejected: it nests shells and
   doesn't change the user's current shell.
3. **`cd "$(worktree path x)"` by hand.** Rejected: that isn't the
   requested UX.

## Design

- **`cmd/cd.go`: `worktree cd <name>`.**
  - Matches against `registry.List`. Prompts on stderr when there are several
    matches, reading from the tty.
  - On success it prints only the path to stdout. If stdin/stderr isn't a
    terminal and the name is ambiguous, it errors and lists the candidates.
  - It uses the env var `WORKTREE_SHELL_FN=1`, set by the shell function, to
    tell whether it is running under the function. Without it, it prints a
    hint to stderr ("re-run `worktree setup` to enable cd") alongside the
    path.
  - It is a read command, so it goes in `skillReadCommands`.
  - Shell completion lists worktree directory names and branches.
- **Shell function (all three snippets).**
  - The function is defined for both `worktree` and `wt`. When the first
    argument is `cd`, it captures the path, cds into it and runs
    `command worktree info`.
  - Otherwise it passes everything through with `command worktree "$@"`
    (or `command wt`).
  - Shape (zsh/bash share one body; fish has its own):

    ```sh
    _worktree_dispatch() {
      local bin=$1; shift
      if [ "$1" = cd ]; then
        shift
        local dir
        dir=$(WORKTREE_SHELL_FN=1 command "$bin" cd "$@") || return
        [ -d "$dir" ] || { printf '%s\n' "$dir"; return; }  # e.g. `wt cd --help`
        builtin cd -- "$dir" && command "$bin" info
      else
        command "$bin" "$@"
      fi
    }
    worktree() { _worktree_dispatch worktree "$@"; }
    wt()       { _worktree_dispatch wt "$@"; }
    ```

    ```fish
    function worktree --wraps worktree
      if test "$argv[1]" = cd
        set -l dir (WORKTREE_SHELL_FN=1 command worktree cd $argv[2..-1]); or return
        test -d "$dir"; or begin; printf '%s\n' $dir; return; end
        builtin cd -- $dir; and command worktree info
      else
        command worktree $argv
      end
    end
    function wt --wraps wt; worktree $argv; end
    ```

  - **Comments in the rc block (the user asked for these).** The block
    explains, as comments, why the function exists:
    - a program can't change its parent shell's directory, so `cd` has to
      happen in the shell;
    - every other subcommand passes straight through to the binary;
    - the binary prompts on stderr and prints only the path on stdout;
    - `WORKTREE_SHELL_FN` tells the binary that the function is present.
- **Setup.** The managed block gains a version line. `IsInstalled` reports an
  outdated block as not installed, and `Install` replaces the block in place.
  Uninstall is unchanged, since the block is still removed by its markers.
- **Tests.** Name/branch matching and ambiguity, non-tty ambiguous error,
  and rc-snippet upgrade/replace.

## Left to the builder

- The exact prompt wording and how the list is formatted.
