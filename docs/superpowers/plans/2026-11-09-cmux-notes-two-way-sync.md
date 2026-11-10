# Two-way cmux notes sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the notes card's one-way "Sync to cmux workspace description" into a two-way sync that never loses content.

**Architecture:** Each worktree's notes row stores a version and the last text both sides agreed on (the base) plus the cmux workspace UUID it was agreed with. A pure direction table (`notes.Decide`) and a pure line-based three-way merge (`notes.Merge`) decide what to write. The existing 5 s cmux pass (`StartCmuxUnreadSync`) gains a description step that pulls/pushes/merges; notes saves run the same per-worktree sync and merge against the text the client's draft started from.

**Tech Stack:** Go (SQLite via `database/sql`), React + TanStack Query + Mantine, vitest.

**Spec:** `docs/superpowers/specs/2026-11-09-cmux-notes-two-way-sync-design.md`

## Global Constraints

- Checkbox label, exact: `Sync with cmux workspace description`.
- Conflict block format, exact: `<<<<<<< notes` / ours lines / `=======` / theirs lines / `>>>>>>> <label>`; labels are `cmux` (merging against the description) and `other edit` (a save merging against stored notes).
- An empty (after normalisation) cmux description is never pulled while the notes are non-empty; the notes are pushed instead.
- The base is keyed by workspace `id` (UUID), never `ref`.
- Normalise before comparing: CRLF→LF, strip trailing whitespace per line, trim whitespace from both ends of the whole text.
- No DB transaction is held across a cmux call. Every notes write is one `UPDATE … WHERE path = ? AND version = ?` (or insert-if-absent for version 0).
- The base advances only after both sides hold the same text.
- Sync only with exactly one matched workspace; everything gated on `s.cmuxEnabled()`.
- No new Go or npm dependency.
- `internal/webui` tests call `t.Parallel()` unless they set env/globals (repo CLAUDE.md); stub cmux through `Server.cmuxList` / `Server.cmuxSetDescription`.
- Commits use `git commit --signoff` and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git add -A`/`.`.

## Review Focus

1. A UI save that lands between the pass's listing and its mutex must not be undone by pulling the stale description — test in Task 5.
2. A pass right after a merge must do nothing (no re-merge, no nested markers) — test in Task 5.
3. A failed cmux push leaves the base unchanged and the next pass pushes again without inventing a conflict — test in Task 5.
4. Notes that legitimately contain a lone `=======` line (a Markdown setext heading) must not count as a conflict, so checkboxes stay clickable — test in Task 9.
5. Unchecking then re-checking sync after both sides diverged keeps both texts — test in Task 6.

---

### Task 1: Notes schema and compare-and-set store

**Files:**
- Modify: `internal/db/migrate.go` (bump `schemaVersion` 3→4; three `addColumnIfMissing` calls next to the `show_on_home` one)
- Modify: `internal/db/db_test.go` (`schemaFingerprint`)
- Modify: `internal/notes/notes.go`
- Test: `internal/notes/notes_test.go`

**Interfaces:**
- Produces:
  - `Notes` gains `Version int64`, `CmuxBase *string` (nil = no base), `CmuxBaseWorkspace string`.
  - `func CompareAndSet(conn *sql.DB, path string, expect int64, text string, syncCmux, showOnHome bool, base *string, baseWorkspace string) (Notes, bool, error)` — writes everything and sets `version = expect+1`, stamping `updated_at`; returns `ok=false` (no error) when the stored version ≠ `expect`. `expect == 0` with no row inserts.
  - `func SetBase(conn *sql.DB, path string, expect int64, base *string, baseWorkspace string) (bool, error)` — writes only the base columns, does NOT bump version or `updated_at`; `false` on version mismatch.
  - `Set` (used by the CLI) keeps its signature but now bumps `version` and leaves the base columns untouched.
  - `Get` returns the new fields.

- [ ] **Step 1: Write failing tests** in `internal/notes/notes_test.go`:
  - `TestCompareAndSetInsertsAtVersionZero`: CAS on a fresh path with expect 0 → ok, `Version == 1`, `Get` round-trips text/base/workspace.
  - `TestCompareAndSetRejectsStaleVersion`: after one write (version 1), CAS with expect 0 → `ok == false`, stored text unchanged.
  - `TestSetBaseDoesNotBumpVersion`: CAS → v1; `SetBase(…, 1, ptr("b"), "WS")` → true; `Get` shows `Version == 1`, `*CmuxBase == "b"`, `CmuxBaseWorkspace == "WS"`; `SetBase` with expect 0 → false.
  - `TestSetBumpsVersionAndKeepsBase`: CAS with base "b" → v1; `Set(conn, path, "new", true, true)` → `Get` shows `Version == 2`, `*CmuxBase == "b"`.
- [ ] **Step 2: Run** `go test ./internal/notes/` — expect FAIL (undefined `CompareAndSet`).
- [ ] **Step 3: Implement.** Columns: `version INTEGER NOT NULL DEFAULT 0`, `cmux_base TEXT`, `cmux_base_workspace TEXT NOT NULL DEFAULT ''`. CAS for expect>0 is a single `UPDATE … WHERE path=? AND version=?` checking `RowsAffected`; expect==0 is `INSERT … ON CONFLICT(path) DO NOTHING` checking `RowsAffected` (an existing row at version 0 — legacy — must also be accepted: fall back to the `UPDATE … AND version=0` form when the insert affected nothing).
- [ ] **Step 4: Run** `go test ./internal/notes/ ./internal/db/` — notes PASS; `TestSchemaVersionCoversSchema` prints the new fingerprint: paste it into `schemaFingerprint`, rerun, PASS.
- [ ] **Step 5: Commit** `feat(notes): version and cmux base columns with compare-and-set writes`.

### Task 2: Normalise and three-way merge

**Files:**
- Create: `internal/notes/merge.go`
- Test: `internal/notes/merge_test.go`

**Interfaces:**
- Produces:
  - `func Normalize(s string) string`
  - `func Merge(base *string, ours, theirs, theirsLabel string) string` — operates on `Normalize`d inputs; `base == nil` means "no base": use the longest common subsequence of `ours`/`theirs` lines as the base. Ours is always labelled `notes`.

- [ ] **Step 1: Write failing tests** (table-driven `TestMerge`, plus `TestNormalize`):
  - Normalize: `"  a  \r\nb\t\n\n\n"` → `"a\nb"`; `"a\n\n  b"` keeps interior `"a\n\n  b"`.
  - base `"a\nb\nc"`, ours `"a\nX\nb\nc"`, theirs `"a\nb\nc\nY"` → `"a\nX\nb\nc\nY"` (clean).
  - base `"a\nb\nc"`, ours `"a\nB1\nc"`, theirs `"a\nB2\nc"`, label `cmux` → `"a\n<<<<<<< notes\nB1\n=======\nB2\n>>>>>>> cmux\nc"`.
  - both sides made the same change → that change, no markers.
  - no base, ours `"a\nb"`, theirs `"a\nx\nb"` → `"a\nx\nb"` (containment → longer).
  - no base, ours `"p\nq"`, theirs `"r"` → one conflict block holding both.
  - no base, one side empty → the other side.
  - idempotence: `Merge(&m, m, m, "cmux") == m` for a result `m` that contains markers.
- [ ] **Step 2: Run** `go test ./internal/notes/ -run 'TestMerge|TestNormalize'` — FAIL.
- [ ] **Step 3: Implement.** Hand-rolled diff3 over lines: LCS-match base↔ours and base↔theirs; walk the base, emitting stable runs where both sides match base, and for each unstable region: if ours==base region take theirs; if theirs==base take ours; if ours==theirs take one; else a conflict block. No dependency.
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** `feat(notes): line-based three-way merge with conflict markers`.

### Task 3: Direction table

**Files:**
- Create: `internal/notes/decide.go`
- Test: `internal/notes/decide_test.go`

**Interfaces:**
- Consumes: `Normalize`, `Merge` (Task 2).
- Produces:
  ```go
  type ActionKind int
  const ( ActNone ActionKind = iota; ActPush; ActPull; ActMerge )
  type Action struct { Kind ActionKind; Text string } // Text: what both sides must hold afterwards
  func Decide(notes, cmuxDesc string, base *string, baseWorkspace, workspaceID string) Action
  ```

- [ ] **Step 1: Write failing table test `TestDecide`** covering, with `Text` asserted:
  - all equal → `ActNone`.
  - notes changed, cmux == base → `ActPush`, Text = notes.
  - cmux changed, notes == base → `ActPull`, Text = cmux.
  - both changed → `ActMerge`, Text = `Merge(base, notes, cmux, "cmux")`.
  - cmux differs from base only by cmux's trimming (`base "a\n"`, cmux `"a"`) → `ActNone`.
  - cmux empty, notes non-empty, base == notes → `ActPush` (never pull empty).
  - cmux empty, notes non-empty, base == "" → `ActPush`.
  - notes empty and cmux empty → `ActNone`.
  - base nil, notes "" and cmux "c" → `ActPull` "c"; base nil, notes "n", cmux "" → `ActPush` "n".
  - base set but `baseWorkspace != workspaceID` → treated as base nil (both non-empty, different → `ActMerge` with nil base).
  - base nil and notes == cmux (normalised) → `ActNone`.
- [ ] **Step 2: Run** `go test ./internal/notes/ -run TestDecide` — FAIL.
- [ ] **Step 3: Implement** per the spec's table; the empty-cmux rule is checked first.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(notes): direction table for two-way cmux sync`.

### Task 4: Per-worktree sync on the server

**Files:**
- Modify: `internal/cmux/cmux.go` (`Workspace` gains `Description *string \`json:"description"\``, plus `func (w Workspace) DescriptionText() string` returning "" for nil)
- Create: `internal/webui/notes_sync.go`
- Modify: `internal/webui/server.go` (field `notesMu sync.Map // path → *sync.Mutex`)
- Test: `internal/webui/notes_sync_test.go`

**Interfaces:**
- Consumes: Task 1 store, `notes.Decide`.
- Produces:
  - `func (s *Server) notesLock(path string) func()` — locks and returns the unlock.
  - `func (s *Server) syncNotesLocked(path string, listed *cmux.Workspace) (outcome, errMsg string)` — caller holds `notesLock(path)`. `listed` is the workspace from a listing taken earlier, or nil to list now. Returns the existing `cmuxSyncOff/OK/Skipped/Failed` constants (keep them in `worktree_notes_api.go`).
  - `func (s *Server) setCmuxDescription(id, text string) error` — the `cmuxSetDescription` seam or `cmux.SetWorkspaceDescription`.

Behaviour of `syncNotesLocked`: read row; sync off → `off`. Resolve the workspace (list now if `listed == nil`; exactly one match by `cmux.Match`, else `skipped`). `a := notes.Decide(...)`. If `a.Kind` is Pull or Merge and the workspace came from `listed`, list again, re-find by ID (gone → `skipped`) and recompute. Then: if notes text ≠ `a.Text`, `CompareAndSet` text (keep sync/home, keep old base); on version mismatch re-read and restart once more (max 3 tries, then `failed`). If the description ≠ `a.Text` (normalised), push; on push error return `failed` WITHOUT touching the base. Finally `SetBase(…, &a.Text, ws.ID)` at the version just written. `ActNone` with a base that is nil or for another workspace also records the base.

- [ ] **Step 1: Write failing tests** (parallel, using a helper like `notesServer` from `worktree_notes_api_test.go` with a mutable listing):
  - `TestSyncNotesPullsCmuxEdit`: base "a", notes "a", cmux "a\nb" → notes become "a\nb", no push, base "a\nb".
  - `TestSyncNotesPushesNotesEdit`: base "a", notes "a\nn", cmux "a" → push "a\nn" by workspace ID.
  - `TestSyncNotesMergesBoth`: both changed different lines → both sides hold the clean merge.
  - `TestSyncNotesRelistsBeforePull`: `listed` says cmux "old"; the seam's fresh listing says cmux == base → no pull, notes unchanged.
  - `TestSyncNotesNewWorkspaceDoesNotWipe`: base "n" for workspace "W1"; listed workspace "W2" with empty description → push "n", notes kept.
- [ ] **Step 2: Run** `go test ./internal/webui/ -run TestSyncNotes` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test ./internal/webui/ -run TestSyncNotes` and `go test ./internal/cmux/` — PASS.
- [ ] **Step 5: Commit** `feat(webui): per-worktree two-way notes sync`.

### Task 5: Description step in the 5 s cmux pass

**Files:**
- Modify: `internal/webui/cmux_unread.go`
- Test: `internal/webui/cmux_unread_test.go` (or a new `cmux_pass_test.go`)

**Interfaces:**
- Consumes: `notesLock`, `syncNotesLocked` (Task 4).
- Produces: `cmuxUnreadPass` lists once and runs two steps on the same listing: `s.applyUnreadPrefixes(workspaces []cmux.Workspace, matches map[string][]cmux.Workspace, want func(string) (bool, bool))` (today's body after the listing, still under `cmuxTitleMu`) and `s.syncDescriptions(matches map[string][]cmux.Workspace)`, which for each path with exactly one match takes `notesLock(path)` and calls `syncNotesLocked(path, &ws)`. `cmuxUnreadStrip` keeps working (it lists for itself and calls `applyUnreadPrefixes`). `StartCmuxUnreadSync`'s name and the 5 s interval in `cmd/ui.go` stay.

- [ ] **Step 1: Write failing tests:**
  - `TestCmuxPassPullsDescription`: sync on, base "a", cmux "a\nb" → after one `cmuxUnreadPass`, notes == "a\nb".
  - `TestCmuxPassSettledAfterMerge` (Review Focus 2): a pass that merges, then a second pass with the listing updated to the pushed text → no push, no notes write (version unchanged).
  - `TestCmuxPassRetriesFailedPush` (Review Focus 3): push fails once → base unchanged; next pass (push succeeds) pushes the same text, notes contain no markers.
  - `TestCmuxPassSaveBetweenListAndLock` (Review Focus 1): the first listing returns stale cmux "a"; before the pass reaches the lock a save pushes "a\nn" (simulate by having the list seam's first call return the stale listing and subsequent calls the fresh one, with notes/base already at "a\nn") → notes stay "a\nn".
  - Existing `TestCmuxUnreadSync*` still pass.
- [ ] **Step 2: Run** `go test ./internal/webui/ -run 'TestCmux(Pass|UnreadSync)'` — new ones FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `go test -race ./internal/webui/ -run 'TestCmux|TestSyncNotes'` — PASS.
- [ ] **Step 5: Commit** `feat(webui): pull cmux description edits in the 5s cmux pass`.

### Task 6: Notes save merges and syncs

**Files:**
- Modify: `internal/webui/worktree_notes_api.go` (delete `syncNotesToCmux`)
- Test: `internal/webui/worktree_notes_api_test.go`
- Modify: `ui/src/api/types.ts` (request gains `base_notes?: string`)

**Interfaces:**
- Consumes: Task 1 store, `notes.Merge`, `notesLock`, `syncNotesLocked`.
- Produces: `setWorktreeNotesRequest` gains `BaseNotes *string \`json:"base_notes,omitempty"\``. Response shape unchanged (its `notes` is what was stored, possibly merged).

Handler under `notesLock(path)`: read row; `text := req.Notes`; if `BaseNotes != nil` and `Normalize(row.Text) != Normalize(*BaseNotes)` then `text = notes.Merge(BaseNotes, req.Notes, row.Text, "other edit")`. Absent `BaseNotes` overwrites (old tabs). Base: kept when sync stays on; set to nil when `req.SyncCmux` is false. `CompareAndSet` at the read version, retrying the read+merge on mismatch (max 3). Then, if sync is on, `syncNotesLocked(path, nil)` for `cmux_sync`. `show_on_home` absent still keeps the stored value.

- [ ] **Step 1: Write failing tests:**
  - `TestWorktreeNotesSaveMergesConcurrentEdit`: stored "a\nb" (written after the client loaded "a"); POST notes "a\nc", base_notes "a" → stored text is the clean merge containing b and c, no markers.
  - `TestWorktreeNotesSaveWithoutBaseOverwrites`: stored "x"; POST notes "y" with no base_notes → "y".
  - `TestWorktreeNotesSyncOffClearsBase`: base set; POST sync_cmux false → `CmuxBase == nil`, no cmux call.
  - `TestWorktreeNotesResyncKeepsBoth` (Review Focus 5): sync off; notes "n", cmux "c"; POST sync_cmux true → both sides hold a conflict block with "n" and "c".
  - Update existing `TestWorktreeNotesSyncsToTheOneWorkspaceByID` etc. to the new flow; they must still pass.
- [ ] **Step 2: Run** `go test ./internal/webui/ -run TestWorktreeNotes` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same — PASS.
- [ ] **Step 5: Commit** `feat(webui): notes saves merge concurrent edits and sync both ways`.

### Task 7: `notes_changed` on the live stream

**Files:**
- Modify: `internal/notes/notes.go` (`func Fingerprint(conn *sql.DB) (string, error)` — e.g. `COUNT(*)` and `SUM(version)`)
- Modify: `internal/webui/stream.go` (seed before the loop; on each tick, if changed, `event: notes_changed\ndata: {}`)
- Modify: `ui/src/hooks/useSSE.ts` (listener invalidates `["worktree-notes"]` and `["worktrees"]`)
- Test: `internal/notes/notes_test.go` (`TestFingerprintChangesOnEveryWrite`: changes after CAS and after `Set`, not after `SetBase`), `ui/src/hooks/useSSE.test.tsx` (event invalidates both keys, following the file's existing pattern)

- [ ] **Step 1: Write the failing tests above.**
- [ ] **Step 2: Run** `go test ./internal/notes/ -run TestFingerprint` and `cd ui && npx vitest run src/hooks/useSSE.test.tsx` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both — PASS.
- [ ] **Step 5: Commit** `feat: notes_changed stream event`.

### Task 8: Notes hook adopts server text and sends its base

**Files:**
- Modify: `ui/src/hooks/useWorktreeNotes.ts`
- Test: `ui/src/hooks/useWorktreeNotes.test.ts(x)` (create if absent)

**Interfaces:**
- Consumes: `base_notes` (Task 6), `notes_changed` refetch (Task 7).
- Produces: the hook's public return shape is unchanged.

Rules: keep a `base` ref = the server text the draft descends from (set on every adoption). Every save sends `base_notes: base`. On a save response: if `res.notes !== snap.notes` and no newer keystrokes (`same(latest, snap)`), adopt `res.notes` into the draft and set `base = res.notes`; otherwise set `base = snap.notes` and let the follow-up save merge. A refetch adopts server text only while the draft is clean (existing `updated_at` check kept). The keepalive save also sends `base_notes`.

- [ ] **Step 1: Write failing tests** (mock `api.saveWorktreeNotes` / `api.worktreeNotes`):
  - first save sends `base_notes` equal to the loaded text.
  - a response with merged text and no further typing replaces `notes`.
  - typing during the in-flight save: the follow-up save sends the latest draft with `base_notes` equal to the text of the first save, and the draft is not overwritten by the first response.
- [ ] **Step 2: Run** `cd ui && npx vitest run src/hooks/useWorktreeNotes` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(ui): notes hook merges with server edits instead of overwriting`.

### Task 9: Render conflict markers literally

**Files:**
- Create: `ui/src/lib/conflictMarkers.ts`
- Modify: `ui/src/components/NotesMarkdown.tsx`
- Test: `ui/src/lib/conflictMarkers.test.ts`, `ui/src/components/NotesMarkdown.test.tsx`

**Interfaces:**
- Produces: `export function hasConflictMarkers(text: string): boolean` (true only for an in-order `<<<<<<< `…`=======`…`>>>>>>> ` triple outside fenced code) and `export function literalConflictMarkers(text: string): string` (each such marker line, outside fences, becomes `` `<line>` `` with a blank line before and after).

`NotesMarkdown`: when `hasConflictMarkers(text)`, render `literalConflictMarkers(text)` and treat as not clickable (`onToggleTask` ignored).

- [ ] **Step 1: Write failing tests:**
  - `literalConflictMarkers("a\n<<<<<<< notes\nx\n=======\ny\n>>>>>>> cmux\nb")` → `"a\n\n`<<<<<<< notes`\n\nx\n\n`=======`\n\ny\n\n`>>>>>>> cmux`\n\nb"`.
  - markers inside a ``` fence are untouched and `hasConflictMarkers` is false for them.
  - Review Focus 4: `hasConflictMarkers("Title\n=======\n- [ ] t")` is false; rendered task checkbox remains clickable (NotesMarkdown test).
  - NotesMarkdown with a conflict and `onToggleTask` renders a disabled checkbox and shows `=======` as text, not an `<h1>`.
- [ ] **Step 2: Run** `cd ui && npx vitest run src/lib/conflictMarkers src/components/NotesMarkdown` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(ui): show conflict markers literally in rendered notes`.

### Task 10: Copy, CLI help and docs; full verification

**Files:**
- Modify: `ui/src/components/WorktreeDetailCard.tsx:356` (label `Sync with cmux workspace description`)
- Modify: `cmd/notes.go` (`set` help: "updated by the web UI on its next save" → "on its next sync pass"; "sync to cmux" → "sync with cmux")
- Modify: `docs/web-ui-architecture.md` "Worktree notes" (replace the one-way "cmux description sync" bullet with the two-way behaviour: base + workspace UUID, direction table, empty-description rule, merge + markers, 5 s pass, `notes_changed`, rendering)
- Modify: `internal/agentskill/SKILL.md` only if its notes lines mention one-way sync

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Run** `make test` and `cd ui && npm test && npx tsc -b` — all PASS.
- [ ] **Step 3: Run** `make build` — succeeds.
- [ ] **Step 4: Commit** `docs: two-way cmux notes sync`.
