# Phase 6 — agent-handler: Slack as a first-class watched resource type — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Slack a first-class watched resource type in agent-handler
(alongside github/jira): the scheduled poller installs/runs Slack, and watched
Slack threads' new replies flow into session inboxes via the existing
type-agnostic routing.

**Architecture:** Flip Slack on across the watcher seams Phase 5 left labeled
and excluded — `knownWatchers`, `defaultIntervals`, the `run.go` poll dispatch,
and the `config` service-mapping helpers — plus one small Slack archive-permalink
builder. No watcher-library change (v0.4.3 already ships `slack.Poll` +
`SlackAuth` + `config.Slack()`), no DB schema change, no inbox/routing change.

**Tech Stack:** Go, cobra, watcher library v0.4.3 (already pinned),
`github.com/mturley/watcher/slack` (`wslack`).

**Spec:** `docs/superpowers/specs/2026-08-21-phase6-handler-slack-watched-type-design.md`
(worktree repo). Executed against **agent-handler** at `~/git/agent-ledger`.

## Global Constraints

- **Repo:** all work in `~/git/agent-ledger` (module
  `github.com/mturley/agent-handler`). No worktree-repo or watcher-repo change.
- **No watcher-library change, no `go get`/re-pin, no DB schema migration.**
- **Slack poll interval = 5 * time.Minute** (matches Jira).
- **Slack archive permalink format:** `https://<WorkspaceDomain>/archives/<channel>/p<ts-digits>`,
  `<ts-digits>` = thread ts with `.` removed. Return `""` when WorkspaceDomain
  unset. Tolerate a stored WorkspaceDomain that includes a scheme / trailing slash.
- **Import alias:** the library slack package is imported as `wslack
  "github.com/mturley/watcher/slack"` (mirrors `wgithub`/`wjira`).
- **No new fake-network test harness for run.go** — github/jira poll dispatch is
  not unit-tested there (needs live DB+network); slack matches that convention
  and is covered by manual smoke.
- Run tests with `go test ./...` from repo root.
- Build/install gotcha (finish/verify time only): before any build/install that
  replaces the running handler binary, confirm with Mike and kill the running
  handler UI server first, then restart.

---

## File Structure

- `config/config.go` — `ResourceTypeToService`, `IsServiceConfigured`,
  `DefaultResourceURL` + new `slackResourceURL` helper.
- `config/config_test.go` — extend `TestDefaultResourceURL`; add slack mapping tests.
- `cmd/watcher/watcher.go` — `knownWatchers` gains `"slack"`.
- `cmd/watcher/run.go` — poll-dispatch `case "slack"` + `serviceToResourceType`.
- `cmd/watcher/install.go` — `defaultIntervals["slack"]`, `installAll` Slack auth,
  stale-comment updates.
- `cmd/watcher/watcher_test.go` (new) — pure-function tests (`knownWatchers`,
  `serviceToResourceType`).

---

## Task 1: config service mapping for slack + archive-permalink builder

> **RECON CORRECTION (verified in repo):** handler's `config.Config` (legacy
> `~/.agent-handler/config.yaml`) has NO Slack field — its `Services` struct is
> `{GitHub, Jira}` only. Slack creds + `WorkspaceDomain` live in the SHARED
> `auth.yaml` (`github.com/mturley/watcher/config`, aliased `wcfg`). Therefore:
> (1) do NOT add a slack branch to handler's `config.IsServiceConfigured`
> (it's the legacy method and cannot read a nonexistent field; the real
> "configured for watching?" check is `ServiceConfiguredForWatching("slack")`
> which ALREADY handles slack via `wcfg` — no change needed there); (2) the
> slack permalink builder must load `WorkspaceDomain` from `wcfg`, NOT from
> `c.Services`. `config/service_configured.go` already imports `wcfg` in this
> package, so there is no import cycle.

**Files:**
- Modify: `config/config.go` (`ResourceTypeToService`, `DefaultResourceURL`;
  add `slackResourceURL`; import `wcfg`)
- Test: `config/config_test.go` (add `TestDefaultResourceURL_Slack`,
  `TestResourceTypeToService_Slack`)

**Interfaces:**
- Produces: `ResourceTypeToService("slack") == "slack"`;
  `(*Config).DefaultResourceURL("slack", "<channel>:<ts>")` → archive permalink
  from the shared auth.yaml's WorkspaceDomain, or `""`.
- Consumes: `wcfg.Load(wcfg.DefaultPath()).Slack()` →
  `wcfg.SlackCreds{Token, Cookie, WorkspaceDomain}`.

- [ ] **Step 1: Write the failing tests**

The permalink builder reads `WorkspaceDomain` from the shared auth.yaml via
`wcfg`. To test hermetically, point `WATCHER_HOME` at a temp dir and write an
auth.yaml with a Slack section using the library's own `config.Config.Save`
(the same approach `cmd/migrate_watcher_test.go`'s `isolateHomes` uses).
Read `config/config_test.go`'s existing `TestDefaultResourceURL` (line ~101)
for style. Add:

```go
func TestDefaultResourceURL_Slack(t *testing.T) {
	// Point the shared watcher auth.yaml at a temp home and seed a Slack domain.
	t.Setenv("WATCHER_HOME", t.TempDir())
	seed := &wcfg.Config{Services: wcfg.Services{Slack: &wcfg.SlackConfig{
		Token: "xoxc-x", Cookie: "d", WorkspaceDomain: "myteam.slack.com",
	}}}
	if err := seed.Save(wcfg.DefaultPath()); err != nil {
		t.Fatalf("seed auth.yaml: %v", err)
	}

	c := &Config{} // handler config; slack URL is sourced from wcfg, not c
	want := "https://myteam.slack.com/archives/C0123ABCD/p1699999999000100"
	if got := c.DefaultResourceURL("slack", "C0123ABCD:1699999999.000100"); got != want {
		t.Errorf("got %q want %q", got, want)
	}

	// malformed id -> ""
	if got := c.DefaultResourceURL("slack", "nocolon"); got != "" {
		t.Errorf("malformed: got %q want \"\"", got)
	}
}

func TestDefaultResourceURL_Slack_SchemeTolerated(t *testing.T) {
	t.Setenv("WATCHER_HOME", t.TempDir())
	seed := &wcfg.Config{Services: wcfg.Services{Slack: &wcfg.SlackConfig{
		Token: "x", Cookie: "d", WorkspaceDomain: "https://myteam.slack.com/",
	}}}
	if err := seed.Save(wcfg.DefaultPath()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	c := &Config{}
	want := "https://myteam.slack.com/archives/C0123ABCD/p1699999999000100"
	if got := c.DefaultResourceURL("slack", "C0123ABCD:1699999999.000100"); got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestDefaultResourceURL_Slack_NoDomain(t *testing.T) {
	t.Setenv("WATCHER_HOME", t.TempDir()) // empty auth.yaml -> no slack -> ""
	c := &Config{}
	if got := c.DefaultResourceURL("slack", "C0:1699999999.000100"); got != "" {
		t.Errorf("no domain: got %q want \"\"", got)
	}
}

func TestResourceTypeToService_Slack(t *testing.T) {
	if got := ResourceTypeToService("slack"); got != "slack" {
		t.Errorf("got %q want slack", got)
	}
}
```

> Add the import `wcfg "github.com/mturley/watcher/config"` to config_test.go.
> Confirm `wcfg.Services`/`wcfg.SlackConfig` field names against the pinned
> v0.4.3 (recon: `SlackConfig{Token, Cookie, WorkspaceDomain}`,
> `Services.Slack *SlackConfig`). Confirm `wcfg.DefaultPath()` honors
> `WATCHER_HOME` (recon: it does). Do NOT add an IsServiceConfigured slack test —
> that method is legacy and unchanged (see the recon correction above).

- [ ] **Step 2: Run to verify fail**

Run: `go test ./config/... -run 'Slack' -v`
Expected: FAIL (slack cases return "" / wrong mapping).

- [ ] **Step 3: Implement**

In `config/config.go`:

Add the import `wcfg "github.com/mturley/watcher/config"` (already imported in
`config/service_configured.go` in this package — no cycle).

`ResourceTypeToService` — add before `default`:
```go
	case "slack":
		return "slack"
```

`DefaultResourceURL` — add before `default`:
```go
	case "slack":
		return slackResourceURL(resourceID)
```

Do NOT touch `IsServiceConfigured` (legacy; no Slack field — see recon
correction). Add the helper (near the other URL helpers, e.g. `prResourceURL`):
```go
// slackResourceURL builds a Slack archive permalink from a "<channel>:<ts>"
// resource ID and the WorkspaceDomain in the shared watcher auth.yaml (the
// source of truth for Slack config — handler's own config has no Slack
// section). Returns "" if the domain is unset/unreadable or the ID is
// malformed.
func slackResourceURL(resourceID string) string {
	parts := strings.SplitN(resourceID, ":", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return ""
	}
	sc, err := wcfg.Load(wcfg.DefaultPath())
	if err != nil {
		return ""
	}
	creds, err := sc.Slack()
	if err != nil || creds.WorkspaceDomain == "" {
		return ""
	}
	// Tolerate a stored domain with a scheme and/or trailing slash.
	domain := strings.TrimPrefix(creds.WorkspaceDomain, "https://")
	domain = strings.TrimPrefix(domain, "http://")
	domain = strings.TrimRight(domain, "/")

	channel, ts := parts[0], parts[1]
	tsDigits := strings.ReplaceAll(ts, ".", "")
	return "https://" + domain + "/archives/" + channel + "/p" + tsDigits
}
```
(`strings` is already imported in config.go.)

> Note: this reads auth.yaml per call; `DefaultResourceURL` is called in loops
> (autosubscribe, statusline) but only for a handful of resources on a
> localhost single-user tool, so a per-call read is acceptable (the jira branch
> already does per-call config work). If it ever matters, cache — out of scope
> here.

- [ ] **Step 4: Run to verify pass**

Run: `go test ./config/... -run 'Slack' -v && go build ./...`
Expected: PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add config/config.go config/config_test.go
git commit --signoff -m "feat(config): map slack resource type + build Slack archive permalink"
```

---

## Task 2: enable the slack poller (knownWatchers, run dispatch, install interval)

**Files:**
- Modify: `cmd/watcher/watcher.go` (`knownWatchers`)
- Modify: `cmd/watcher/run.go` (poll dispatch `case "slack"`, `serviceToResourceType`)
- Modify: `cmd/watcher/install.go` (`defaultIntervals`, `installAll` slack auth,
  stale comments)
- Test: `cmd/watcher/watcher_test.go` (new)

**Interfaces:**
- Consumes: `wslack "github.com/mturley/watcher/slack"` (`SlackAuth`, `Poll`);
  `creds.Slack()` (`wcfg.SlackCreds{Token,Cookie,WorkspaceDomain}`);
  `credsetup.Slack`.
- Produces: `knownWatchers` includes `"slack"`; `serviceToResourceType("slack")
  == "slack"`; `handler watcher run slack` dispatches to `wslack.Poll`.

- [ ] **Step 1: Write the failing test**

Create `cmd/watcher/watcher_test.go`:
```go
package watcher

import "testing"

func TestKnownWatchersIncludesSlack(t *testing.T) {
	found := false
	for _, w := range knownWatchers {
		if w == "slack" {
			found = true
		}
	}
	if !found {
		t.Errorf("knownWatchers missing slack: %v", knownWatchers)
	}
}

func TestServiceToResourceType_Slack(t *testing.T) {
	if got := serviceToResourceType("slack"); got != "slack" {
		t.Errorf("got %q want slack", got)
	}
}
```
> Confirm the package name of `cmd/watcher/*.go` by reading a file there (it may
> be `package watcher`). Match it.

- [ ] **Step 2: Run to verify fail**

Run: `go test ./cmd/watcher/... -v`
Expected: FAIL (slack not in knownWatchers; serviceToResourceType returns "").

- [ ] **Step 3a: knownWatchers**

`cmd/watcher/watcher.go`: `var knownWatchers = []string{"github", "jira"}` →
`{"github", "jira", "slack"}`. Update the doc comment above it (drop "slack
excluded" wording if present).

- [ ] **Step 3b: run.go dispatch + serviceToResourceType**

`cmd/watcher/run.go`:
- Add import `wslack "github.com/mturley/watcher/slack"` (alongside
  `wgithub`/`wjira`).
- In the `switch name` poll dispatch, add before `default`:
```go
	case "slack":
		sc, err := creds.Slack()
		if err != nil {
			return fmt.Errorf("slack credentials not available: %w", err)
		}
		auth := wslack.SlackAuth{
			Token:           sc.Token,
			Cookie:          sc.Cookie,
			WorkspaceDomain: sc.WorkspaceDomain,
		}
		return wslack.Poll(d.Conn(), auth, resources, logger)
```
- In `serviceToResourceType`, add before `default`:
```go
	case "slack":
		return "slack"
```

- [ ] **Step 3c: install.go interval + auth + comments**

`cmd/watcher/install.go`:
- `defaultIntervals` map: add `"slack": 5 * time.Minute,`.
- In `installAll`, after the jira `TestAndRepair` and before the save guard, add:
```go
	slackChanged, _ := credsetup.TestAndRepair(cfg, credsetup.Slack, prompter)
```
  and change the save guard to include it:
```go
	if ghChanged || jiraChanged || slackChanged {
```
- Update the stale comments in this file (the block comment ~lines 15-25 that
  says Slack is "deliberately NOT in knownWatchers/defaultIntervals" / "handler
  has no Slack poller yet", the `installAll` scope comment ~lines 67-70 "Scoped
  to github+jira only", and the `defaultIntervals` comment "covers only ...
  github, jira. Slack is intentionally excluded") to reflect that Slack is now a
  first-class watcher.

- [ ] **Step 4: Run to verify pass**

Run: `go test ./cmd/watcher/... -v && go build ./... && go vet ./...`
Expected: PASS + clean build + clean vet.

- [ ] **Step 5: Commit**

```bash
git add cmd/watcher/watcher.go cmd/watcher/run.go cmd/watcher/install.go cmd/watcher/watcher_test.go
git commit --signoff -m "feat(watcher): make slack a first-class handler watcher (install/run/poll)"
```

---

## Task 3: full-suite verification + CLI sanity

**Files:** none (verification task).

- [ ] **Step 1: Full suite**

Run: `go test ./...`
Expected: PASS (all packages).

- [ ] **Step 2: Grep for residual "slack excluded" claims**

Run: `grep -rn -i "slack.*excluded\|no slack poller\|slack.*not in knownWatchers\|slack.*later phase" --include="*.go" .`
Expected: no matches (all such comments updated in Task 2).

- [ ] **Step 3: CLI sanity**

Run: `go run . watcher list 2>&1 | grep -i slack` and
`go run . watcher install --help`.
Expected: slack appears among known watchers (list output). No panic.

- [ ] **Step 4: Ledger the manual smoke item (not run here)**

Record: with Slack configured in auth.yaml + a watched thread,
`handler watcher install slack` (5m), `handler watcher run slack --resources
<channel>:<ts>` emits a slack_reply event into the inbox; a worktree primary
slack resource auto-watches on registration. Requires building/installing
handler (kill+restart the running UI server first, with Mike's OK).

---

## Self-Review

**Spec coverage:**
- Slack interval 5m → Task 2 (`defaultIntervals`). ✅
- Archive-permalink `DefaultResourceURL` → Task 1 (`slackResourceURL`). ✅
- `ResourceTypeToService`/`serviceToResourceType` slack → Tasks 1 & 2. ✅
  (`IsServiceConfigured` intentionally NOT changed — legacy method, no Slack
  field; `ServiceConfiguredForWatching` already handles slack via wcfg.)
- `knownWatchers` + run dispatch + install auth → Task 2. ✅
- Registration auto-subscribe (no code change) → covered by Task 1 mapping. ✅
- Stale-comment cleanup → Task 2 Step 3c + Task 3 grep. ✅
- No lib/schema change → whole plan (Global Constraints). ✅
- Inbox routing unchanged (type-agnostic) → no task needed; noted. ✅

**Type consistency:** `slackResourceURL(c *Config, resourceID string) string`
consistent; `wslack.SlackAuth{Token,Cookie,WorkspaceDomain}` matches the pinned
v0.4.3 struct; `creds.Slack()` returns `SlackCreds{Token,Cookie,WorkspaceDomain}`
(verified in recon). `serviceToResourceType`/`ResourceTypeToService` both return
`"slack"` for the slack case.

**Placeholder scan:** Task 1 Step 1 flags the one thing the implementer must
verify against the repo (the exact element type of `config.Services.Slack` —
handler's `config` may re-export the library's `SlackConfig`); this is a
read-and-confirm, not a gap. All code steps contain full code.
