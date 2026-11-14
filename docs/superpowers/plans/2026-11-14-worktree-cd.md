# `worktree cd` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `worktree cd <name>` / `wt cd <name>` moves the current shell into a
registered worktree (prompting if the name is ambiguous), then prints
`worktree info`.

**Architecture:** The binary's new `cd` subcommand resolves the name against
the registry and prints only the chosen path on stdout, prompting on stderr.
A shell function in setup's managed rc block wraps `worktree`/`wt`. It
intercepts `cd`, changes into the path and runs `info`, and passes every
other subcommand straight through. The managed block gets a version stamp, so
setup replaces an outdated block in place.

**Tech Stack:** Go, cobra, zsh/bash/fish.

**Spec:** `docs/superpowers/specs/2026-11-14-worktree-cd-design.md`

## Global Constraints

- Exact match only (directory basename or branch); no fuzzy or prefix matching.
- stdout carries only the chosen path. Prompts, lists, hints and errors go to stderr.
- Env var name is exactly `WORKTREE_SHELL_FN` (set to `1` by the shell function).
- `worktree cd` is a read command: it goes in `skillReadCommands` (`cmd/agent_help_test.go`).
- It opens the DB with `wdb.OpenRead()`, never `Open`.
- The rc block's comments explain why the function exists. Cover: a program
  can't change its parent shell's directory; every other subcommand passes
  through; the binary prompts on stderr and prints only the path on stdout;
  `WORKTREE_SHELL_FN` tells the binary that the function is present.
- Every commit uses `--signoff`.

## Review Focus

- One worktree that matches by both basename and branch must appear once, not twice in the prompt.
- An ambiguous name with non-terminal stdin must error and list the candidates (path per line on stderr), never block on a read.
- An invalid or empty choice at the prompt must error. It must not silently pick the first candidate.
- A pre-version managed block in an rc file must be replaced in place, keeping user content before and after it byte-for-byte.
- `wt cd --help` through the shell function must print help, not try to `cd` into the help text.

---

### Task 1: `worktree cd` command

**Files:**
- Create: `cmd/cd.go`
- Create: `cmd/cd_test.go`
- Modify: `cmd/agent_help_test.go` (`skillReadCommands`: add `"worktree cd": true`)
- Modify: `README.md` (Worktree Management command list: add a `worktree cd <name>` line; note it needs the shell function from `worktree setup`)

**Interfaces:**
- Produces: `worktree cd <name>` CLI behavior (consumed by Task 2's shell function):
  - Exit 0 prints exactly `<path>\n` to stdout.
  - Non-zero exit prints nothing to stdout.

- [ ] **Step 1: Write failing tests in `cmd/cd_test.go`** (all `t.Parallel()`; pure functions, no DB)

```go
func TestMatchWorktreesByBasenameOrBranch(t *testing.T) {
	es := []registry.Entry{
		{Path: "/w/a/foo", Repo: "a", Branch: "foo"},
		{Path: "/w/b/foo", Repo: "b", Branch: "foo"},
		{Path: "/w/a/pr-1-x", Repo: "a", Branch: "fix-x"},
		{Path: "/w/a/bar", Repo: "a", Branch: "baz"},
	}
	// "foo" -> both /w/*/foo, in registry order; each once despite matching basename AND branch
	// "fix-x" -> [/w/a/pr-1-x]; "pr-1-x" -> [/w/a/pr-1-x]
	// "nope" -> empty; "fo" -> empty (no prefix matching)
}
func TestChooseWorktreeSingleMatchNoPrompt(t *testing.T)    // returns it; errw is empty
func TestChooseWorktreePromptsAndPicks(t *testing.T)        // in "2\n" -> second; errw lists both repos+branches+paths
func TestChooseWorktreeInvalidChoiceErrors(t *testing.T)    // in "" , "0\n", "3\n", "x\n" -> error
func TestChooseWorktreeNonInteractiveAmbiguousErrors(t *testing.T) // interactive=false -> error containing both paths
func TestCdNoMatchErrors(t *testing.T)                      // error mentions the name
func TestCdHintWithoutShellFn(t *testing.T)                 // getenv("WORKTREE_SHELL_FN")=="" -> stderr mentions "worktree setup"; =="1" -> no hint
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./cmd/ -run 'MatchWorktrees|ChooseWorktree|Cd' -v`
Expected: FAIL (undefined: matchWorktrees …)

- [ ] **Step 3: Implement in `cmd/cd.go`**
  - `func matchWorktrees(entries []registry.Entry, name string) []registry.Entry`
    keeps an entry when `filepath.Base(e.Path) == name || e.Branch == name`.
  - `func chooseWorktree(matches []registry.Entry, in io.Reader, errw io.Writer, interactive bool) (registry.Entry, error)`
    - Zero matches is the caller's problem; one match is returned without a
      prompt.
    - With several matches, it prints a numbered list `[n] repo  branch  ShortPath`
      to `errw`, then `Which worktree?:`, and reads one line from `in`.
    - When `interactive` is false it errors with each candidate path.
  - `func runCd(cmd *cobra.Command, args []string) error`
    - Takes `cobra.ExactArgs(1)`, `GroupID: "worktree"`, and
      `Use: "cd <name>"`, with a Short that mentions the shell function.
    - Reads `registry.List` via `wdb.OpenRead()`.
    - `interactive = ui.StdinIsTerminal() && !ui.NonInteractive()`.
    - If `os.Getenv("WORKTREE_SHELL_FN") != "1"`, it prints to stderr
      `` "cd needs the shell function: re-run `worktree setup`" ``.
    - It writes the path with `fmt.Fprintln(cmd.OutOrStdout(), path)`.
    - For the hint test, factor the getenv lookup through a func parameter or
      a small helper `cdHintNeeded(getenv func(string) string) bool`. Don't
      use `t.Setenv`.
  - `ValidArgsFunction` returns the sorted, de-duplicated basenames and
    branches from `registry.List` (open the DB read-only; on error return
    none), with `cobra.ShellCompDirectiveNoFileComp`.
- [ ] **Step 4: Add `"worktree cd": true` to `skillReadCommands`; add the README line.**
- [ ] **Step 5: Run tests**

Run: `go test ./cmd/ -v -run 'MatchWorktrees|ChooseWorktree|Cd|TestSkillNamesEveryWrite'`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add cmd/cd.go cmd/cd_test.go cmd/agent_help_test.go README.md
git commit --signoff -m "feat(cli): add worktree cd to resolve a worktree by name or branch"
```

### Task 2: Shell function in the managed rc block + in-place upgrade

**Files:**
- Modify: `internal/setup/shellrc.go`
- Modify: `internal/setup/shellrc_test.go`
- Modify: `internal/setup/setup.go` (plan summary wording only, if "Shell auto-source" no longer describes the block, e.g. "Shell integration")
- Modify: `README.md` (Setup bullet at line ~36: the hook now also adds the `worktree`/`wt` function for `worktree cd`)

**Interfaces:**
- Consumes: Task 1's `worktree cd` stdout/exit contract.
- Produces: `const shellRCVersion = 2`; the second line of every snippet is
  exactly `# worktree shell integration v2` (format
  `# worktree shell integration v%d`). `IsInstalled()` returns true only when
  that exact line is inside the managed block. `Install()` replaces an
  existing managed block (any version) in place, or appends one if there is
  none.

- [ ] **Step 1: Write failing tests in `internal/setup/shellrc_test.go`**

```go
func TestSnippetsCarryVersionLine(t *testing.T)            // zsh/bash/fish snippet contains "# worktree shell integration v2"
func TestSnippetsDefineWorktreeAndWtFunctions(t *testing.T) // zsh/bash: "worktree() {" and "wt()" and "WORKTREE_SHELL_FN=1 command"; fish: "function worktree --wraps worktree" and "function wt --wraps wt"
func TestSnippetsExplainWhy(t *testing.T)                  // each snippet contains "parent shell" (comment explaining a program can't cd its parent shell)
func TestIsInstalledFalseForOldBlock(t *testing.T)         // rc file with the v1 block (markers, no version line) -> false
func TestInstallReplacesOldBlockInPlace(t *testing.T)      // "before\n"+oldBlock+"\nafter\n" -> "before\n"+snippet+"\nafter\n"; exactly one markerBegin
func TestInstallIdempotent(t *testing.T)                   // Install twice -> file unchanged second time
func TestUninstallRemovesNewBlock(t *testing.T)            // still removes by markers
```
Use `t.TempDir()` rc paths, and keep the existing tests.

- [ ] **Step 2: Add a shell-level test that the zsh/bash function works**
  (`TestBashFunctionCdAndPassthrough`; skip if `bash` isn't on PATH).
  - Write a fake `worktree` script into a temp `bin` dir:
    - `cd <x>` prints a temp dir, or prints `usage` when given `--help`;
    - `info` prints `INFO`;
    - anything else prints `PASS:$*`.
  - Run, with that `bin` dir on PATH:
    `bash -c '<snippet>; worktree cd x; pwd; worktree list; wt cd --help'`.
  - Assert, in order: `INFO`, the temp dir, `PASS:list`, and `usage`.
  - Do the same for zsh if it's on PATH.
- [ ] **Step 3: Run tests to verify they fail**

Run: `go test ./internal/setup/ -run 'Snippet|IsInstalled|Install|Uninstall|Function' -v`
Expected: FAIL

- [ ] **Step 4: Implement**
  - Rewrite the three snippets. Keep the existing env hook and add the
    function from the spec's "Shape" blocks, with the explanatory comments
    above it.
  - `IsInstalled`: true only when the version line sits between the markers.
  - `Install`: if a managed block exists, splice the new snippet over
    `[markerBegin, markerEnd]`; otherwise append, as today.
  - The snippets' `_worktree_env_hook` and `_WORKTREE_CHPWD_REGISTERED`
    guards stay as they are. Re-sourcing the rc must not double-register the
    hook.
- [ ] **Step 5: Run tests**

Run: `go test ./internal/setup/ && go test ./cmd/`
Expected: PASS

- [ ] **Step 6: Verify end-to-end in a real shell**
  - Run `make build`.
  - Copy the zsh snippet into `~/tmp/wt-cd-snippet.zsh`.
  - Run `ln -sf worktree bin/wt`.
  - Run
    `PATH=$PWD/bin:$PATH zsh -c 'source ~/tmp/wt-cd-snippet.zsh; wt cd <a real worktree name>; pwd'`.
  - Expected: `worktree info` output followed by that worktree's path.
- [ ] **Step 7: Commit**

```bash
git add internal/setup/shellrc.go internal/setup/shellrc_test.go internal/setup/setup.go README.md
git commit --signoff -m "feat(setup): shell function for worktree cd; upgrade outdated rc block in place"
```
