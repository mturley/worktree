# Agent Skills Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let worktree ship any number of agent skills, and add, rename or remove them between releases, with `worktree setup` keeping users' skill directories exactly in step and `--uninstall` removing everything, without ever touching another tool's skills.

**Architecture:** Real copies live in a store worktree owns outright, `${XDG_DATA_HOME:-~/.local/share}/worktree/skills/<name>/`, rewritten each run to exactly the skills the binary embeds. Every skills directory agents read gets a symlink per skill pointing straight into the store. A symlink is worktree's if and only if its target's parent directory is the store, which stays checkable after the target is gone, so stale links are found by scanning, never by remembering old names.

**Tech Stack:** Go, `embed.FS`, `os.Readlink`/`os.Lstat`, the existing `internal/setup` Plan/Preview/Execute flow.

**Spec:** No separate spec file; the design was agreed in conversation on 2026-11-10 and is captured in "Design" below. Read it before any task.

## Design

- **Store:** `agentskill.StoreDir` = `$XDG_DATA_HOME/worktree/skills` when `XDG_DATA_HOME` is absolute, else `~/.local/share/worktree/skills` (beside `worktree.db`; not `~/.config`, which people keep in dotfiles repos). Store subdirectories whose names start with `.` are never skills: `.linked-dirs` and `.tmp-*` live there.
- **Skill directories to link into** (`agentskill.SkillDirs`): `~/.agents/skills` always (Codex and pi; created if missing), then `$CLAUDE_CONFIG_DIR/skills` and `~/.claude/skills` only if they exist. Deduplicated by realpath, first wins.
- **Ownership:** an entry is worktree's only when it is a symlink whose target (resolved against the link's directory if relative, then cleaned) has as its parent one of the store's root forms: the store path as written, its `EvalSymlinks`, and `EvalSymlinks(parent)/skills`. Real directories, files, and links pointing anywhere else are never modified or removed.
- **Consent, asked every run** (the watchers' pattern, `configureWatchers`): the store directory existing means "installed".
  - Installed → ask `"Worktree's skills for AI agents are installed. Keep them?"`, default yes. Yes → sync. No → remove them exactly as uninstall does. `confirmDefault` answers a non-interactive run (`make install`) with the default, so it keeps and syncs.
  - Not installed → an interactive run offers `"Install worktree's skills for AI agents (Claude Code, Codex, pi…)?"` (default yes); a non-interactive run doesn't install.
  - Whenever the skills end up not kept, worktree's own links that would dangle are removed.
- **The menu bar app gets the same keep question** (Task 4): installed → `"The worktree menu bar app is installed. Keep it?"`, default yes; No → `UninstallMacApp` (quit, login item, app, web view data).
- **Sync (keep = true):** write each shipped skill whose store copy is missing or differs (exact file set and bytes; user edits are overwritten), prune store skills no longer shipped, and in every scan directory: create a missing link per shipped skill, re-point an owned link whose target name differs from its own name, remove owned links whose name isn't shipped, and leave a non-owned entry at a shipped name alone with a notice.
- **Scan directories** = `SkillDirs` ∪ the dirs listed in `<store>/.linked-dirs` that still exist, deduplicated by realpath. Recorded dirs get new skills linked too (they were consented in an earlier run, e.g. a second Claude config dir). After applying, the parent of every created, re-pointed or kept link is added to `.linked-dirs` (absolute paths, one per line, sorted, union with what was there).
- **No deleted-link tracking:** a link the user deletes comes back on the next run. Opting out of one skill is done by putting their own directory at that path.
- **Uninstall:** remove every owned link in the scan directories (any name), then `RemoveAll(store)`.
- **No migration** from the old `~/.agents/skills/worktree` real-directory layout: nobody has a release that installed it.
- **pi follows symlinked skill folders:** verified 2026-11-10 against pi 1.5.0 (`dist/core/skills.js` stats through `isSymbolicLink()` entries). Codex was verified 2026-10-31; Claude Code already reads the existing symlinks.

## Global Constraints

- `go test ./...` passes (`make test`), and `go vet ./...` is clean.
- Tests in `internal/setup` call `t.Parallel()` unless they use `captureStdout`, `t.Setenv`, or chmod a shared dir.
- Commits use `git commit --signoff` and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Add files by name, never `git add -A`.
- Every new Plan field needs an entry in `planStepUninstall` (`internal/setup/agentskill_test.go`, moved in Task 3).
- Links are created with absolute targets.

## Review Focus

1. **Another tool's links in the same directory** (cmux links `~/.claude/skills/cmux → ~/.agents/skills/cmux`, possibly dangling): untouched by sync and uninstall. Pinned by `TestForeignEntriesUntouched` (Task 2).
2. **Skills directories that are the same directory** (`~/.claude-personal/skills → ~/.claude/skills`, or `~/.claude/skills → ~/.agents/skills`): one link per skill, removed once, no error. Pinned by `TestSharedSkillsDirLinkedOnce` (Task 2).
3. **`CLAUDE_CONFIG_DIR` differs between runs:** uninstall run under B removes links made under A; a sync under B with a new skill also links it into A. Pinned by `TestRecordedDirFromAnotherConfigDir` (Task 2).
4. **Store reached through a symlink** (`XDG_DATA_HOME` or `$HOME` via a symlink), and links with relative targets: still recognised as worktree's. Pinned by `TestOwnedTarget` and `TestStoreReachedThroughSymlink` (Task 2).
5. **The user's own directory at a shipped skill's name**, including after that skill is dropped from worktree: never replaced or removed, a notice in preview. Pinned by `TestUserEntryAtShippedName` (Task 2).

---

### Task 1: Multi-skill embed, store path and skill directories

**Files:**
- Move: `internal/agentskill/SKILL.md` → `internal/agentskill/skills/worktree/SKILL.md` (`git mv`)
- Modify: `internal/agentskill/agentskill.go`
- Test: `internal/agentskill/agentskill_test.go`

**Interfaces:**
- Produces:
  - `type Skill struct { Name string; Files map[string][]byte }` — `Files` keys are slash-separated paths relative to the skill dir.
  - `func Skills() []Skill` — every directory under the embedded `skills/`, sorted by name.
  - `func StoreDir(home string, getenv func(string) string) string`
  - `func SkillDirs(home string, getenv func(string) string, exists func(string) bool, realpath func(string) (string, error)) []string`
  - `Content` and `Body()` keep their meaning (the worktree skill's `SKILL.md`), embedded from the new path. `Targets`, `Target` and `Hash` stay untouched until Task 3 deletes them.

- [ ] **Step 1: Move the file**

`git mv internal/agentskill/SKILL.md internal/agentskill/skills/worktree/SKILL.md` and change `Content`'s `//go:embed` to the new path. Run `go test ./internal/agentskill/ ./cmd/` — PASS (nothing else changed).

- [ ] **Step 2: Write failing tests**

```go
func TestSkillsMatchTheirDirectories(t *testing.T) // every Skill has Files["SKILL.md"] starting "---\nname: <Name>\n"; Names sorted, unique; one is "worktree" whose SKILL.md equals Content
func TestStoreDir(t *testing.T) // table:
//   XDG_DATA_HOME="/data"      → "/data/worktree/skills"
//   XDG_DATA_HOME="rel/data"   → "/home/.local/share/worktree/skills"  (relative ignored, per the XDG spec)
//   unset                      → "/home/.local/share/worktree/skills"
func TestSkillDirs... // port the five TestTargets* tests to SkillDirs; expected values become plain dirs:
//   with CLAUDE_CONFIG_DIR=/x and /x/skills existing → ["/home/.agents/skills", "/x/skills"]
//   default claude dir existing                      → ["/home/.agents/skills", "/home/.claude/skills"]
//   missing parent                                   → ["/home/.agents/skills"]
//   two config dirs sharing a realpath               → ["/home/.agents/skills", "/home/.claude-personal/skills"]
//   claude dir whose realpath is ~/.agents/skills    → ["/home/.agents/skills"]
//   realpath failure keeps an existing dir
```

- [ ] **Step 3: Run to verify they fail**

Run: `go test ./internal/agentskill/`
Expected: FAIL — `Skills`, `StoreDir`, `SkillDirs` undefined.

- [ ] **Step 4: Implement**

`//go:embed skills` into an `embed.FS`; `Skills()` walks it with `fs.WalkDir`. `SkillDirs` reuses `Targets`' realpath dedupe; refactor `Targets` to call it so the logic isn't duplicated in the meantime. Update the package doc comment and the "Verified" comment to add: pi 1.5.0 follows symlinked skill folders (verified 2026-11-10).

- [ ] **Step 5: Run tests**

Run: `go test ./internal/agentskill/ ./cmd/ ./internal/setup/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add internal/agentskill/agentskill.go internal/agentskill/agentskill_test.go internal/agentskill/skills/worktree/SKILL.md
git commit --signoff -m "feat(agentskill): embed a directory of skills; store and skill-dir paths"
```

---

### Task 2: The skills sync engine

New code beside the old one: `internal/setup/agentskill.go` is untouched until Task 3. This task's tests reuse the old test file's helpers (`mustWrite`, `mustSymlink`, `lexists`, `readlink`, `captureStdout`); do not redefine them.

**Files:**
- Create: `internal/setup/skills.go`
- Test: `internal/setup/skills_test.go`

**Interfaces:**
- Consumes: `agentskill.Skill`, `Skills`, `StoreDir`, `SkillDirs` (Task 1).
- Produces:

```go
type skillDeps struct {
	Home     string
	Getenv   func(string) string
	Exists   func(string) bool
	Realpath func(string) (string, error)
	Confirm  func(string, bool) bool
	Skills   []agentskill.Skill // what this binary ships; tests pass their own
}
func defaultSkillDeps() skillDeps // os.UserHomeDir (""), os.Getenv, dirExists, filepath.EvalSymlinks, confirmDefault, agentskill.Skills()

type skillPrompt int

const (
	skillPromptNone  skillPrompt = iota // not installed, non-interactive
	skillPromptOffer                    // not installed, interactive: "Install …?"
	skillPromptKeep                     // installed: "… Keep them?"
)

type skillPlan struct {
	Store       string
	Prompt      skillPrompt
	Keep        bool     // the store stays and is synced (what this plan does if the answer is yes)
	Write       []string // skill names whose store copy is missing or differs
	Prune       []string // store skill names no longer shipped
	Link        []string // absolute link paths to create
	Relink      []string // owned links pointing at the wrong store entry
	Unlink      []string // owned links to remove
	Kept        []string // owned links already correct (recorded in .linked-dirs)
	Conflicts   []string // a shipped name's path holds something not ours
	RemoveStore bool     // uninstall only
}

func storeRoots(store string, realpath func(string) (string, error)) []string
func ownedTarget(path string, roots []string) (name string, ok bool) // name = base of the target
func planSkills(d skillDeps, keep bool) skillPlan
func detectSkills(d skillDeps, nonInteractive bool) skillPlan
func (p skillPlan) HasWork() bool   // Prompt != skillPromptNone || RemoveStore || any of Write/Prune/Link/Relink/Unlink non-empty
func (p skillPlan) Preview()
func runSkillsStep(d skillDeps, p skillPlan) error
func planSkillsUninstall(d skillDeps) skillPlan // planSkills(d, false) plus RemoveStore when the store exists
```

All of them return the zero plan / do nothing when `d.Home == ""`.

- [ ] **Step 1: Write the fixture and failing tests**

`newSkillsFixture(t)`: an `EvalSymlinks`'d temp root holding `home/` and `claude-config/`; `~/.agents/skills`, `~/.claude/skills` and `claude-config/skills` each hold a real `other-skill/SKILL.md`; `Getenv` returns `CLAUDE_CONFIG_DIR=<root>/claude-config` and nothing for `XDG_DATA_HOME`; `Confirm` returns true; `Skills` = two fake skills `alpha` (`SKILL.md` + `refs/a.md`) and `beta`. Helpers: `f.store()`, `f.links(name) []string` (the three link paths), `f.assertSiblingsSurvive(t)`, and `withSkills(d, names...) skillDeps` to simulate a release that ships a different set.

```go
func TestOwnedTarget(t *testing.T)
// table over entries made in a temp dir:
//   absolute link to <store>/alpha           → "alpha", true
//   relative link resolving to <store>/alpha → "alpha", true
//   link to <realpath(store)>/alpha          → "alpha", true
//   dangling link to <store>/gone            → "gone", true
//   link to <store>/alpha/refs (deeper)      → false
//   link to ~/.agents/skills/cmux            → false
//   real directory, regular file, missing    → false
func TestInstallThenUninstallLeavesNothing(t *testing.T)
// detectSkills(d,false).Prompt == skillPromptOffer; run; store has alpha+beta files byte-equal and .linked-dirs listing the 3 dirs;
// all 6 links readlink to <store>/<name>; detectSkills again → Prompt == skillPromptKeep, Keep, and no Write/Prune/Link/Relink/Unlink;
// planSkillsUninstall → preview mentions every link and the store; apply → store and links gone; siblings survive;
// planSkillsUninstall again → HasWork false.
func TestDeclinedOfferWritesNothing(t *testing.T)            // Confirm false → no store, no links, ~/.agents/skills/other-skill intact
func TestNonInteractiveNotInstalledInstallsNothing(t *testing.T) // detectSkills(d,true): Prompt none, Keep false, no Write/Link
func TestInstalledAskedToKeep(t *testing.T)
// install; then detectSkills(d,false|true).Prompt == skillPromptKeep for both.
// Confirm records its prompt: "Worktree's skills for AI agents are installed. Keep them?" with default true.
// Confirm false → store and all 6 links gone, siblings survive (same result as uninstall).
// Confirm true with a changed skill → synced as in TestSyncRewritesChangedSkill.
func TestNotInstalledStillRemovesOurDanglingLinks(t *testing.T)  // links to <store>/alpha with no store, non-interactive → Unlink lists them; run removes them
func TestSyncRewritesChangedSkill(t *testing.T)
// edit <store>/alpha/SKILL.md, add <store>/alpha/extra.md → Write == ["alpha"]; after run: exact files, extra.md gone, no .tmp-* left
func TestRemovedSkillIsPrunedAndUnlinked(t *testing.T)    // install alpha+beta; withSkills(d,"alpha") → Prune ["beta"], Unlink = beta's 3 links; after: no beta anywhere
func TestRenamedSkill(t *testing.T)                       // install alpha+beta; withSkills(d,"alpha","gamma") with gamma's files → beta gone, gamma written and linked in all 3 dirs
func TestRelinkWrongTarget(t *testing.T)                  // ~/.claude/skills/alpha → <store>/beta → Relink; after run readlink == <store>/alpha
func TestUserEntryAtShippedName(t *testing.T)
// real dir at ~/.claude/skills/alpha, and a link ~/.agents/skills/beta → /elsewhere/beta:
// Conflicts lists both; preview prints "exists and isn't worktree's"; run leaves both byte-identical;
// withSkills(d) (nothing shipped) then planSkillsUninstall + run: both still there.
func TestForeignEntriesUntouched(t *testing.T)
// ~/.claude/skills/cmux → ~/.agents/skills/cmux (exists), ~/.claude/skills/old → /nowhere (dangling):
// survive install, a sync shipping nothing, and uninstall.
func TestSharedSkillsDirLinkedOnce(t *testing.T)
// ~/.claude/skills is a symlink to ~/.agents/skills; CLAUDE_CONFIG_DIR unset → exactly one link per skill,
// uninstall removes each once without error.
func TestRecordedDirFromAnotherConfigDir(t *testing.T)
// install with CLAUDE_CONFIG_DIR=A; with B: .linked-dirs keeps A; withSkills(dB,"alpha","beta","gamma") links gamma into A too;
// planSkillsUninstall(dB) removes A's links; a recorded dir that no longer exists is ignored, not an error.
func TestStoreReachedThroughSymlink(t *testing.T)
// XDG_DATA_HOME=<root>/data-link → <root>/data; install; then run with XDG_DATA_HOME=<root>/data → no Write/Link/Relink/Unlink, links Kept
func TestUnknownHomeDoesNothing(t *testing.T)            // Home "" → zero plan, run and uninstall write nothing
func TestSkillsPreviewLines(t *testing.T)
// a plan with one of each field prints, in order:
//   "• Offer to install worktree's skills for AI agents (<short store>)"   (skillPromptOffer)
//   "• Ask whether to keep worktree's skills for AI agents (removes them if not)"   (skillPromptKeep)
//   "• Write the alpha skill", "• Remove the beta skill (no longer shipped)",
//   "• Link the alpha skill into <short dir>", "• Re-point <short link>", "• Remove the link <short link>",
//   "— <short path> exists and isn't worktree's; leaving it", "• Remove worktree's skills: <short store>"
```

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./internal/setup/`
Expected: FAIL to compile — undefined: `skillDeps`, `planSkills`, …

- [ ] **Step 3: Implement `internal/setup/skills.go`**

Follow "Design" exactly. Notes the tests don't pin:
- Writing a skill: `os.MkdirTemp(store, ".tmp-"+name+"-")`, write every file (`MkdirAll` for subpaths, 0o644 / dirs 0o755), `RemoveAll(store/name)`, `Rename`. Prune also removes leftover `.tmp-*` dirs.
- Apply order: Write, Prune, Unlink, Relink (remove then symlink), Link (`MkdirAll` the parent: `~/.agents/skills` may not exist), record `.linked-dirs`, then `RemoveAll(store)` if `RemoveStore`. Collect per-item errors with `errors.Join` so one failure doesn't stop the rest; print `✓` lines as the old code did.
- `runSkillsStep` asks first. `skillPromptOffer`: yes → apply `planSkills(d, true)`; no → apply the plan as built (its dangling-link removals). `skillPromptKeep`: yes → apply the plan as built (`Keep` is true); no → apply `planSkillsUninstall(d)`. `skillPromptNone`: apply as built. Prompt wording and defaults are in "Design".
- An unreadable scan dir is skipped, not an error.

- [ ] **Step 4: Run tests**

Run: `go test -race ./internal/setup/`
Expected: PASS (old and new tests both)

- [ ] **Step 5: Commit**

```bash
git add internal/setup/skills.go internal/setup/skills_test.go
git commit --signoff -m "feat(setup): skills store sync engine with link ownership by target"
```

---

### Task 3: Switch setup and uninstall to the store; delete the old code

**Files:**
- Modify: `internal/setup/setup.go` (Plan field, `BuildPlan`, `Preview`, `HasWork`, `Execute`, `PreviewUninstall`)
- Create: `internal/setup/agentuninstall.go` — `agentUninstall`, `defaultAgentUninstall`, `previewAgentUninstall`, `runAgentUninstall`, `watcherConsumerRegistered`, `unregisterWatcherConsumer`, moved from `agentskill.go` with `Skill` retyped to `skillDeps`
- Create: `internal/setup/agentuninstall_test.go` — the watcher-consumer tests, `writeWatcherConfig`, `consumersIn`, `planDataFields`, `planStepUninstall`, `TestUninstallCoversEverySetupStep`, `TestPreviewUninstallListsEverything`, ported
- Delete: `internal/setup/agentskill.go`, `internal/setup/agentskill_test.go` (move `mustWrite`, `mustSymlink`, `lexists`, `readlink` into `skills_test.go` first)
- Modify: `internal/agentskill/agentskill.go` (delete `Target`, `Targets`, `Hash` and their tests)
- Modify: `README.md` ("The agent skill" section), `.claude/CLAUDE.md` (the `agentskill` bullet, and the `SKILL.md` path in "Adding a CLI command")

**Interfaces:**
- Consumes: everything Task 2 produces.
- Produces: `Plan.AgentSkills skillPlan` replacing `AgentSkill` and `AgentSkillLinks`; `agentUninstall{Skill skillDeps, WatcherPath, Consumer string}`.

- [ ] **Step 1: Port the tests that change**

- `planStepUninstall`: drop `AgentSkill`/`AgentSkillLinks`, add `"AgentSkills": "removed"`.
- `TestPreviewUninstallListsEverything`: set `XDG_DATA_HOME` to a temp dir too, install with `runSkillsStep`, expect `"Remove worktree's skills: "` and `"Remove the link ~/.claude/skills/worktree"` instead of the two old strings.
- `TestAgentUninstallEndToEnd`, `…WatcherFailureStillRemovesSkill`, `…SkillFailureStillUnregisters`: build on `newSkillsFixture`/`TestRecordedDirFromAnotherConfigDir`'s setup; assert store and every link gone (or, for the chmod case, the warning `"Removing worktree's skills"`).
- Add `TestPlanUsesSkillPlan`: `Plan{AgentSkills: skillPlan{Prompt: skillPromptKeep}}.HasWork()` is true, the zero value's is false, and `Plan.Preview` output contains the skill plan's lines.

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./internal/setup/`
Expected: FAIL to compile (`AgentSkills` undefined).

- [ ] **Step 3: Implement**

`BuildPlan`: `plan.AgentSkills = detectSkills(defaultSkillDeps(), ui.NonInteractive())`. `Preview` calls `p.AgentSkills.Preview()` in place of the old switch and loop; `HasWork` ORs `p.AgentSkills.HasWork()`; `Execute` calls `runSkillsStep(defaultSkillDeps(), p.AgentSkills)` with the existing warning wording changed to `"Worktree skills: %v"`. `previewAgentUninstall`/`runAgentUninstall` use `planSkillsUninstall` and its `Preview`/apply, warning `"Removing worktree's skills: %v"`. In `PreviewUninstall` change "Preserve worktree data" to "Preserve worktree data (except its agent skills)". Then delete the old files and `Target`/`Targets`/`Hash`.

Docs: README — setup offers to install worktree's skills into a store under `~/.local/share/worktree/skills/`, symlinked into `~/.agents/skills` (Codex, pi) and Claude Code's skills directories; each run brings them in step with the installed version (including removing skills it no longer ships); edits to the installed copy are overwritten, and putting your own directory at a skill's path opts out of it; `--uninstall` removes the links and the store. `.claude/CLAUDE.md` — replace the `agentskill` bullet's install description with the store, link-ownership-by-target, and `.linked-dirs`; point the "Adding a CLI command" bullet at `internal/agentskill/skills/worktree/SKILL.md`; add one line: a new skill is a new directory under `internal/agentskill/skills/`, and removing or renaming one needs no other code.

- [ ] **Step 4: Verify**

Run: `go vet ./... && go test -race ./internal/setup/ ./internal/agentskill/ ./cmd/ && make test`
Expected: PASS. Also `grep -rn 'AgentSkillAction\|Targets(\|agentskill.Hash\|worktree-skill-hash\|worktree-skill-links' --include='*.go' .` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add internal/setup/setup.go internal/setup/agentuninstall.go internal/setup/agentuninstall_test.go internal/setup/skills_test.go internal/agentskill/agentskill.go internal/agentskill/agentskill_test.go README.md .claude/CLAUDE.md
git rm internal/setup/agentskill.go internal/setup/agentskill_test.go
git commit --signoff -m "feat(setup): install agent skills from the store; drop the single-skill installer"
```

---

### Task 4: Ask whether to keep an installed menu bar app

Independent of Tasks 1–3.

**Files:**
- Modify: `internal/setup/macapp.go` (`MacAppAction`, `decideMacApp`, `runMacAppStep`)
- Modify: `internal/setup/setup.go` (`Preview`, `HasWork`, `Execute`'s guard)
- Test: `internal/setup/macapp_test.go`

**Interfaces:**
- Produces: `MacAppKeep MacAppAction` — installed, nothing to rebuild (current, or stale with no developer tools to rebuild with). `MacAppRebuild` now also asks the keep question first.

- [ ] **Step 1: Write failing tests**

```go
// TestDecideMacApp table changes/additions:
//   "installed, current"                       → MacAppKeep   (was MacAppNone)
//   "installed, current, no swiftc"            → MacAppKeep
//   "installed, stale, no swiftc"              → MacAppKeep   (was MacAppNoSwiftc)
//   "installed, stale" / "…, non-interactive"  → MacAppRebuild (unchanged)
//   "not installed, no swiftc"                 → MacAppNoSwiftc (unchanged)
func TestRunMacAppKeepAsks(t *testing.T)
// MacAppKeep and MacAppRebuild, each with the fake answering the keep prompt:
//   prompt is "The worktree menu bar app is installed. Keep it?" with default true;
//   yes + Keep    → no swiftc/build calls, files unchanged;
//   yes + Rebuild → builds (existing rebuild tests keep passing with the fake answering yes);
//   no (either)   → app, login item and web view data removed, no build call.
// TestHasWorkForMacApp: MacAppKeep → true.
// Plan.Preview: MacAppKeep prints "• Ask whether to keep the menu bar app (removes it if not)";
//   MacAppRebuild prints "• Ask whether to keep the menu bar app, then rebuild it (its source changed)".
```

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./internal/setup/ -run 'MacApp'`
Expected: FAIL — `MacAppKeep` undefined.

- [ ] **Step 3: Implement**

`decideMacApp`: check `Installed` before `HaveSwiftc`. `runMacAppStep`: for Keep/Rebuild, `d.Confirm(prompt, true)`; no → `return UninstallMacApp(d)`; yes + Keep → return nil; yes + Rebuild → existing rebuild path. `setup.go`: `Execute` runs the step for Keep too; `HasWork` includes Keep; the Preview strings above. `confirmDefault` already answers non-interactive runs with yes, so `make install` keeps the app.

- [ ] **Step 4: Run tests**

Run: `go test -race ./internal/setup/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/setup/macapp.go internal/setup/macapp_test.go internal/setup/setup.go
git commit --signoff -m "feat(setup): ask whether to keep an installed menu bar app"
```
