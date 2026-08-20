# Shared Credential Test + Repair — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shared, library-owned "test the credential; if bad/missing, help set up + validate + save" flow for GitHub, Jira, and Slack (creds in `~/.config/watcher/auth.yaml`), consumed by both `worktree setup` and agent-handler's setup.

**Architecture:** Three layers. (1) Pure per-service `Validate()` + `ErrAuth` in the watcher library's `github`/`jira`/`slack` packages. (2) A new `watcher/credsetup` package with a `Prompter` interface + `TestAndRepair(cfg, service, prompter)` loop (the only prompting-shaped code; core stays pure). (3) Consumers implement `Prompter` over their own UX and call `TestAndRepair` for all three services, then `cfg.Save` once. Released as watcher v0.4.0; both consumers re-pin.

**Tech Stack:** Go (watcher library + worktree + agent-handler). Stdlib HTTP for validators.

**Spec:** `docs/superpowers/specs/2026-08-20-shared-credential-test-repair-design.md`

## Global Constraints

- **3 repos:** `~/git/watcher` (library), `~/git/worktree`, `~/git/agent-ledger` (module `github.com/mturley/agent-handler`).
- **CONCURRENCY WARNING:** another session is actively working on a GitHub-watcher bug in `~/git/watcher` (uncommitted changes + unrelated commits may be present). Do ALL library work for this plan in an **isolated git worktree of the watcher repo** (`git -C ~/git/watcher worktree add ...`), branch off a known-clean commit, and NEVER build/tag from `~/git/watcher`'s main working tree. Verify the committed tree in isolation before tagging (the v0.2.6 lesson). Coordinate the tag: do not assume `~/git/watcher` HEAD is clean.
- **Core packages stay pure:** `config`, `github`, `jira`, `slack` get `Validate()`/`ErrAuth` only — NO prompts, NO stdin, NO config→service import (no cycles). All prompting lives in `credsetup` behind the `Prompter` interface.
- **`credsetup.TestAndRepair` mutates cfg but does NOT save** — caller saves once via `cfg.Save(config.DefaultPath())`.
- **One retry then give up** in the repair loop (no infinite loops) — matches existing flows.
- **Transport (non-ErrAuth) errors do NOT trigger a token prompt** (creds may be fine, network down) — surface the error.
- **Slack browser-token extraction stays consumer-side** (behind `PromptSlack`); credsetup only validates + resolves domain (`TeamInfo`) + saves.
- **`ErrAuth` sentinels:** slack already has `slack.ErrAuth`; add `github.ErrAuth` + `jira.ErrAuth`. `Validate` returns a wrapped `ErrAuth` on 401/403/invalid-auth, a plain error on transport/other.
- Release: watcher **v0.4.0** (additive minor). Handler re-pins v0.2.6→v0.4.0 (verified non-breaking: config change is additive Slack fields handler doesn't use; db change is additive resourcemeta table + schema bump 2→3).

---

## STAGE A — watcher library (in an isolated watcher worktree)

### Task A0: Create an isolated watcher worktree for this work

**Repo:** `~/git/watcher`.

- [ ] **Step 1: Pick a clean base + create the worktree**

Because another session may have `~/git/watcher` dirty, base off the pushed `v0.3.0` tag (known-clean) rather than main HEAD, UNLESS the coordinating human says main is clean and ahead. Default:
```bash
git -C ~/git/watcher worktree add -b credsetup ~/git/watcher-credsetup v0.3.0
cd ~/git/watcher-credsetup && go build ./... && go test ./...
```
Expected: builds + tests green on a clean v0.3.0 base. All Stage-A tasks run in `~/git/watcher-credsetup`.

NOTE: if the human confirms `~/git/watcher` main is clean and carries wanted commits beyond v0.3.0 (e.g. the concurrent github-bug fix already merged), base off `origin/main` instead: `git -C ~/git/watcher worktree add -b credsetup ~/git/watcher-credsetup origin/main`. Ask if unsure — do not guess against a dirty tree.

- [ ] **Step 2: Ledger the base commit**

Record the exact base SHA in the SDD ledger so the release tag's provenance is clear.

---

### Task A1: `github.Validate` + `github.ErrAuth`

**Repo:** `~/git/watcher-credsetup`. **Files:** `github/validate.go` (create), `github/validate_test.go` (create).

**Interfaces:**
- Produces (consumed by credsetup): `var github.ErrAuth = errors.New("github auth failed")`; `func github.Validate(token string) error` — nil if valid; wrapped `ErrAuth` on 401/unauthorized; plain error on transport/other.

- [ ] **Step 1: Write the failing test**

`github/validate_test.go` — use `httptest.NewServer` to stub the GraphQL endpoint; `Validate` must accept an override base URL for testing (add an unexported variadic `apiURL ...string` param mirroring handler's validator, or a package var). Cases: 200 + `{"data":{"viewer":{"login":"x"}}}` → nil; 401 → errors.Is(err, ErrAuth); 500 → non-nil, NOT ErrAuth.
```go
package github

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestValidate(t *testing.T) {
	okSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"viewer":{"login":"me"}}}`))
	}))
	defer okSrv.Close()
	if err := Validate("tok", okSrv.URL); err != nil {
		t.Fatalf("valid: %v", err)
	}
	authSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
	}))
	defer authSrv.Close()
	if err := Validate("bad", authSrv.URL); !errors.Is(err, ErrAuth) {
		t.Fatalf("401: want ErrAuth, got %v", err)
	}
	errSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	}))
	defer errSrv.Close()
	if err := Validate("tok", errSrv.URL); err == nil || errors.Is(err, ErrAuth) {
		t.Fatalf("500: want plain error, got %v", err)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/git/watcher-credsetup && go test ./github/ -run TestValidate -v` → FAIL (undefined Validate/ErrAuth).

- [ ] **Step 3: Implement**

`github/validate.go` — port handler's `ValidateGitHubToken` (`~/git/agent-ledger/config/validate.go:14`): POST `{ "query": "{ viewer { login } }" }` to the GraphQL endpoint (default `https://api.github.com/graphql`, override via variadic), `Authorization: Bearer <token>`, `http.Client{Timeout: 15 * time.Second}` (the library's github client lacks a timeout — give this one an explicit timeout). Map: `resp.StatusCode == 401` → `fmt.Errorf("invalid GitHub token: %w", ErrAuth)`; non-200 → plain `fmt.Errorf("github API status %d", code)`; GraphQL `errors[]` present → plain error; empty login → plain error; else nil.
```go
package github

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

var ErrAuth = errors.New("github auth failed")

func Validate(token string, apiURL ...string) error {
	endpoint := "https://api.github.com/graphql"
	if len(apiURL) > 0 && apiURL[0] != "" {
		endpoint = apiURL[0]
	}
	body, _ := json.Marshal(map[string]string{"query": "{ viewer { login } }"})
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("github validate: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("github validate request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return fmt.Errorf("invalid GitHub token: %w", ErrAuth)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("github API status %d", resp.StatusCode)
	}
	var out struct {
		Data struct{ Viewer struct{ Login string } }
		Errors []struct{ Message string }
	}
	raw, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(raw, &out); err != nil {
		return fmt.Errorf("github validate parse: %w", err)
	}
	if len(out.Errors) > 0 {
		return fmt.Errorf("github GraphQL error: %s", out.Errors[0].Message)
	}
	if out.Data.Viewer.Login == "" {
		return fmt.Errorf("github validate: empty login")
	}
	return nil
}
```

- [ ] **Step 4: Run to verify it passes** — `go test ./github/ -run TestValidate -v` → PASS.

- [ ] **Step 5: Commit** — `git add github/validate.go github/validate_test.go && git commit --signoff -m "github: add Validate(token) + ErrAuth sentinel"`.

---

### Task A2: `jira.Validate` + `jira.ErrAuth`

**Repo:** `~/git/watcher-credsetup`. **Files:** `jira/validate.go` (create), `jira/validate_test.go` (create).

**Interfaces:** Produces `var jira.ErrAuth`; `func jira.Validate(host, email, token string) error`.

- [ ] **Step 1: Write the failing test** — mirror A1's httptest approach, but `Validate` takes `(host, email, token)` and hits `host + "/rest/api/3/myself"`. Cases: 200 `{"displayName":"Me"}` → nil; 401 → ErrAuth; 403 → ErrAuth; 500 → plain error. (host = the test server URL.)

- [ ] **Step 2: Run to verify it fails** — `go test ./jira/ -run TestValidate -v` → FAIL.

- [ ] **Step 3: Implement** — `jira/validate.go`, port handler's `ValidateJiraToken` (`~/git/agent-ledger/config/validate.go:74`): GET `host + "/rest/api/3/myself"`, `req.SetBasicAuth(email, token)`, `Accept: application/json`, `http.Client{Timeout: 15s}`. Map `401 || 403` → `fmt.Errorf("invalid Jira credentials: %w", ErrAuth)`; non-200 → plain error; empty displayName → plain error; else nil. Normalize `host` (trim trailing `/`) — reuse `normalizeBaseURL` if exported/accessible in the jira pkg, else trim inline.
```go
package jira

import ( "encoding/json"; "errors"; "fmt"; "net/http"; "strings"; "time" )

var ErrAuth = errors.New("jira auth failed")

func Validate(host, email, token string) error {
	base := strings.TrimRight(host, "/")
	req, err := http.NewRequest(http.MethodGet, base+"/rest/api/3/myself", nil)
	if err != nil { return fmt.Errorf("jira validate: %w", err) }
	req.SetBasicAuth(email, token)
	req.Header.Set("Accept", "application/json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil { return fmt.Errorf("jira validate request: %w", err) }
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("invalid Jira credentials: %w", ErrAuth)
	}
	if resp.StatusCode != http.StatusOK { return fmt.Errorf("jira API status %d", resp.StatusCode) }
	var out struct{ DisplayName string `json:"displayName"` }
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil { return fmt.Errorf("jira validate parse: %w", err) }
	if out.DisplayName == "" { return fmt.Errorf("jira validate: empty displayName") }
	return nil
}
```

- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add jira/validate.go jira/validate_test.go && git commit --signoff -m "jira: add Validate(host,email,token) + ErrAuth sentinel"`.

---

### Task A3: `slack.Validate` (wrap existing AuthTest)

**Repo:** `~/git/watcher-credsetup`. **Files:** `slack/validate.go` (create), `slack/validate_test.go` (create).

**Interfaces:** Produces `func slack.Validate(token, cookie string) error` — nil if valid; wrapped `slack.ErrAuth` (existing) on bad creds. (Slack already has `ErrAuth`; do NOT add a new one.)

- [ ] **Step 1: Write the failing test** — slack's client uses `NewWithBaseURL(token, cookie, baseURL)`. Stub `auth.test` (or whatever `AuthTest` calls) with httptest: `{"ok":true}` → nil; `{"ok":false,"error":"invalid_auth"}` → errors.Is(err, ErrAuth). READ `slack/client_test.go` first for the existing httptest fixture pattern + how `AuthTest`/`call` map errors, and mirror it. `Validate` must accept a base-URL override for testing (add an unexported variadic or construct via `NewWithBaseURL`).

- [ ] **Step 2: Run to verify it fails** — `go test ./slack/ -run TestValidate -v` → FAIL.

- [ ] **Step 3: Implement** — `slack/validate.go`:
```go
package slack

import "context"

// Validate reports whether the given browser-session credentials are accepted
// by Slack. Returns a wrapped ErrAuth when Slack rejects them.
func Validate(token, cookie string, baseURL ...string) error {
	c := New(token, cookie)
	if len(baseURL) > 0 && baseURL[0] != "" {
		c = NewWithBaseURL(token, cookie, baseURL[0])
	}
	return c.AuthTest(context.Background())
}
```
(Confirm `New`/`NewWithBaseURL` return a type with `AuthTest` — they return `*HTTPClient` which implements it, per recon.)

- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add slack/validate.go slack/validate_test.go && git commit --signoff -m "slack: add Validate(token,cookie) wrapping AuthTest"`.

---

### Task A4: `watcher/credsetup` package (Prompter + TestAndRepair)

**Repo:** `~/git/watcher-credsetup`. **Files:** `credsetup/credsetup.go` (create), `credsetup/credsetup_test.go` (create).

**Interfaces:**
- Consumes: `config.Config` + accessors; `github.Validate`/`jira.Validate`/`slack.Validate` + their `ErrAuth`; `slack` `TeamInfo` for domain.
- Produces: `Service` consts (`GitHub`/`Jira`/`Slack`); `Prompter` interface; `func TestAndRepair(cfg *config.Config, svc Service, p Prompter) (changed bool, err error)`.

- [ ] **Step 1: Write the failing test**

`credsetup/credsetup_test.go` — inject a fake validator table (see Step 3's seam) so no network is needed, and a fake `Prompter`. Cases:
- valid-first-try (fake validator returns nil): no prompt calls, `changed==false`, `err==nil`.
- ErrAuth + Confirm=true + PromptToken returns a token the (fake) revalidate accepts: `changed==true`, `cfg.Services.GitHub.Token` updated.
- ErrAuth + Confirm=false: `changed==false`, cfg unchanged.
- ErrAuth + new token ALSO invalid (fake revalidate returns ErrAuth): one retry then give up, `changed==false`.
- transport error (fake returns a non-ErrAuth error): returned as err, no prompt.
Use a fakePrompter recording calls, and set the internal validator seam to fakes.

- [ ] **Step 2: Run to verify it fails** — `go test ./credsetup/ -v` → FAIL (undefined).

- [ ] **Step 3: Implement**

`credsetup/credsetup.go`:
```go
package credsetup

import (
	"errors"
	"fmt"

	"github.com/mturley/watcher/config"
	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	wslack "github.com/mturley/watcher/slack"
)

type Service string

const (
	GitHub Service = "github"
	Jira   Service = "jira"
	Slack  Service = "slack"
)

type Prompter interface {
	Info(msg string)
	Confirm(msg string) bool
	PromptToken(service Service, instructions string) string
	PromptSlack(instructions string) (token, cookie string)
}

// Test seam: overridable in tests so TestAndRepair needs no network.
var (
	validateGitHub = wgithub.Validate
	validateJira   = wjira.Validate
	validateSlack  = wslack.Validate
	// slackDomain resolves the workspace host for a valid slack cred; returns
	// "" on error (domain is best-effort, not required for validity).
	slackDomain = func(token, cookie string) string {
		d, err := wslack.New(token, cookie).TeamInfo(nil2ctx())
		if err != nil { return "" }
		return d
	}
)

func TestAndRepair(cfg *config.Config, svc Service, p Prompter) (bool, error) {
	switch svc {
	case GitHub:
		return repairGitHub(cfg, p)
	case Jira:
		return repairJira(cfg, p)
	case Slack:
		return repairSlack(cfg, p)
	default:
		return false, fmt.Errorf("unknown service %q", svc)
	}
}
```
Then per-service `repairX` following the uniform flow (shown for GitHub; Jira/Slack analogous):
```go
func repairGitHub(cfg *config.Config, p Prompter) (bool, error) {
	creds, cfgErr := cfg.GitHub() // cfgErr != nil => not configured
	configured := cfgErr == nil
	if configured {
		p.Info("Testing GitHub credentials...")
		err := validateGitHub(creds.Token)
		if err == nil {
			p.Info("GitHub: ok")
			return false, nil
		}
		if !errors.Is(err, wgithub.ErrAuth) {
			return false, err // transport/other: surface, do not prompt
		}
		p.Info("GitHub: failed (" + err.Error() + ")")
		if !p.Confirm("Replace the GitHub token?") {
			return false, nil
		}
	}
	tok := p.PromptToken(GitHub, "Create a token at https://github.com/settings/tokens (needs repo/read scopes)")
	if tok == "" {
		return false, nil
	}
	if err := validateGitHub(tok); err != nil {
		p.Info("GitHub: new token invalid (" + err.Error() + ")")
		return false, nil // one attempt, then give up
	}
	if cfg.Services.GitHub == nil {
		cfg.Services.GitHub = &config.GitHubConfig{}
	}
	cfg.Services.GitHub.Token = tok
	p.Info("GitHub: ok")
	return true, nil
}
```
Slack's `repairSlack` uses `p.PromptSlack(...)` → `validateSlack(token, cookie)` → on success set `cfg.Services.Slack = &config.SlackConfig{Token, Cookie, WorkspaceDomain: slackDomain(token,cookie)}`. Jira: `repairJira` uses `cfg.Jira()` for host/email; if repairing, prompt for a new token (keep existing host/email unless missing — if fully unconfigured, the consumer's PromptToken instructions should cover host/email; KEEP IT SIMPLE: for Jira, prompt only the token and reuse cfg host/email, matching worktree's existing testAndRepairJira which only replaces the token. If host/email are missing entirely, Info an instruction to run the consumer's full Jira config and return false — do not build a multi-field prompt here).
Replace `nil2ctx()` with `context.Background()` (import context) — the placeholder is just to flag: use a real context.

- [ ] **Step 4: Run to verify it passes** — `go test ./credsetup/ -v` → PASS. Then `go test ./...` (whole lib) green.

- [ ] **Step 5: Commit** — `git add credsetup/ && git commit --signoff -m "credsetup: Prompter + TestAndRepair for github/jira/slack"`.

---

### Task A5: Release watcher v0.4.0

**Repo:** `~/git/watcher` (tag from the isolated worktree's committed branch).

- [ ] **Step 1: Coordinate + verify committed tree in isolation**

Because another session may be mid-work in `~/git/watcher`: confirm with the human before tagging. Verify the credsetup branch's committed tree builds+tests green in ITS OWN isolated checkout (it already is `~/git/watcher-credsetup`, a separate worktree — run `go build ./... && go test ./...` there once more on the final commit).

- [ ] **Step 2: Merge the credsetup branch to watcher main + tag**

Coordinate the merge so it doesn't clobber the concurrent github-bug work:
```bash
# from ~/git/watcher (main working tree — only if clean per the human):
git -C ~/git/watcher fetch
git -C ~/git/watcher checkout main
git -C ~/git/watcher merge --no-ff credsetup
git -C ~/git/watcher tag -a v0.4.0 -m "v0.4.0: shared credential validate + credsetup.TestAndRepair"
git -C ~/git/watcher push origin main
git -C ~/git/watcher push origin v0.4.0
```
If main is NOT clean / has unpushed concurrent work, STOP and ask the human how to sequence the merge+tag. Do not force.

- [ ] **Step 3: Confirm tag on remote** — `git -C ~/git/watcher ls-remote --tags origin v0.4.0` prints the ref.

- [ ] **Step 4: Clean up the isolated worktree** — `git -C ~/git/watcher worktree remove ~/git/watcher-credsetup` (after the merge is safely in).

---

## STAGE B — worktree consumer

### Task B1: worktree Prompter + rewire setup to credsetup (github+jira+slack)

**Repo:** `~/git/worktree`. **Files:** `go.mod`/`go.sum` (re-pin); `internal/setup/setup.go` (rewire); `internal/setup/prompter.go` (create — the Prompter impl); `internal/setup/setup_test.go` (extend). Slack extract path (`slack.go`/`extract.*`) stays; it's invoked from the Prompter's `PromptSlack`.

**Interfaces:** Consumes `credsetup.TestAndRepair` + `Prompter`. worktree's Plan gains github/jira/slack test steps that run even when configured.

- [ ] **Step 1: Re-pin** — `cd ~/git/worktree && go get github.com/mturley/watcher@v0.4.0 && go mod tidy`. Verify go.mod shows v0.4.0.

- [ ] **Step 2: Implement the Prompter over `ui`** — `internal/setup/prompter.go`: a type implementing `credsetup.Prompter` using `ui.Confirm`, `ui.PromptSecret`, and a colored `Info` (green ok / red failed / plain). `PromptSlack` calls the EXISTING worktree Slack acquisition (the `extract.mjs` auto path + manual fallback in `internal/setup/slack.go`/`extract.go`) and returns (token, cookie) — factor the existing `promptAndSaveSlack` so its acquisition part is reusable WITHOUT the save (credsetup saves). Write the failing test first: a fake-free unit test is hard for prompts, so test that the Prompter's `Info`/`Confirm` map correctly (thin) and leave the acquisition path to manual smoke.

- [ ] **Step 3: Rewire the setup flow** — replace `testAndRepairJira` + `promptAndSaveSlack` with, for each of github/jira/slack:
```go
changed, err := credsetup.TestAndRepair(&wcfg, credsetup.GitHub, prompter)
```
accumulate `changed`; after all three, if any changed, `wcfg.Save(wconfig.DefaultPath())` once. Load `wcfg` via `wconfig.Load(wconfig.DefaultPath())` (missing → empty Config, per lib). Update the Plan/Preview to always include "Test GitHub/Jira/Slack credentials" steps (run even when configured — this is the requested behavior). Remove the old separate Jira-token-only test path.

- [ ] **Step 4: Build + test** — `go build ./... && go test ./...` green.

- [ ] **Step 5: Commit** — add the specific files; `git commit --signoff -m "setup: use shared credsetup.TestAndRepair for github/jira/slack"`.

---

## STAGE C — agent-handler consumer

### Task C1: handler re-pin + Prompter + rewire (add slack)

**Repo:** `~/git/agent-ledger` (module `github.com/mturley/agent-handler`). **Files:** `go.mod`/`go.sum` (re-pin v0.2.6→v0.4.0); `cmd/watcher/auth.go` (rewire); a new Prompter impl (e.g. `cmd/watcher/prompter.go`); `cmd/watcher/watcher.go`/`install.go`/`config/service_configured.go` (add slack to the hardcoded github/jira lists).

**Interfaces:** Consumes `credsetup.TestAndRepair` + `Prompter`.

- [ ] **Step 1: Re-pin** — `cd ~/git/agent-ledger && go get github.com/mturley/watcher@v0.4.0 && go mod tidy`. Verify go.mod.

- [ ] **Step 2: Verify DB migrates cleanly (schema 2→3)** — run handler's normal startup/migrate path (or its migration test) once against a copy of a v2 DB (or a fresh one) to confirm the additive `watcher_resource_meta` table + version bump apply without error. This is a VERIFY step (no code change expected); if it fails, STOP and report — it means the schema jump needs handling.

- [ ] **Step 3: Implement the Prompter over handler's primitives** — a type implementing `credsetup.Prompter` using handler's `bufio` stdin reads + the `confirm()` helper (`cmd/uninstall.go:389`) + `fmt`/ANSI printing. `PromptToken` reads a secret line; `PromptSlack` prints manual devtools instructions and reads token + cookie (handler has no extract.mjs — manual only for now).

- [ ] **Step 4: Rewire `cmd/watcher/auth.go`** — replace `configureGitHub`/`configureJira` (and their `config.ValidateGitHubToken`/`ValidateJiraToken` calls) with `credsetup.TestAndRepair(&cfg, credsetup.GitHub/Jira/Slack, prompter)`; save once via `cfg.Save`. ADD Slack to: `knownWatchers` (`cmd/watcher/watcher.go:8`), `defaultIntervals` (`cmd/watcher/install.go:30`), the `runAuth` service list (`cmd/watcher/auth.go:41`), `isServiceConfigured` (`cmd/watcher/install.go:17`), `ServiceConfiguredForWatching` (`config/service_configured.go`). Handler's local `config/validate.go` becomes dead — remove it (and its tests) OR leave it if other code uses it (grep first; remove if unused).

- [ ] **Step 5: Build + test** — `go build ./... && go test ./...` green.

- [ ] **Step 6: Commit** — `git commit --signoff -m "watcher: use shared credsetup for github/jira/slack test+repair; re-pin v0.4.0"`.

---

## Notes for the executor
- **Stage order is strict:** A (library, isolated worktree) → release v0.4.0 → B (worktree) → C (handler). B and C both need v0.4.0 pushed.
- **Watcher concurrency:** all Stage-A code work happens in `~/git/watcher-credsetup` (isolated worktree). Only Task A5 touches `~/git/watcher` main, and only after confirming with the human that main is safe to merge/tag into (a concurrent github-bug session is active).
- **Cross-repo commits/pushes** are authorized this session; still announce the watcher tag push + any merge, and the handler push, in the ledger.
- Do NOT build/tag from a dirty `~/git/watcher` working tree.
- **Watcher worktree creation:** the controller session is isolated in the `worktree` repo and CANNOT run `git -C ~/git/watcher worktree add` itself (the harness blocks cross-repo git). Task A0 must be run by a dispatched subagent (subagents can run git in `~/git/watcher`). If the subagent can't create the isolated watcher worktree, Mike has offered to create one manually — ask him rather than forcing it in a dirty tree.
- Slack extraction stays consumer-side (worktree keeps extract.mjs; handler uses manual instructions).
- The `credsetup` validator seam (overridable package vars) is internal — keep the public API (`TestAndRepair`, `Prompter`) clean.
