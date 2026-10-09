# Linked Resources Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Linked Resources" tab to the worktree detail page for PR, Jira, and Slack resources, listing linked PRs / Jira issues / Slack threads / links with Follow / Open / Copy-link actions.

**Architecture:** New fetch functions in the watcher library (`~/git/watcher`: jira link graph + JQL summaries + ADF URL extraction, GitHub PR summary batch, Slack message URL extraction), re-pinned into worktree. A new pure `internal/linked` package assembles sections from those sources behind interfaces; `internal/webui/linked_api.go` serves it on demand with a 2-minute in-memory cache. The UI adds Mantine tabs to the PR/Jira and Slack detail panes and new `ui/src/components/linked/` components that reuse the existing status icon, cmux switch-to-tab, copy-link and follow-modal machinery.

**Tech Stack:** Go 1.25 (stdlib `net/http`, `httptest`), SQLite via `database/sql`; React 19 + Mantine 7 + TanStack Query 5, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-09-linked-resources-tab-design.md`

## Global Constraints

- Two repos. Tasks 1–4 run in the main working tree of `~/git/watcher`, on `main` (Mike authorized this). Tasks 5–14 run in a **new git worktree of the worktree repo** (branch `linked-resources-tab`, created with `worktree add` / `superpowers:using-git-worktrees`), not in `~/git/worktree` itself.
- All commits use `git commit --signoff` and end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git add -A` / `git add .` — add files by name.
- **Mike approved pushing and tagging watcher** (2026-10-09): Task 4's `git tag v0.11.0`, `git push origin main` and `git push origin v0.11.0` may run without asking again. No other pushes are pre-approved (the worktree branch is not pushed).
- Watcher test fixtures are **synthetic** (example.atlassian.net, example/repo, C0TEST…) — never real Slack/Jira content.
- Watcher's next release tag is `v0.11.0` (current is `v0.10.1`; this adds exported API).
- Jira hierarchy uses only the `parent` field + JQL `parent = KEY`. Do not use `customfield_10014`/`customfield_10018`.
- The Git PR field is looked up by the custom-field **name** `git_pull_request` (from `~/.config/watcher/config.yaml` `jira.custom_fields`), never a hardcoded `customfield_10875`.
- Caps: ancestor hops 6; children/siblings 50 per node; Slack thread resolutions 20; plain-link resolutions 20; resolution concurrency 4.
- Caches: linked-resources result 2 minutes keyed `(type,id,resolve_links)`; link metadata 30 minutes per URL; children 2 minutes per key.
- Plain links are only resolved (outbound fetch) when `resolve_links=1`, i.e. when the tab is opened — never on mere selection.
- Copy: tab labels `Activity` / `Thread` and `Linked Resources (N)`; buttons `Follow` / `View in worktree`, `Open` / `Open in Slack` / `Switch to tab`, copy-link icon with "Copy link" / "Copied!" tooltip; section titles "Git Pull Request", "Linked in description", "Hierarchy", "Linked work items", "Referenced by Jira", "Linked in thread"; empty state "No linked resources found"; unresolved note "couldn't load details"; overflow row "More on Jira…".
- Follow opens the existing `AddResourceModal` pre-filled with the URL, with **Related** preselected.
- Don't disable lint rules. Run UI tests with `cd ui && npm test`, Go tests with `make test` (worktree) / `go test ./...` (watcher).

### Deviations from the spec (decided while planning)

- Jira's `/rest/api/3/search/jql` returns no total, so overflow is `more: { url }` (no count) rendered as "More on Jira…".
- The item's favicon field is `favicon` (matching `ResourceDTO`), not `favicon_url`, so `ResourceStatusIcon`/`LinkFavicon` work unchanged.

## Review Focus

- **A linked Jira key that doesn't exist or isn't visible** — `key in (A,B)` JQL 400s for the whole batch; expected: the other keys still resolve and only the bad one is "couldn't load details". (Test in Task 7.)
- **A parent chain that loops or is very deep** — expected: the walk stops at 6 hops / first repeat, no hang. (Test in Task 2.)
- **Duplicate and self links** — the same PR linked as markdown, autolink and bare URL, or an issue linking to itself; expected: one row, never the current resource. (Test in Task 6.)
- **URLs with trailing punctuation or inside images/HTML comments in a PR body** — `see https://x.com/a.` or `![](https://user-images…)` or `<!-- https://… -->`; expected: `https://x.com/a`, image and commented URLs ignored. (Test in Task 6.)
- **Switching selected resource while the Linked tab is open** — expected: the tab resets to Activity/Thread and never shows the previous resource's linked data. (Test in Task 13.)

---

## File Structure

**watcher (`~/git/watcher`)**
- Create `jira/adf.go` — `ExtractADFURLs`. Test `jira/adf_test.go`.
- Modify `jira/poller.go` — cache `git_pull_request_urls`. Test in `jira/poller_test.go`.
- Create `jira/linkgraph.go` — `IssueSummary`, `IssueLink`, `LinkGraph`, `FetchLinkGraph`, `SearchSummaries`. Test `jira/linkgraph_test.go`.
- Create `github/summaries.go` — `PRSummary`, `FetchPRSummaries`. Test `github/summaries_test.go`.
- Create `slack/urls.go` — `ExtractURLs`. Test `slack/urls_test.go`.

**worktree**
- Modify `internal/jira/client.go` — `EffectiveCustomFields`. Modify `internal/webui/poller.go`, `cmd/watcher.go` to use it.
- Create `internal/linked/types.go` (DTOs + source interfaces), `classify.go` (URL extraction/classification), `resolve.go` (batch enrichment), `jira.go` (Jira sections + hierarchy), `pr.go`, `slack.go`, `builder.go` (entry points + count). Tests alongside.
- Create `internal/webui/linked_api.go` (adapters, cache, handlers) + `linked_api_test.go`; modify `internal/webui/server.go` (routes, fields).
- UI: modify `ui/src/api/types.ts`, `ui/src/api/client.ts`; create `ui/src/hooks/useLinkedResources.ts`; create `ui/src/components/resourceActionHooks.ts`; modify `ui/src/components/ResourceActions.tsx`; create `ui/src/components/linked/{LinkedActionsContext.tsx,LinkedResourceActions.tsx,LinkedResourceRow.tsx,HierarchyTree.tsx,LinkedResourcesPanel.tsx}` + tests; modify `ui/src/components/ResourceDetailPane.tsx`, `ui/src/components/SlackThreadPane.tsx`, `ui/src/pages/WorktreeDetailPage.tsx`.
- Docs: `docs/web-ui-architecture.md`, `.claude/CLAUDE.md`, spec file.

---

### Task 1: watcher — ADF URL extraction + cached `git_pull_request_urls`

**Files:**
- Create: `~/git/watcher/jira/adf.go`
- Test: `~/git/watcher/jira/adf_test.go`
- Modify: `~/git/watcher/jira/poller.go` (`buildJiraStateJSON`, ~line 393)
- Test: `~/git/watcher/jira/poller_test.go`

**Interfaces:**
- Produces: `func ExtractADFURLs(doc interface{}) []string` (package `jira`); state JSON key `git_pull_request_urls` (`[]string`) present whenever `IssueData.CustomFields["git_pull_request"]` exists.

- [ ] **Step 1: Write the failing tests** — `jira/adf_test.go`:

```go
package jira

import (
	"encoding/json"
	"reflect"
	"testing"
)

func decodeADF(t *testing.T, s string) interface{} {
	t.Helper()
	var v interface{}
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestExtractADFURLs(t *testing.T) {
	doc := decodeADF(t, `{"type":"doc","version":1,"content":[
		{"type":"paragraph","content":[
			{"type":"inlineCard","attrs":{"url":"https://github.com/example/repo/pull/1"}},
			{"type":"text","text":" see "},
			{"type":"text","text":"the guide","marks":[{"type":"link","attrs":{"href":"https://docs.example.com/guide"}}]},
			{"type":"text","text":" and https://example.atlassian.net/browse/PROJ-2."}
		]},
		{"type":"blockCard","attrs":{"url":"https://example.atlassian.net/browse/PROJ-3"}},
		{"type":"paragraph","content":[
			{"type":"inlineCard","attrs":{"url":"https://github.com/example/repo/pull/1"}}
		]}
	]}`)
	got := ExtractADFURLs(doc)
	want := []string{
		"https://github.com/example/repo/pull/1",
		"https://docs.example.com/guide",
		"https://example.atlassian.net/browse/PROJ-2",
		"https://example.atlassian.net/browse/PROJ-3",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}

func TestExtractADFURLsPlainStringAndNil(t *testing.T) {
	if got := ExtractADFURLs(nil); len(got) != 0 {
		t.Fatalf("nil: got %v", got)
	}
	// Jira Server style: a plain text field value.
	got := ExtractADFURLs("https://github.com/example/repo/pull/7, https://github.com/example/repo/pull/8")
	want := []string{"https://github.com/example/repo/pull/7", "https://github.com/example/repo/pull/8"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}
```

Append to `jira/poller_test.go`:

```go
func TestBuildJiraStateJSONCachesGitPRURLs(t *testing.T) {
	var adf interface{}
	json.Unmarshal([]byte(`{"type":"doc","content":[{"type":"paragraph","content":[
		{"type":"inlineCard","attrs":{"url":"https://github.com/example/repo/pull/5"}}]}]}`), &adf)
	issue := &IssueData{Key: "PROJ-1", CustomFields: map[string]interface{}{"git_pull_request": adf}}
	var state map[string]interface{}
	if err := json.Unmarshal([]byte(buildJiraStateJSON(issue)), &state); err != nil {
		t.Fatal(err)
	}
	urls, ok := state["git_pull_request_urls"].([]interface{})
	if !ok || len(urls) != 1 || urls[0] != "https://github.com/example/repo/pull/5" {
		t.Fatalf("git_pull_request_urls = %#v", state["git_pull_request_urls"])
	}
}

func TestBuildJiraStateJSONNoGitPRField(t *testing.T) {
	issue := &IssueData{Key: "PROJ-1", CustomFields: map[string]interface{}{}}
	if strings.Contains(buildJiraStateJSON(issue), "git_pull_request_urls") {
		t.Fatal("must not emit git_pull_request_urls when the field is not configured")
	}
}
```

(Add `"encoding/json"` / `"strings"` imports to `poller_test.go` if not already present.)

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/git/watcher && go test ./jira/ -run 'ExtractADFURLs|GitPR' -v`
Expected: FAIL — `undefined: ExtractADFURLs`.

- [ ] **Step 3: Implement** — `jira/adf.go`:

```go
package jira

import (
	"regexp"
	"strings"
)

// bareURLPattern finds URLs typed as plain text. Brackets and quotes end a
// URL so that "(https://x)" and "\"https://x\"" yield just the URL.
var bareURLPattern = regexp.MustCompile(`https?://[^\s<>"'()\[\]]+`)

// ExtractADFURLs returns every URL in an Atlassian Document Format value, in
// document order, deduplicated: inlineCard/blockCard/embedCard attrs.url,
// text nodes' link-mark hrefs, and bare URLs typed into text. A plain string
// (Jira Server-style field values) is scanned for bare URLs. Anything else
// yields nil.
func ExtractADFURLs(doc interface{}) []string {
	var out []string
	seen := map[string]bool{}
	add := func(u string) {
		u = strings.TrimRight(u, ".,;:!?")
		if u == "" || seen[u] {
			return
		}
		seen[u] = true
		out = append(out, u)
	}
	var walk func(n interface{})
	walk = func(n interface{}) {
		switch v := n.(type) {
		case string:
			for _, u := range bareURLPattern.FindAllString(v, -1) {
				add(u)
			}
		case []interface{}:
			for _, c := range v {
				walk(c)
			}
		case map[string]interface{}:
			t, _ := v["type"].(string)
			switch t {
			case "inlineCard", "blockCard", "embedCard":
				if a, ok := v["attrs"].(map[string]interface{}); ok {
					if u, ok := a["url"].(string); ok {
						add(u)
					}
				}
			case "text":
				linked := false
				if marks, ok := v["marks"].([]interface{}); ok {
					for _, m := range marks {
						mm, _ := m.(map[string]interface{})
						if mm["type"] != "link" {
							continue
						}
						if a, ok := mm["attrs"].(map[string]interface{}); ok {
							if h, ok := a["href"].(string); ok {
								add(h)
								linked = true
							}
						}
					}
				}
				if !linked {
					if s, ok := v["text"].(string); ok {
						walk(s)
					}
				}
			}
			// Only "content" is walked: map iteration order is random, and
			// attrs/marks were handled above.
			if c, ok := v["content"].([]interface{}); ok {
				walk(c)
			}
		}
	}
	walk(doc)
	return out
}
```

In `jira/poller.go` `buildJiraStateJSON`, after the `for k, v := range issue.CustomFields` loop:

```go
	// The Git Pull Request field is rich text (ADF). Consumers want the PR
	// URLs in it, not the document, so cache them as a plain list too.
	if v, ok := issue.CustomFields["git_pull_request"]; ok {
		state["git_pull_request_urls"] = ExtractADFURLs(v)
	}
```

- [ ] **Step 4: Run tests**

Run: `cd ~/git/watcher && go test ./jira/ -v -run 'ExtractADFURLs|GitPR' && go test ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/git/watcher
git add jira/adf.go jira/adf_test.go jira/poller.go jira/poller_test.go
git commit --signoff -m "feat(jira): extract URLs from ADF and cache git_pull_request_urls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: watcher — Jira link graph + JQL summaries

**Files:**
- Create: `~/git/watcher/jira/linkgraph.go`
- Test: `~/git/watcher/jira/linkgraph_test.go`

**Interfaces:**
- Consumes: `ExtractADFURLs` (Task 1), `(*Client).get` (existing).
- Produces:
  ```go
  type IssueSummary struct {
      Key, Summary, Status, StatusCategory, IssueType, IssueTypeIconURL string
      HierarchyLevel int
  }
  type IssueLink struct { Label string; Issue IssueSummary }
  type LinkGraph struct {
      Issue IssueSummary; Ancestors []IssueSummary; Subtasks []IssueSummary
      Links []IssueLink; DescriptionURLs []string; GitPRURLs []string
  }
  const MaxAncestorHops = 6
  func (c *Client) FetchLinkGraph(key, gitPRFieldID string) (*LinkGraph, error)
  func (c *Client) SearchSummaries(jql string, max int) (issues []IssueSummary, hasMore bool, err error)
  ```

- [ ] **Step 1: Write the failing tests** — `jira/linkgraph_test.go`:

```go
package jira

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// issueJSON renders a minimal issue for a fake Jira. parent may be "".
func issueJSON(key, typ string, level int, parent string) string {
	p := "null"
	if parent != "" {
		p = fmt.Sprintf(`{"key":%q,"fields":{"summary":"S %s"}}`, parent, parent)
	}
	return fmt.Sprintf(`{"key":%q,"fields":{"summary":"S %s",
		"status":{"name":"In Progress","statusCategory":{"key":"indeterminate"}},
		"issuetype":{"name":%q,"iconUrl":"https://example.atlassian.net/icon/%s","hierarchyLevel":%d},
		"parent":%s}}`, key, key, typ, typ, level, p)
}

func TestFetchLinkGraph(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/rest/api/3/issue/PROJ-1":
			if !strings.Contains(r.URL.Query().Get("fields"), "customfield_99") {
				t.Errorf("git PR field not requested: %s", r.URL.RawQuery)
			}
			fmt.Fprint(w, `{"key":"PROJ-1","fields":{"summary":"Story one",
				"status":{"name":"Review","statusCategory":{"key":"indeterminate"}},
				"issuetype":{"name":"Story","iconUrl":"https://example.atlassian.net/icon/story","hierarchyLevel":0},
				"parent":{"key":"PROJ-10","fields":{"summary":"Epic"}},
				"subtasks":[{"key":"PROJ-2","fields":{"summary":"Sub","status":{"name":"New","statusCategory":{"key":"new"}},"issuetype":{"name":"Sub-task","hierarchyLevel":-1}}}],
				"issuelinks":[
					{"type":{"inward":"is blocked by","outward":"blocks"},"outwardIssue":{"key":"PROJ-3","fields":{"summary":"Blocked one","status":{"name":"New"},"issuetype":{"name":"Bug"}}}},
					{"type":{"inward":"is cloned by","outward":"clones"},"inwardIssue":{"key":"PROJ-4","fields":{"summary":"Clone","status":{"name":"Done"},"issuetype":{"name":"Story"}}}}
				],
				"description":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"inlineCard","attrs":{"url":"https://example.atlassian.net/browse/PROJ-5"}}]}]},
				"customfield_99":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"inlineCard","attrs":{"url":"https://github.com/example/repo/pull/9"}}]}]}
			}}`)
		case "/rest/api/3/issue/PROJ-10":
			fmt.Fprint(w, issueJSON("PROJ-10", "Epic", 1, "OTHER-20"))
		case "/rest/api/3/issue/OTHER-20":
			fmt.Fprint(w, issueJSON("OTHER-20", "Feature", 2, ""))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Email: "u@example.com", Token: "t"}
	g, err := c.FetchLinkGraph("PROJ-1", "customfield_99")
	if err != nil {
		t.Fatal(err)
	}
	if g.Issue.Key != "PROJ-1" || g.Issue.IssueType != "Story" || g.Issue.StatusCategory != "indeterminate" {
		t.Errorf("issue = %+v", g.Issue)
	}
	if len(g.Ancestors) != 2 || g.Ancestors[0].Key != "PROJ-10" || g.Ancestors[1].Key != "OTHER-20" || g.Ancestors[1].HierarchyLevel != 2 {
		t.Errorf("ancestors = %+v", g.Ancestors)
	}
	if len(g.Subtasks) != 1 || g.Subtasks[0].Key != "PROJ-2" || g.Subtasks[0].HierarchyLevel != -1 {
		t.Errorf("subtasks = %+v", g.Subtasks)
	}
	if len(g.Links) != 2 || g.Links[0].Label != "blocks" || g.Links[0].Issue.Key != "PROJ-3" ||
		g.Links[1].Label != "is cloned by" || g.Links[1].Issue.Key != "PROJ-4" {
		t.Errorf("links = %+v", g.Links)
	}
	if len(g.DescriptionURLs) != 1 || len(g.GitPRURLs) != 1 || g.GitPRURLs[0] != "https://github.com/example/repo/pull/9" {
		t.Errorf("urls: desc=%v gitpr=%v", g.DescriptionURLs, g.GitPRURLs)
	}
}

func TestFetchLinkGraphNoGitPRField(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, issueJSON("PROJ-1", "Story", 0, ""))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL}
	g, err := c.FetchLinkGraph("PROJ-1", "")
	if err != nil {
		t.Fatal(err)
	}
	if g.GitPRURLs != nil {
		t.Errorf("GitPRURLs must be nil when the field is unconfigured, got %v", g.GitPRURLs)
	}
	if len(g.Ancestors) != 0 {
		t.Errorf("ancestors = %v", g.Ancestors)
	}
}

func TestFetchLinkGraphStopsOnCycleAndHopCap(t *testing.T) {
	// A → B → A ... must terminate.
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		key := strings.TrimPrefix(r.URL.Path, "/rest/api/3/issue/")
		next := map[string]string{"PROJ-1": "PROJ-2", "PROJ-2": "PROJ-1"}[key]
		fmt.Fprint(w, issueJSON(key, "Story", 0, next))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL}
	g, err := c.FetchLinkGraph("PROJ-1", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Ancestors) != 1 || g.Ancestors[0].Key != "PROJ-2" {
		t.Errorf("cycle: ancestors = %+v", g.Ancestors)
	}
	if hits > 3 {
		t.Errorf("cycle walk made %d requests", hits)
	}

	// An endless chain stops at MaxAncestorHops.
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/rest/api/3/issue/")
		var n int
		fmt.Sscanf(key, "PROJ-%d", &n)
		fmt.Fprint(w, issueJSON(key, "Story", 0, fmt.Sprintf("PROJ-%d", n+1)))
	}))
	defer srv2.Close()
	g2, err := (&Client{BaseURL: srv2.URL}).FetchLinkGraph("PROJ-1", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(g2.Ancestors) != MaxAncestorHops {
		t.Errorf("hop cap: got %d ancestors", len(g2.Ancestors))
	}
}

func TestFetchLinkGraphAncestorErrorKeepsPartialChain(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "PROJ-1") {
			fmt.Fprint(w, issueJSON("PROJ-1", "Story", 0, "SECRET-1"))
			return
		}
		http.Error(w, `{"errorMessages":["no permission"]}`, http.StatusNotFound)
	}))
	defer srv.Close()
	g, err := (&Client{BaseURL: srv.URL}).FetchLinkGraph("PROJ-1", "")
	if err != nil {
		t.Fatalf("an unreadable parent must not fail the graph: %v", err)
	}
	// The parent ref embedded in the issue still names it.
	if len(g.Ancestors) != 1 || g.Ancestors[0].Key != "SECRET-1" {
		t.Errorf("ancestors = %+v", g.Ancestors)
	}
}

func TestSearchSummaries(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rest/api/3/search/jql" {
			t.Errorf("path %s", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("jql") != "parent = PROJ-10" || q.Get("maxResults") != "3" {
			t.Errorf("query %v", q)
		}
		fmt.Fprintf(w, `{"issues":[%s,%s,%s],"isLast":true}`,
			issueJSON("PROJ-1", "Story", 0, ""), issueJSON("PROJ-2", "Story", 0, ""), issueJSON("PROJ-3", "Story", 0, ""))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL}
	got, more, err := c.SearchSummaries("parent = PROJ-10", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || !more || got[0].Key != "PROJ-1" {
		t.Errorf("got %d issues more=%v: %+v", len(got), more, got)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/git/watcher && go test ./jira/ -run 'LinkGraph|SearchSummaries' -v`
Expected: FAIL — `undefined: (*Client).FetchLinkGraph`.

- [ ] **Step 3: Implement** — `jira/linkgraph.go`:

```go
package jira

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
)

// MaxAncestorHops bounds the parent walk. Real hierarchies are at most
// Outcome → Feature → Epic → Story → Sub-task; the cap only matters for
// misconfigured or cyclic data.
const MaxAncestorHops = 6

// IssueSummary is the minimum needed to render an issue as a row.
type IssueSummary struct {
	Key              string
	Summary          string
	Status           string
	StatusCategory   string // "new" | "indeterminate" | "done" | ""
	IssueType        string
	IssueTypeIconURL string
	// HierarchyLevel is Jira's issuetype.hierarchyLevel: -1 sub-task,
	// 0 story/task/bug, 1 epic, 2 feature, 3 initiative/outcome.
	HierarchyLevel int
}

// IssueLink is one "Linked work items" entry. Label is Jira's own phrase for
// the relationship from THIS issue's side ("blocks", "is cloned by").
type IssueLink struct {
	Label string
	Issue IssueSummary
}

// LinkGraph is everything one issue says about what it links to.
type LinkGraph struct {
	Issue     IssueSummary
	Ancestors []IssueSummary // nearest parent first
	Subtasks  []IssueSummary
	Links     []IssueLink // in Jira's order
	// DescriptionURLs are the URLs in the description, in order, deduped.
	DescriptionURLs []string
	// GitPRURLs are the URLs in the Git Pull Request field; nil when no
	// field ID was given.
	GitPRURLs []string
}

const summaryFields = "summary,status,issuetype,parent"

type rawSummaryFields struct {
	Summary string `json:"summary"`
	Status  struct {
		Name           string `json:"name"`
		StatusCategory struct {
			Key string `json:"key"`
		} `json:"statusCategory"`
	} `json:"status"`
	IssueType struct {
		Name           string `json:"name"`
		IconURL        string `json:"iconUrl"`
		HierarchyLevel int    `json:"hierarchyLevel"`
	} `json:"issuetype"`
	Parent *rawIssueRef `json:"parent"`
}

type rawIssueRef struct {
	Key    string           `json:"key"`
	Fields rawSummaryFields `json:"fields"`
}

func (r rawIssueRef) summary() IssueSummary {
	return IssueSummary{
		Key:              r.Key,
		Summary:          r.Fields.Summary,
		Status:           r.Fields.Status.Name,
		StatusCategory:   r.Fields.Status.StatusCategory.Key,
		IssueType:        r.Fields.IssueType.Name,
		IssueTypeIconURL: r.Fields.IssueType.IconURL,
		HierarchyLevel:   r.Fields.IssueType.HierarchyLevel,
	}
}

func (c *Client) fetchSummaryRef(key string) (*rawIssueRef, error) {
	body, err := c.get(fmt.Sprintf("%s/rest/api/3/issue/%s?fields=%s",
		normalizeBaseURL(c.BaseURL), url.PathEscape(key), url.QueryEscape(summaryFields)))
	if err != nil {
		return nil, err
	}
	var ref rawIssueRef
	if err := json.Unmarshal(body, &ref); err != nil {
		return nil, fmt.Errorf("decode %s: %w", key, err)
	}
	return &ref, nil
}

// FetchLinkGraph fetches an issue's parent chain, sub-tasks, issue links,
// description URLs and (when gitPRFieldID is non-empty) Git Pull Request
// field URLs. Children other than sub-tasks are NOT included — use
// SearchSummaries("parent = KEY") for those.
//
// Only the first request is fatal. An ancestor that can't be read (deleted,
// no permission) ends the walk, keeping the parent ref the child embedded.
func (c *Client) FetchLinkGraph(key, gitPRFieldID string) (*LinkGraph, error) {
	fields := summaryFields + ",subtasks,issuelinks,description"
	if gitPRFieldID != "" {
		fields += "," + gitPRFieldID
	}
	body, err := c.get(fmt.Sprintf("%s/rest/api/3/issue/%s?fields=%s",
		normalizeBaseURL(c.BaseURL), url.PathEscape(key), url.QueryEscape(fields)))
	if err != nil {
		return nil, err
	}
	var raw struct {
		Key    string `json:"key"`
		Fields struct {
			rawSummaryFields
			Subtasks   []rawIssueRef `json:"subtasks"`
			IssueLinks []struct {
				Type struct {
					Inward  string `json:"inward"`
					Outward string `json:"outward"`
				} `json:"type"`
				InwardIssue  *rawIssueRef `json:"inwardIssue"`
				OutwardIssue *rawIssueRef `json:"outwardIssue"`
			} `json:"issuelinks"`
			Description interface{} `json:"description"`
		} `json:"fields"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("decode %s: %w", key, err)
	}
	g := &LinkGraph{}
	g.Issue = rawIssueRef{Key: raw.Key, Fields: raw.Fields.rawSummaryFields}.summary()
	if g.Issue.Key == "" {
		g.Issue.Key = key
	}
	for _, s := range raw.Fields.Subtasks {
		g.Subtasks = append(g.Subtasks, s.summary())
	}
	for _, l := range raw.Fields.IssueLinks {
		switch {
		case l.OutwardIssue != nil:
			g.Links = append(g.Links, IssueLink{Label: l.Type.Outward, Issue: l.OutwardIssue.summary()})
		case l.InwardIssue != nil:
			g.Links = append(g.Links, IssueLink{Label: l.Type.Inward, Issue: l.InwardIssue.summary()})
		}
	}
	g.DescriptionURLs = ExtractADFURLs(raw.Fields.Description)
	if gitPRFieldID != "" {
		var all map[string]json.RawMessage
		var fieldsMap map[string]json.RawMessage
		if json.Unmarshal(body, &all) == nil && json.Unmarshal(all["fields"], &fieldsMap) == nil {
			var v interface{}
			if rv, ok := fieldsMap[gitPRFieldID]; ok && json.Unmarshal(rv, &v) == nil {
				g.GitPRURLs = ExtractADFURLs(v)
			}
		}
		if g.GitPRURLs == nil {
			g.GitPRURLs = []string{}
		}
	}

	seen := map[string]bool{g.Issue.Key: true}
	next := raw.Fields.Parent
	for hops := 0; next != nil && next.Key != "" && !seen[next.Key] && hops < MaxAncestorHops; hops++ {
		seen[next.Key] = true
		ref, err := c.fetchSummaryRef(next.Key)
		if err != nil {
			// Unreadable ancestor: keep what the child told us and stop.
			g.Ancestors = append(g.Ancestors, next.summary())
			break
		}
		g.Ancestors = append(g.Ancestors, ref.summary())
		next = ref.Fields.Parent
	}
	return g, nil
}

// SearchSummaries runs one JQL search and returns up to max issues, plus
// whether more matched. The /search/jql endpoint reports no total, so one
// extra result is requested to answer hasMore.
func (c *Client) SearchSummaries(jql string, max int) ([]IssueSummary, bool, error) {
	q := url.Values{}
	q.Set("jql", jql)
	q.Set("fields", summaryFields)
	q.Set("maxResults", strconv.Itoa(max+1))
	body, err := c.get(normalizeBaseURL(c.BaseURL) + "/rest/api/3/search/jql?" + q.Encode())
	if err != nil {
		return nil, false, err
	}
	var raw struct {
		Issues []rawIssueRef `json:"issues"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, false, fmt.Errorf("decode search: %w", err)
	}
	more := len(raw.Issues) > max
	if more {
		raw.Issues = raw.Issues[:max]
	}
	out := make([]IssueSummary, 0, len(raw.Issues))
	for _, r := range raw.Issues {
		out = append(out, r.summary())
	}
	return out, more, nil
}
```

Note: in `TestSearchSummaries` the test asserts `maxResults=3` for `max=2` — that is the `max+1` probe.

- [ ] **Step 4: Run tests**

Run: `cd ~/git/watcher && go test ./jira/ -v -run 'LinkGraph|SearchSummaries' && go test ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/git/watcher
git add jira/linkgraph.go jira/linkgraph_test.go
git commit --signoff -m "feat(jira): FetchLinkGraph and SearchSummaries for linked-issue views

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: watcher — GitHub PR summary batch

**Files:**
- Create: `~/git/watcher/github/summaries.go`
- Test: `~/git/watcher/github/summaries_test.go`

**Interfaces:**
- Consumes: `PRRef` (existing).
- Produces:
  ```go
  type PRSummary struct { Title, State, URL, Body string; IsDraft bool } // State: OPEN|CLOSED|MERGED
  func FetchPRSummaries(token string, refs []PRRef, apiURL ...string) (map[PRRef]PRSummary, error)
  ```

- [ ] **Step 1: Write the failing tests** — `github/summaries_test.go`:

```go
package github

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFetchPRSummaries(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("auth header %q", r.Header.Get("Authorization"))
		}
		b, _ := io.ReadAll(r.Body)
		var req struct{ Query string }
		json.Unmarshal(b, &req)
		if !strings.Contains(req.Query, `pr0: repository(owner: "example", name: "repo")`) ||
			!strings.Contains(req.Query, "pullRequest(number: 1)") || !strings.Contains(req.Query, "pr1:") {
			t.Errorf("query: %s", req.Query)
		}
		w.Write([]byte(`{"data":{
			"pr0":{"pullRequest":{"title":"One","state":"OPEN","isDraft":true,"url":"https://github.com/example/repo/pull/1","body":"see https://example.com"}},
			"pr1":null},
			"errors":[{"message":"Could not resolve to a Repository"}]}`))
	}))
	defer srv.Close()

	a := PRRef{Owner: "example", Repo: "repo", Number: 1}
	b := PRRef{Owner: "gone", Repo: "repo", Number: 2}
	got, err := FetchPRSummaries("tok", []PRRef{a, b}, srv.URL)
	if err != nil {
		t.Fatalf("partial failure must not fail: %v", err)
	}
	if s, ok := got[a]; !ok || s.Title != "One" || !s.IsDraft || s.State != "OPEN" || s.Body != "see https://example.com" {
		t.Errorf("a = %+v ok=%v", got[a], ok)
	}
	if _, ok := got[b]; ok {
		t.Error("unresolvable PR must be absent")
	}
}

func TestFetchPRSummariesEmptyAndTotalFailure(t *testing.T) {
	got, err := FetchPRSummaries("tok", nil)
	if err != nil || len(got) != 0 {
		t.Fatalf("empty: %v %v", got, err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":null,"errors":[{"message":"Bad credentials"}]}`))
	}))
	defer srv.Close()
	if _, err := FetchPRSummaries("tok", []PRRef{{Owner: "o", Repo: "r", Number: 1}}, srv.URL); err == nil {
		t.Fatal("total failure must error")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/git/watcher && go test ./github/ -run FetchPRSummaries -v`
Expected: FAIL — `undefined: FetchPRSummaries`.

- [ ] **Step 3: Implement** — `github/summaries.go`:

```go
package github

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// PRSummary is the minimum needed to render a PR as a row, plus its body
// (which callers scan for links).
type PRSummary struct {
	Title   string
	State   string // OPEN | CLOSED | MERGED
	IsDraft bool
	URL     string
	Body    string
}

// FetchPRSummaries fetches title/state/draft/url/body for many PRs in ONE
// GraphQL request (one alias per PR). PRs that can't be resolved (deleted,
// private, typo'd) are simply absent from the result; only a response with
// nothing usable at all is an error.
func FetchPRSummaries(token string, refs []PRRef, apiURL ...string) (map[PRRef]PRSummary, error) {
	out := map[PRRef]PRSummary{}
	if len(refs) == 0 {
		return out, nil
	}
	endpoint := "https://api.github.com/graphql"
	if len(apiURL) > 0 && apiURL[0] != "" {
		endpoint = apiURL[0]
	}
	var q strings.Builder
	q.WriteString("query {\n")
	for i, r := range refs {
		fmt.Fprintf(&q, "  pr%d: repository(owner: %s, name: %s) { pullRequest(number: %d) { title state isDraft url body } }\n",
			i, strconv.Quote(r.Owner), strconv.Quote(r.Repo), r.Number)
	}
	q.WriteString("}")

	payload, _ := json.Marshal(map[string]string{"query": q.String()})
	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("github graphql: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API returned status %d: %s", resp.StatusCode, string(body))
	}
	var result struct {
		Data map[string]*struct {
			PullRequest *PRSummary `json:"pullRequest"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("decode graphql: %w", err)
	}
	for i, r := range refs {
		if a := result.Data[fmt.Sprintf("pr%d", i)]; a != nil && a.PullRequest != nil {
			out[r] = *a.PullRequest
		}
	}
	if len(out) == 0 && len(result.Errors) > 0 {
		return nil, fmt.Errorf("github graphql: %s", result.Errors[0].Message)
	}
	return out, nil
}
```

`PRSummary` decodes directly because GraphQL field names (`title`, `state`, `isDraft`, `url`, `body`) match Go field names case-insensitively.

- [ ] **Step 4: Run tests**

Run: `cd ~/git/watcher && go test ./github/ -run FetchPRSummaries -v && go test ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/git/watcher
git add github/summaries.go github/summaries_test.go
git commit --signoff -m "feat(github): FetchPRSummaries batch for linked-PR rows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: watcher — Slack message URL extraction + release

**Files:**
- Create: `~/git/watcher/slack/urls.go`
- Test: `~/git/watcher/slack/urls_test.go`
- Modify (only if something new was learned): `~/git/worktree/docs/reverse-engineering/slack-web-api.md`

**Interfaces:**
- Consumes: `Message`, `Block`, `Element`, `Attachment`, `BlockKit` (existing in `slack/types.go`).
- Produces: `func ExtractURLs(m Message) []string`; watcher tag `v0.11.0`.

- [ ] **Step 1: Write the failing test** — `slack/urls_test.go`:

```go
package slack

import (
	"reflect"
	"testing"
)

func TestExtractURLs(t *testing.T) {
	m := Message{
		Text: "see <https://github.com/example/repo/pull/1|the PR> and <@U0TEST> in <#C0TEST|general> <!here> " +
			"plus <https://example.atlassian.net/browse/PROJ-1>",
		Blocks: []Block{
			{Type: "section", Elements: []Element{
				{Type: "text", Text: "see "},
				{Type: "link", URL: "https://github.com/example/repo/pull/1", Text: "the PR"},
			}},
			{Type: "list", Items: [][]Element{{{Type: "link", URL: "https://docs.example.com/a"}}}},
		},
		Attachments: []Attachment{
			{FromURL: "https://example.slack.com/archives/C0TEST/p1700000000000100", TitleLink: "https://example.slack.com/archives/C0TEST/p1700000000000100"},
			{Blocks: []BlockKit{{Type: "rich_text", RichText: []Block{{Type: "section", Elements: []Element{{Type: "link", URL: "https://docs.example.com/b"}}}}}}},
		},
	}
	got := ExtractURLs(m)
	want := []string{
		"https://github.com/example/repo/pull/1",
		"https://docs.example.com/a",
		"https://example.atlassian.net/browse/PROJ-1",
		"https://example.slack.com/archives/C0TEST/p1700000000000100",
		"https://docs.example.com/b",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/git/watcher && go test ./slack/ -run ExtractURLs -v`
Expected: FAIL — `undefined: ExtractURLs`.

- [ ] **Step 3: Implement** — `slack/urls.go`:

```go
package slack

import "regexp"

// mrkdwnLinkPattern matches <url> and <url|label> in mrkdwn text. Mentions
// (<@U…>, <#C…>, <!here>) never start with http so they don't match.
var mrkdwnLinkPattern = regexp.MustCompile(`<(https?://[^|>\s]+)(?:\|[^>]*)?>`)

// ExtractURLs returns the URLs a message links to, deduplicated, in this
// order: rich_text link elements, mrkdwn links in Text (covers block-less
// messages), then attachment from_url/title_link and links inside attachment
// rich_text. Mentions, emoji and files are not URLs and are skipped.
func ExtractURLs(m Message) []string {
	var out []string
	seen := map[string]bool{}
	add := func(u string) {
		if u == "" || seen[u] {
			return
		}
		seen[u] = true
		out = append(out, u)
	}
	walkElems := func(els []Element) {
		for _, e := range els {
			if e.Type == "link" {
				add(e.URL)
			}
		}
	}
	walkBlocks := func(bs []Block) {
		for _, b := range bs {
			walkElems(b.Elements)
			for _, item := range b.Items {
				walkElems(item)
			}
		}
	}
	walkBlocks(m.Blocks)
	for _, mm := range mrkdwnLinkPattern.FindAllStringSubmatch(m.Text, -1) {
		add(mm[1])
	}
	for _, a := range m.Attachments {
		add(a.FromURL)
		add(a.TitleLink)
		for _, bk := range a.Blocks {
			walkBlocks(bk.RichText)
		}
	}
	return out
}
```

- [ ] **Step 4: Run tests**

Run: `cd ~/git/watcher && go test ./... `
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/git/watcher
git add slack/urls.go slack/urls_test.go
git commit --signoff -m "feat(slack): ExtractURLs for a message's links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Release** — tag and push (pre-approved by Mike):

```bash
cd ~/git/watcher
git tag v0.11.0
git push origin main
git push origin v0.11.0
```

---

### Task 5: worktree — re-pin watcher, use configured custom fields

**Files:**
- Modify: `go.mod`, `go.sum`
- Modify: `internal/jira/client.go` (add `EffectiveCustomFields`)
- Test: `internal/jira/client_test.go`
- Modify: `internal/webui/poller.go` (two `wjira.JiraAuth{...}` literals, ~lines 79 and 126)
- Modify: `cmd/watcher.go` (~line 92)

**Interfaces:**
- Produces: `func EffectiveCustomFields(authFields map[string]string, configFields map[string]string) map[string]string` and `func ConfiguredCustomFields(authFields map[string]string) map[string]string` (package `internal/jira`). The second loads `~/.config/watcher/config.yaml` and calls the first. Later tasks call `jira.ConfiguredCustomFields(jc.CustomFields)["git_pull_request"]` to get the field ID.

- [ ] **Step 1: Re-pin**

Run: `cd ~/git/worktree && go get github.com/mturley/watcher@v0.11.0 && go mod tidy && go build ./...`
Expected: builds.

- [ ] **Step 2: Write the failing test** — append to `internal/jira/client_test.go`:

```go
func TestEffectiveCustomFields(t *testing.T) {
	got := EffectiveCustomFields(
		map[string]string{"epic_key": "customfield_1"},
		map[string]string{"epic_key": "customfield_X", "git_pull_request": "customfield_2"},
	)
	if got["epic_key"] != "customfield_1" {
		t.Errorf("auth.yaml must win on conflict: %v", got)
	}
	if got["git_pull_request"] != "customfield_2" {
		t.Errorf("config.yaml fields must be merged in: %v", got)
	}
	if EffectiveCustomFields(nil, nil) == nil {
		t.Error("must return a non-nil map")
	}
}
```

- [ ] **Step 3: Run to verify failure**

Run: `go test ./internal/jira/ -run EffectiveCustomFields -v`
Expected: FAIL — undefined.

- [ ] **Step 4: Implement** — append to `internal/jira/client.go`:

```go
// EffectiveCustomFields merges the custom-field maps from the watcher's two
// config files. auth.yaml's (jira_custom_fields) wins on conflict;
// config.yaml's jira.custom_fields fills the rest. worktree used to pass
// only the auth.yaml map, which is usually empty, so fields like
// git_pull_request configured in config.yaml were never fetched.
func EffectiveCustomFields(authFields, configFields map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range configFields {
		out[k] = v
	}
	for k, v := range authFields {
		out[k] = v
	}
	return out
}

// ConfiguredCustomFields is EffectiveCustomFields with config.yaml loaded
// from its default path. A missing or unreadable config.yaml contributes
// nothing.
func ConfiguredCustomFields(authFields map[string]string) map[string]string {
	var cfgFields map[string]string
	if bcfg, err := wconfig.LoadConfig(wconfig.ConfigDefaultPath()); err == nil {
		cfgFields = bcfg.JiraCustomFields()
	}
	return EffectiveCustomFields(authFields, cfgFields)
}
```

In `internal/webui/poller.go`, in BOTH `wjira.JiraAuth{...}` literals, replace `CustomFields: jc.CustomFields` with `CustomFields: wtjira.ConfiguredCustomFields(jc.CustomFields)`, importing `wtjira "github.com/mturley/worktree/internal/jira"` (check the file's existing imports first; if `internal/jira` is already imported under another name, use that name). Make the same replacement in `cmd/watcher.go` line ~92.

- [ ] **Step 5: Run tests**

Run: `make test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum internal/jira/client.go internal/jira/client_test.go internal/webui/poller.go cmd/watcher.go
git commit --signoff -m "feat: pin watcher v0.11.0 and poll config.yaml's Jira custom fields

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `internal/linked` — types, URL extraction, classification

**Files:**
- Create: `internal/linked/types.go`, `internal/linked/classify.go`
- Test: `internal/linked/classify_test.go`

**Interfaces:**
- Consumes: `resourceurl.InferAny` (existing), watcher types `wjira.LinkGraph`, `wjira.IssueSummary`, `wgithub.PRRef`, `wgithub.PRSummary`, `slack.Thread`, `linkmeta.Meta`.
- Produces (all in package `linked`):
  ```go
  type Item struct { Type, ID, URL string; Resolved bool; Title, State string; IsDraft bool;
      Status, StatusCategory, IssueType, IssueTypeIconURL, ChannelName, Excerpt, Domain, Favicon string }
  type More struct{ URL string }
  type TreeNode struct { Item; Current, Expanded bool; HasChildren *bool; Children []*TreeNode; More *More }
  type Group struct { Label string; Items []Item }
  type Section struct { Kind, Title, Error string; Items []Item; Groups []Group; Tree []*TreeNode }
  type Result struct { FetchedAt string; Count int; Sections []Section }
  type Key struct{ Type, ID string }
  type JiraSource interface { LinkGraph(ctx, key string) (*wjira.LinkGraph, error); Search(ctx, jql string, max int) ([]wjira.IssueSummary, bool, error); IssueURL(key string) string; SearchURL(jql string) string }
  type PRSource interface { Summaries(ctx, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) }
  type SlackSource interface { Thread(ctx, channel, ts string) (slack.Thread, error); ChannelName(ctx, id string) (string, error) }
  type LinkResolver interface { Resolve(ctx, url string) linkmeta.Meta }
  type JiraStateIndex interface { IssuesReferencingPR(ctx, prID string) ([]Item, error) }
  type Sources struct { Jira JiraSource; PR PRSource; Slack SlackSource; Links LinkResolver; JiraState JiraStateIndex }
  var ErrNotConfigured error
  func ExtractMarkdownURLs(body string) []string
  func Classify(urls []string, self Key) []Item
  func jiraItem(s wjira.IssueSummary, url string) Item
  ```

- [ ] **Step 1: Write the failing tests** — `internal/linked/classify_test.go`:

```go
package linked

import (
	"reflect"
	"testing"
)

func TestExtractMarkdownURLs(t *testing.T) {
	body := "Fixes [PROJ-1](https://example.atlassian.net/browse/PROJ-1).\n" +
		"Related: <https://github.com/example/repo/pull/2> and https://github.com/example/repo/pull/2.\n" +
		"See https://docs.example.com/a, then (https://docs.example.com/b)!\n" +
		"![screenshot](https://user-images.example.com/shot.png)\n" +
		"<img src=\"https://user-images.example.com/other.png\" />\n" +
		"<!-- https://hidden.example.com/x -->"
	got := ExtractMarkdownURLs(body)
	want := []string{
		"https://example.atlassian.net/browse/PROJ-1",
		"https://github.com/example/repo/pull/2",
		"https://docs.example.com/a",
		"https://docs.example.com/b",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}

func TestClassify(t *testing.T) {
	urls := []string{
		"https://github.com/example/repo/pull/2",
		"https://github.com/example/repo/pull/2/files", // same PR → deduped
		"https://example.atlassian.net/browse/PROJ-1",  // self → dropped
		"https://example.atlassian.net/browse/PROJ-9",
		"https://example.slack.com/archives/C0TEST/p1700000000000100",
		"https://Docs.Example.com/a#frag",
		"not a url",
	}
	got := Classify(urls, Key{Type: "jira", ID: "PROJ-1"})
	if len(got) != 4 {
		t.Fatalf("got %d items: %+v", len(got), got)
	}
	if got[0].Type != "pr" || got[0].ID != "example/repo#2" || got[0].URL != "https://github.com/example/repo/pull/2" {
		t.Errorf("pr = %+v", got[0])
	}
	if got[1].Type != "jira" || got[1].ID != "PROJ-9" {
		t.Errorf("jira = %+v", got[1])
	}
	if got[2].Type != "slack" || got[2].ID != "C0TEST:1700000000.000100" {
		t.Errorf("slack = %+v", got[2])
	}
	if got[3].Type != "link" || got[3].ID != "https://docs.example.com/a" || got[3].Domain != "docs.example.com" || !got[3].Resolved {
		t.Errorf("link = %+v", got[3])
	}
	for _, it := range got[:3] {
		if it.Resolved {
			t.Errorf("non-link items start unresolved: %+v", it)
		}
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/linked/ -v`
Expected: FAIL — package has no Go files / undefined.

- [ ] **Step 3: Implement** — `internal/linked/types.go`:

```go
// Package linked assembles the "Linked Resources" view of a PR, Jira issue
// or Slack thread: the other resources it links to, grouped into sections.
//
// It is pure: every network or DB access goes through the Sources
// interfaces, so the assembly logic is testable without credentials. The
// webui package supplies real adapters (internal/webui/linked_api.go).
package linked

import (
	"context"
	"errors"

	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/linkmeta"
)

// ErrNotConfigured means the source a resource type needs has no
// credentials. The API maps it to 503.
var ErrNotConfigured = errors.New("source not configured")

// Item is one linked resource row. Field names mirror the UI's ResourceDTO
// so the existing status icon and key rendering apply unchanged.
type Item struct {
	Type             string `json:"type"` // pr | jira | slack | link
	ID               string `json:"id"`
	URL              string `json:"url"`
	Resolved         bool   `json:"resolved"`
	Title            string `json:"title,omitempty"`
	State            string `json:"state,omitempty"`
	IsDraft          bool   `json:"is_draft,omitempty"`
	Status           string `json:"status,omitempty"`
	StatusCategory   string `json:"status_category,omitempty"`
	IssueType        string `json:"issue_type,omitempty"`
	IssueTypeIconURL string `json:"issue_type_icon_url,omitempty"`
	ChannelName      string `json:"channel_name,omitempty"`
	Excerpt          string `json:"excerpt,omitempty"`
	Domain           string `json:"domain,omitempty"`
	Favicon          string `json:"favicon,omitempty"`
}

// More marks a node whose children were capped; URL is the JQL search on
// Jira that shows the rest.
type More struct {
	URL string `json:"url"`
}

// TreeNode is one issue in the hierarchy tree. HasChildren is nil when
// unknown (the UI offers a lazy expand).
type TreeNode struct {
	Item
	Current     bool        `json:"current,omitempty"`
	Expanded    bool        `json:"expanded"`
	HasChildren *bool       `json:"has_children"`
	Children    []*TreeNode `json:"children,omitempty"`
	More        *More       `json:"more,omitempty"`
}

type Group struct {
	Label string `json:"label"`
	Items []Item `json:"items"`
}

// Section kinds: git_pr, description, hierarchy, links, referenced_by, thread.
type Section struct {
	Kind   string      `json:"kind"`
	Title  string      `json:"title"`
	Error  string      `json:"error,omitempty"`
	Items  []Item      `json:"items,omitempty"`
	Groups []Group     `json:"groups,omitempty"`
	Tree   []*TreeNode `json:"tree,omitempty"`
}

type Result struct {
	FetchedAt string    `json:"fetched_at"`
	Count     int       `json:"count"`
	Sections  []Section `json:"sections"`
}

// Key identifies a resource by worktree type and id.
type Key struct{ Type, ID string }

type JiraSource interface {
	LinkGraph(ctx context.Context, key string) (*wjira.LinkGraph, error)
	Search(ctx context.Context, jql string, max int) ([]wjira.IssueSummary, bool, error)
	IssueURL(key string) string
	SearchURL(jql string) string
}

type PRSource interface {
	Summaries(ctx context.Context, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error)
}

type SlackSource interface {
	Thread(ctx context.Context, channel, ts string) (slack.Thread, error)
	ChannelName(ctx context.Context, id string) (string, error)
}

type LinkResolver interface {
	Resolve(ctx context.Context, url string) linkmeta.Meta
}

// JiraStateIndex answers from worktree's own cached Jira state — never a
// Jira search.
type JiraStateIndex interface {
	IssuesReferencingPR(ctx context.Context, prID string) ([]Item, error)
}

// Sources is what a Builder reads from. A nil source means "not configured".
type Sources struct {
	Jira      JiraSource
	PR        PRSource
	Slack     SlackSource
	Links     LinkResolver
	JiraState JiraStateIndex
}

func jiraItem(s wjira.IssueSummary, url string) Item {
	return Item{
		Type: "jira", ID: s.Key, URL: url, Resolved: true,
		Title: s.Summary, Status: s.Status, StatusCategory: s.StatusCategory,
		IssueType: s.IssueType, IssueTypeIconURL: s.IssueTypeIconURL,
	}
}
```

`internal/linked/classify.go`:

```go
package linked

import (
	"net/url"
	"regexp"
	"strings"

	"github.com/mturley/worktree/internal/resourceurl"
)

var (
	htmlCommentPattern = regexp.MustCompile(`(?s)<!--.*?-->`)
	mdImagePattern     = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	htmlImgPattern     = regexp.MustCompile(`(?i)<img\b[^>]*>`)
	// Brackets and quotes end a URL, so markdown "[x](url)", autolinks
	// "<url>" and parenthesised URLs all yield just the URL.
	mdURLPattern = regexp.MustCompile("https?://[^\\s<>()\\[\\]\"'`]+")
)

// ExtractMarkdownURLs returns the URLs in a GitHub-flavoured markdown body,
// in order, deduplicated. Images (markdown or <img>) and HTML comments —
// PR templates are full of commented-out guidance — are ignored. Trailing
// sentence punctuation is trimmed.
func ExtractMarkdownURLs(body string) []string {
	body = htmlCommentPattern.ReplaceAllString(body, "")
	body = mdImagePattern.ReplaceAllString(body, "")
	body = htmlImgPattern.ReplaceAllString(body, "")
	var out []string
	seen := map[string]bool{}
	for _, u := range mdURLPattern.FindAllString(body, -1) {
		u = strings.TrimRight(u, ".,;:!?")
		if u != "" && !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}
	return out
}

// Classify turns URLs into Items: PR / Jira / Slack thread via the shared
// resourceurl detector, anything else http(s) as a link. Items are
// deduplicated by (type, id) — so ".../pull/2" and ".../pull/2/files" are one
// row — and the resource itself (self) is dropped. Non-link items start
// unresolved; links are "resolved" from the start because a URL + domain is
// already a complete row (titles are an optional extra).
func Classify(urls []string, self Key) []Item {
	var out []Item
	seen := map[Key]bool{self: true}
	for _, raw := range urls {
		t, id, ok := resourceurl.InferAny(raw)
		if !ok {
			continue
		}
		k := Key{t, id}
		if seen[k] {
			continue
		}
		seen[k] = true
		it := Item{Type: t, ID: id, URL: raw}
		switch t {
		case "pr":
			// Canonical URL, so ".../pull/2/files" opens the PR itself.
			it.URL = canonicalPRURL(id, raw)
		case "link":
			it.URL = id
			it.Resolved = true
			if u, err := url.Parse(id); err == nil {
				it.Domain = u.Hostname()
			}
		}
		out = append(out, it)
	}
	return out
}

// canonicalPRURL rebuilds https://github.com/o/r/pull/N from "o/r#N".
func canonicalPRURL(id, fallback string) string {
	slash := strings.Index(id, "/")
	hash := strings.LastIndex(id, "#")
	if slash < 0 || hash < slash {
		return fallback
	}
	return "https://github.com/" + id[:hash] + "/pull/" + id[hash+1:]
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./internal/linked/ -v`
Expected: PASS. If the Slack id assertion fails, check `slackurl.ResourceID`'s ts format (`p1700000000000100` → `1700000000.000100`) and adjust the test's expected id to match the existing detector. Do not change the detector.

- [ ] **Step 5: Commit**

```bash
git add internal/linked/types.go internal/linked/classify.go internal/linked/classify_test.go
git commit --signoff -m "feat(linked): DTOs, source interfaces and URL classification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `internal/linked` — batch resolution

**Files:**
- Create: `internal/linked/resolve.go`
- Create: `internal/linked/fakes_test.go` (fake sources shared by later tests)
- Test: `internal/linked/resolve_test.go`

**Interfaces:**
- Consumes: Task 6 types.
- Produces:
  ```go
  type Builder struct { Src Sources; Now func() time.Time }
  const (MaxChildren = 50; MaxSlackResolutions = 20; MaxLinkResolutions = 20; resolveConcurrency = 4)
  func (b *Builder) resolve(ctx context.Context, items []Item, resolveLinks bool)
  func excerpt(s string, n int) string
  ```
  Test fakes: `fakeJira`, `fakePR`, `fakeSlack`, `fakeLinks`, `fakeState` (see code).

- [ ] **Step 1: Write the fakes and failing tests** — `internal/linked/fakes_test.go`:

```go
package linked

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/linkmeta"
)

type fakeJira struct {
	mu       sync.Mutex
	graphs   map[string]*wjira.LinkGraph
	issues   map[string]wjira.IssueSummary   // for "key in"/"key =" lookups
	children map[string][]wjira.IssueSummary // parent key → children
	failJQL  map[string]bool                 // exact JQL → error
	queries  []string
}

func (f *fakeJira) LinkGraph(_ context.Context, key string) (*wjira.LinkGraph, error) {
	if g, ok := f.graphs[key]; ok {
		return g, nil
	}
	return nil, fmt.Errorf("404 %s", key)
}

func (f *fakeJira) Search(_ context.Context, jql string, max int) ([]wjira.IssueSummary, bool, error) {
	f.mu.Lock()
	f.queries = append(f.queries, jql)
	f.mu.Unlock()
	if f.failJQL[jql] {
		return nil, false, errors.New("jql failed")
	}
	if strings.HasPrefix(jql, "parent = ") {
		key := strings.Fields(strings.TrimPrefix(jql, "parent = "))[0]
		kids := f.children[key]
		if len(kids) > max {
			return kids[:max], true, nil
		}
		return kids, false, nil
	}
	if strings.HasPrefix(jql, "key in (") {
		var out []wjira.IssueSummary
		for _, k := range strings.Split(strings.TrimSuffix(strings.TrimPrefix(jql, "key in ("), ")"), ",") {
			s, ok := f.issues[strings.TrimSpace(k)]
			if !ok {
				// Real Jira rejects the whole query for an unknown key.
				return nil, false, fmt.Errorf("key %s does not exist", k)
			}
			out = append(out, s)
		}
		return out, false, nil
	}
	if strings.HasPrefix(jql, "key = ") {
		if s, ok := f.issues[strings.TrimPrefix(jql, "key = ")]; ok {
			return []wjira.IssueSummary{s}, false, nil
		}
		return nil, false, errors.New("does not exist")
	}
	return nil, false, fmt.Errorf("unexpected jql %q", jql)
}

func (f *fakeJira) IssueURL(key string) string  { return "https://example.atlassian.net/browse/" + key }
func (f *fakeJira) SearchURL(jql string) string { return "https://example.atlassian.net/issues/?jql=" + jql }

type fakePR struct {
	prs map[wgithub.PRRef]wgithub.PRSummary
	err error
}

func (f *fakePR) Summaries(_ context.Context, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := map[wgithub.PRRef]wgithub.PRSummary{}
	for _, r := range refs {
		if s, ok := f.prs[r]; ok {
			out[r] = s
		}
	}
	return out, nil
}

type fakeSlack struct {
	threads  map[string]slack.Thread // "C:ts"
	channels map[string]string
	calls    int
	mu       sync.Mutex
}

func (f *fakeSlack) Thread(_ context.Context, ch, ts string) (slack.Thread, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	if t, ok := f.threads[ch+":"+ts]; ok {
		return t, nil
	}
	return slack.Thread{}, errors.New("thread_not_found")
}

func (f *fakeSlack) ChannelName(_ context.Context, id string) (string, error) {
	return f.channels[id], nil
}

type fakeLinks struct {
	meta  map[string]linkmeta.Meta
	calls int
	mu    sync.Mutex
}

func (f *fakeLinks) Resolve(_ context.Context, u string) linkmeta.Meta {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	return f.meta[u]
}

type fakeState struct {
	byPR map[string][]Item
	err  error
}

func (f *fakeState) IssuesReferencingPR(_ context.Context, prID string) ([]Item, error) {
	return f.byPR[prID], f.err
}
```

`internal/linked/resolve_test.go`:

```go
package linked

import (
	"context"
	"fmt"
	"testing"

	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/linkmeta"
)

func TestResolveFillsEachType(t *testing.T) {
	b := &Builder{Src: Sources{
		Jira: &fakeJira{issues: map[string]wjira.IssueSummary{
			"PROJ-9": {Key: "PROJ-9", Summary: "Nine", Status: "Review", IssueType: "Story"},
		}},
		PR: &fakePR{prs: map[wgithub.PRRef]wgithub.PRSummary{
			{Owner: "example", Repo: "repo", Number: 2}: {Title: "Two", State: "MERGED"},
		}},
		Slack: &fakeSlack{
			threads:  map[string]slack.Thread{"C0TEST:1700000000.000100": {Messages: []slack.Message{{Text: "  hello\n  world  "}}}},
			channels: map[string]string{"C0TEST": "general"},
		},
		Links: &fakeLinks{meta: map[string]linkmeta.Meta{"https://docs.example.com/a": {Title: "Doc A", Favicon: "https://docs.example.com/f.ico"}}},
	}}
	items := []Item{
		{Type: "pr", ID: "example/repo#2"},
		{Type: "jira", ID: "PROJ-9"},
		{Type: "slack", ID: "C0TEST:1700000000.000100"},
		{Type: "link", ID: "https://docs.example.com/a", Resolved: true},
	}
	b.resolve(context.Background(), items, true)
	if !items[0].Resolved || items[0].Title != "Two" || items[0].State != "MERGED" {
		t.Errorf("pr %+v", items[0])
	}
	if !items[1].Resolved || items[1].Title != "Nine" || items[1].Status != "Review" {
		t.Errorf("jira %+v", items[1])
	}
	if !items[2].Resolved || items[2].ChannelName != "general" || items[2].Excerpt != "hello world" {
		t.Errorf("slack %+v", items[2])
	}
	if items[3].Title != "Doc A" || items[3].Favicon == "" {
		t.Errorf("link %+v", items[3])
	}
}

func TestResolveBadJiraKeyDoesNotSinkBatch(t *testing.T) {
	fj := &fakeJira{issues: map[string]wjira.IssueSummary{"PROJ-1": {Key: "PROJ-1", Summary: "One"}}}
	b := &Builder{Src: Sources{Jira: fj}}
	items := []Item{{Type: "jira", ID: "PROJ-1"}, {Type: "jira", ID: "GONE-1"}}
	b.resolve(context.Background(), items, false)
	if !items[0].Resolved || items[0].Title != "One" {
		t.Errorf("good key must still resolve: %+v", items[0])
	}
	if items[1].Resolved {
		t.Errorf("bad key must be unresolved: %+v", items[1])
	}
}

func TestResolveLinksOnlyWhenAsked(t *testing.T) {
	fl := &fakeLinks{meta: map[string]linkmeta.Meta{}}
	b := &Builder{Src: Sources{Links: fl}}
	b.resolve(context.Background(), []Item{{Type: "link", ID: "https://x.example.com", Resolved: true}}, false)
	if fl.calls != 0 {
		t.Fatalf("resolveLinks=false made %d outbound resolutions", fl.calls)
	}
}

func TestResolveCaps(t *testing.T) {
	fs := &fakeSlack{threads: map[string]slack.Thread{}}
	fl := &fakeLinks{meta: map[string]linkmeta.Meta{}}
	b := &Builder{Src: Sources{Slack: fs, Links: fl}}
	var items []Item
	for i := 0; i < 30; i++ {
		items = append(items, Item{Type: "slack", ID: fmt.Sprintf("C0TEST:1700000000.%06d", i)})
		items = append(items, Item{Type: "link", ID: fmt.Sprintf("https://x.example.com/%d", i), Resolved: true})
	}
	b.resolve(context.Background(), items, true)
	if fs.calls != MaxSlackResolutions || fl.calls != MaxLinkResolutions {
		t.Fatalf("slack calls %d, link calls %d", fs.calls, fl.calls)
	}
}

func TestResolveNilSourcesLeaveItemsUnresolved(t *testing.T) {
	b := &Builder{}
	items := []Item{{Type: "pr", ID: "example/repo#2"}, {Type: "jira", ID: "PROJ-1"}, {Type: "slack", ID: "C0TEST:1.2"}}
	b.resolve(context.Background(), items, true)
	for _, it := range items {
		if it.Resolved {
			t.Errorf("%+v resolved with no source", it)
		}
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/linked/ -run Resolve -v`
Expected: FAIL — `undefined: Builder`.

- [ ] **Step 3: Implement** — `internal/linked/resolve.go`:

```go
package linked

import (
	"context"
	"strings"
	"sync"
	"time"

	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
)

const (
	MaxChildren         = 50
	MaxSlackResolutions = 20
	MaxLinkResolutions  = 20
	resolveConcurrency  = 4
	excerptRunes        = 100
)

// Builder assembles Results from Sources.
type Builder struct {
	Src Sources
	Now func() time.Time
}

func (b *Builder) now() time.Time {
	if b.Now != nil {
		return b.Now()
	}
	return time.Now()
}

// resolve enriches items in place, batching per source. Failures leave an
// item unresolved rather than failing the view: a linked issue you can't
// see is still worth listing.
func (b *Builder) resolve(ctx context.Context, items []Item, resolveLinks bool) {
	var jiraIdx, prIdx, slackIdx, linkIdx []int
	for i, it := range items {
		switch it.Type {
		case "jira":
			jiraIdx = append(jiraIdx, i)
		case "pr":
			prIdx = append(prIdx, i)
		case "slack":
			slackIdx = append(slackIdx, i)
		case "link":
			linkIdx = append(linkIdx, i)
		}
	}
	var wg sync.WaitGroup
	if b.Src.Jira != nil && len(jiraIdx) > 0 {
		wg.Add(1)
		go func() { defer wg.Done(); b.resolveJira(ctx, items, jiraIdx) }()
	}
	if b.Src.PR != nil && len(prIdx) > 0 {
		wg.Add(1)
		go func() { defer wg.Done(); b.resolvePRs(ctx, items, prIdx) }()
	}
	if b.Src.Slack != nil && len(slackIdx) > 0 {
		wg.Add(1)
		go func() { defer wg.Done(); b.resolveSlack(ctx, items, capIdx(slackIdx, MaxSlackResolutions)) }()
	}
	if resolveLinks && b.Src.Links != nil && len(linkIdx) > 0 {
		wg.Add(1)
		go func() { defer wg.Done(); b.resolveLinks(ctx, items, capIdx(linkIdx, MaxLinkResolutions)) }()
	}
	wg.Wait()
}

func capIdx(idx []int, n int) []int {
	if len(idx) > n {
		return idx[:n]
	}
	return idx
}

// forEachLimited runs fn over idx with at most resolveConcurrency in flight.
func forEachLimited(idx []int, fn func(i int)) {
	sem := make(chan struct{}, resolveConcurrency)
	var wg sync.WaitGroup
	for _, i := range idx {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			fn(i)
		}(i)
	}
	wg.Wait()
}

func (b *Builder) resolveJira(ctx context.Context, items []Item, idx []int) {
	keys := make([]string, len(idx))
	for n, i := range idx {
		keys[n] = items[i].ID
	}
	apply := func(found []wjira.IssueSummary) {
		byKey := map[string]wjira.IssueSummary{}
		for _, s := range found {
			byKey[s.Key] = s
		}
		for _, i := range idx {
			if s, ok := byKey[items[i].ID]; ok {
				url := items[i].URL
				if url == "" {
					url = b.Src.Jira.IssueURL(s.Key)
				}
				items[i] = jiraItem(s, url)
			}
		}
	}
	found, _, err := b.Src.Jira.Search(ctx, "key in ("+strings.Join(keys, ",")+")", len(keys))
	if err == nil {
		apply(found)
		return
	}
	// One unknown or invisible key fails the whole "key in" query, so fall
	// back to one search per key; bad keys just stay unresolved.
	var mu sync.Mutex
	var all []wjira.IssueSummary
	forEachLimited(idx, func(i int) {
		got, _, err := b.Src.Jira.Search(ctx, "key = "+items[i].ID, 1)
		if err == nil {
			mu.Lock()
			all = append(all, got...)
			mu.Unlock()
		}
	})
	apply(all)
}

func (b *Builder) resolvePRs(ctx context.Context, items []Item, idx []int) {
	refs := make([]wgithub.PRRef, 0, len(idx))
	refOf := map[int]wgithub.PRRef{}
	for _, i := range idx {
		ref, err := wgithub.ParsePRResourceID(items[i].ID)
		if err != nil {
			continue
		}
		refs = append(refs, ref)
		refOf[i] = ref
	}
	got, err := b.Src.PR.Summaries(ctx, refs)
	if err != nil {
		return
	}
	for i, ref := range refOf {
		if s, ok := got[ref]; ok {
			items[i].Resolved = true
			items[i].Title = s.Title
			items[i].State = s.State
			items[i].IsDraft = s.IsDraft
		}
	}
}

func (b *Builder) resolveSlack(ctx context.Context, items []Item, idx []int) {
	forEachLimited(idx, func(i int) {
		ch, ts, ok := strings.Cut(items[i].ID, ":")
		if !ok {
			return
		}
		th, err := b.Src.Slack.Thread(ctx, ch, ts)
		if err != nil || len(th.Messages) == 0 {
			return
		}
		name, _ := b.Src.Slack.ChannelName(ctx, ch)
		items[i].Resolved = true
		items[i].ChannelName = name
		items[i].Excerpt = excerpt(th.Messages[0].Text, excerptRunes)
	})
}

func (b *Builder) resolveLinks(ctx context.Context, items []Item, idx []int) {
	forEachLimited(idx, func(i int) {
		m := b.Src.Links.Resolve(ctx, items[i].URL)
		if m.Title != "" {
			items[i].Title = m.Title
		}
		items[i].Favicon = m.Favicon
	})
}

// excerpt collapses whitespace and truncates to n runes with an ellipsis.
func excerpt(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return strings.TrimSpace(string(r[:n-1])) + "…"
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./internal/linked/ -race -v`
Expected: PASS (including under `-race`).

- [ ] **Step 5: Commit**

```bash
git add internal/linked/resolve.go internal/linked/fakes_test.go internal/linked/resolve_test.go
git commit --signoff -m "feat(linked): batch-resolve linked PRs, issues, threads and links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `internal/linked` — Jira sections and hierarchy tree

**Files:**
- Create: `internal/linked/jira.go`
- Test: `internal/linked/jira_test.go`

**Interfaces:**
- Consumes: Tasks 6–7.
- Produces:
  ```go
  func (b *Builder) buildJira(ctx context.Context, key string, resolveLinks bool) ([]Section, error)
  func (b *Builder) Children(ctx context.Context, key string) ([]*TreeNode, *More, error)
  ```
  Section kinds/titles: `git_pr` "Git Pull Request", `description` "Linked in description", `hierarchy` "Hierarchy", `links` "Linked work items".

- [ ] **Step 1: Write the failing tests** — `internal/linked/jira_test.go`:

```go
package linked

import (
	"context"
	"testing"

	wjira "github.com/mturley/watcher/jira"
)

func sum(key, typ string, level int) wjira.IssueSummary {
	return wjira.IssueSummary{Key: key, Summary: "S " + key, Status: "New", IssueType: typ, HierarchyLevel: level}
}

func storyFixture() *fakeJira {
	return &fakeJira{
		graphs: map[string]*wjira.LinkGraph{
			"PROJ-1": {
				Issue:     sum("PROJ-1", "Story", 0),
				Ancestors: []wjira.IssueSummary{sum("PROJ-10", "Epic", 1), sum("FEAT-1", "Feature", 2)},
				Subtasks:  []wjira.IssueSummary{sum("PROJ-2", "Sub-task", -1)},
				Links: []wjira.IssueLink{
					{Label: "blocks", Issue: sum("PROJ-3", "Bug", 0)},
					{Label: "clones", Issue: sum("PROJ-4", "Story", 0)},
					{Label: "blocks", Issue: sum("PROJ-5", "Task", 0)},
				},
				DescriptionURLs: []string{"https://example.atlassian.net/browse/PROJ-9", "https://example.atlassian.net/browse/PROJ-1"},
				GitPRURLs:       []string{},
			},
		},
		issues: map[string]wjira.IssueSummary{"PROJ-9": sum("PROJ-9", "Story", 0)},
		children: map[string][]wjira.IssueSummary{
			"PROJ-1":  {sum("PROJ-2", "Sub-task", -1)},
			"PROJ-10": {sum("PROJ-0", "Story", 0), sum("PROJ-1", "Story", 0), sum("PROJ-7", "Story", 0)},
			"FEAT-1":  {sum("PROJ-8", "Epic", 1), sum("PROJ-10", "Epic", 1)},
		},
	}
}

func section(t *testing.T, ss []Section, kind string) *Section {
	t.Helper()
	for i := range ss {
		if ss[i].Kind == kind {
			return &ss[i]
		}
	}
	return nil
}

func TestBuildJiraSections(t *testing.T) {
	b := &Builder{Src: Sources{Jira: storyFixture()}}
	ss, err := b.buildJira(context.Background(), "PROJ-1", false)
	if err != nil {
		t.Fatal(err)
	}
	if section(t, ss, "git_pr") != nil {
		t.Error("empty Git PR field must omit the section")
	}
	d := section(t, ss, "description")
	if d == nil || len(d.Items) != 1 || d.Items[0].ID != "PROJ-9" || !d.Items[0].Resolved {
		t.Errorf("description = %+v (self link must be dropped)", d)
	}
	l := section(t, ss, "links")
	if l == nil || len(l.Groups) != 2 || l.Groups[0].Label != "blocks" || len(l.Groups[0].Items) != 2 || l.Groups[1].Label != "clones" {
		t.Errorf("links = %+v", l)
	}
	if l.Groups[0].Items[0].URL != "https://example.atlassian.net/browse/PROJ-3" {
		t.Errorf("link url = %q", l.Groups[0].Items[0].URL)
	}
}

func TestBuildJiraHierarchy(t *testing.T) {
	b := &Builder{Src: Sources{Jira: storyFixture()}}
	ss, _ := b.buildJira(context.Background(), "PROJ-1", false)
	h := section(t, ss, "hierarchy")
	if h == nil || len(h.Tree) != 1 {
		t.Fatalf("hierarchy = %+v", h)
	}
	feat := h.Tree[0]
	if feat.ID != "FEAT-1" || !feat.Expanded || len(feat.Children) != 2 {
		t.Fatalf("root = %+v", feat)
	}
	other, epic := feat.Children[0], feat.Children[1]
	if other.ID != "PROJ-8" || other.Expanded || other.HasChildren != nil {
		t.Errorf("sibling epic should be collapsed/unknown: %+v", other)
	}
	if epic.ID != "PROJ-10" || !epic.Expanded || len(epic.Children) != 3 {
		t.Fatalf("epic = %+v", epic)
	}
	cur := epic.Children[1]
	if cur.ID != "PROJ-1" || !cur.Current || !cur.Expanded || len(cur.Children) != 1 || cur.Children[0].ID != "PROJ-2" {
		t.Errorf("current = %+v", cur)
	}
	if cur.Children[0].HasChildren == nil || *cur.Children[0].HasChildren {
		t.Errorf("a sub-task has no children: %+v", cur.Children[0])
	}
	if epic.Children[0].Current || epic.Children[2].Current {
		t.Error("only one node is current")
	}
}

func TestBuildJiraHierarchyNoParent(t *testing.T) {
	fj := &fakeJira{graphs: map[string]*wjira.LinkGraph{"PROJ-1": {Issue: sum("PROJ-1", "Task", 0)}},
		children: map[string][]wjira.IssueSummary{}}
	b := &Builder{Src: Sources{Jira: fj}}
	ss, _ := b.buildJira(context.Background(), "PROJ-1", false)
	h := section(t, ss, "hierarchy")
	if len(h.Tree) != 1 || !h.Tree[0].Current || h.Tree[0].HasChildren == nil || *h.Tree[0].HasChildren {
		t.Errorf("tree = %+v", h.Tree[0])
	}
}

func TestBuildJiraHierarchySearchErrorKeepsPath(t *testing.T) {
	fj := storyFixture()
	fj.failJQL = map[string]bool{"parent = PROJ-10 ORDER BY key ASC": true}
	b := &Builder{Src: Sources{Jira: fj}}
	ss, _ := b.buildJira(context.Background(), "PROJ-1", false)
	h := section(t, ss, "hierarchy")
	if h.Error == "" {
		t.Error("a failed sibling search must surface as a section error")
	}
	epic := h.Tree[0].Children[1]
	if len(epic.Children) != 1 || epic.Children[0].ID != "PROJ-1" {
		t.Errorf("path must still render: %+v", epic.Children)
	}
}

func TestBuildJiraChildrenCap(t *testing.T) {
	fj := storyFixture()
	var many []wjira.IssueSummary
	for i := 0; i < MaxChildren+5; i++ {
		many = append(many, sum("KID-"+string(rune('A'+i%26))+string(rune('a'+i/26)), "Story", 0))
	}
	fj.children["PROJ-10"] = append([]wjira.IssueSummary{sum("PROJ-1", "Story", 0)}, many...)
	b := &Builder{Src: Sources{Jira: fj}}
	ss, _ := b.buildJira(context.Background(), "PROJ-1", false)
	epic := section(t, ss, "hierarchy").Tree[0].Children[1]
	if epic.More == nil || epic.More.URL == "" {
		t.Errorf("capped node needs a More link: %+v", epic.More)
	}
	if len(epic.Children) != MaxChildren {
		t.Errorf("children = %d", len(epic.Children))
	}
}

func TestChildren(t *testing.T) {
	b := &Builder{Src: Sources{Jira: storyFixture()}}
	kids, more, err := b.Children(context.Background(), "FEAT-1")
	if err != nil || more != nil || len(kids) != 2 || kids[0].ID != "PROJ-8" || kids[0].URL == "" {
		t.Fatalf("kids=%+v more=%v err=%v", kids, more, err)
	}
}

func TestBuildJiraGraphErrorIsFatal(t *testing.T) {
	b := &Builder{Src: Sources{Jira: &fakeJira{}}}
	if _, err := b.buildJira(context.Background(), "NOPE-1", false); err == nil {
		t.Fatal("want error")
	}
	if _, err := (&Builder{}).buildJira(context.Background(), "PROJ-1", false); err != ErrNotConfigured {
		t.Fatalf("want ErrNotConfigured, got %v", err)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/linked/ -run 'BuildJira|Children' -v`
Expected: FAIL — undefined `buildJira`.

- [ ] **Step 3: Implement** — `internal/linked/jira.go`:

```go
package linked

import (
	"context"
	"sync"

	wjira "github.com/mturley/watcher/jira"
)

func childrenJQL(key string) string { return "parent = " + key + " ORDER BY key ASC" }

func boolPtr(b bool) *bool { return &b }

// unknownChildren: sub-tasks can't have children; anything else might.
func unknownChildren(s wjira.IssueSummary) *bool {
	if s.HierarchyLevel < 0 {
		return boolPtr(false)
	}
	return nil
}

func (b *Builder) node(s wjira.IssueSummary) *TreeNode {
	return &TreeNode{Item: jiraItem(s, b.Src.Jira.IssueURL(s.Key)), HasChildren: unknownChildren(s)}
}

func (b *Builder) buildJira(ctx context.Context, key string, resolveLinks bool) ([]Section, error) {
	if b.Src.Jira == nil {
		return nil, ErrNotConfigured
	}
	g, err := b.Src.Jira.LinkGraph(ctx, key)
	if err != nil {
		return nil, err
	}
	self := Key{"jira", g.Issue.Key}
	var sections []Section

	gitPR := Classify(g.GitPRURLs, self)
	desc := Classify(g.DescriptionURLs, self)
	// One resolve pass over both, so linked keys are batched together.
	all := append(append([]Item{}, gitPR...), desc...)
	b.resolve(ctx, all, resolveLinks)
	gitPR, desc = all[:len(gitPR)], all[len(gitPR):]

	if len(gitPR) > 0 {
		sections = append(sections, Section{Kind: "git_pr", Title: "Git Pull Request", Items: gitPR})
	}
	sections = append(sections, Section{Kind: "description", Title: "Linked in description", Items: desc})
	sections = append(sections, b.hierarchy(ctx, g))
	sections = append(sections, b.linkGroups(g))
	return sections, nil
}

func (b *Builder) linkGroups(g *wjira.LinkGraph) Section {
	s := Section{Kind: "links", Title: "Linked work items"}
	pos := map[string]int{}
	for _, l := range g.Links {
		i, ok := pos[l.Label]
		if !ok {
			i = len(s.Groups)
			pos[l.Label] = i
			s.Groups = append(s.Groups, Group{Label: l.Label})
		}
		s.Groups[i].Items = append(s.Groups[i].Items, jiraItem(l.Issue, b.Src.Jira.IssueURL(l.Issue.Key)))
	}
	return s
}

type childResult struct {
	kids []wjira.IssueSummary
	more bool
	err  error
}

// hierarchy builds: root ancestor → … → parent → [siblings incl. current] →
// current's children. Every ancestor on the path is expanded with ALL its
// children listed (other branches collapsed, lazily expandable). Searches
// run concurrently; a failed one keeps the path and sets the section error.
func (b *Builder) hierarchy(ctx context.Context, g *wjira.LinkGraph) Section {
	sec := Section{Kind: "hierarchy", Title: "Hierarchy"}

	// parentKeys[0] is the current issue; then each ancestor.
	parentKeys := []string{g.Issue.Key}
	for _, a := range g.Ancestors {
		parentKeys = append(parentKeys, a.Key)
	}
	results := make([]childResult, len(parentKeys))
	var wg sync.WaitGroup
	for i, k := range parentKeys {
		wg.Add(1)
		go func(i int, k string) {
			defer wg.Done()
			kids, more, err := b.Src.Jira.Search(ctx, childrenJQL(k), MaxChildren)
			results[i] = childResult{kids, more, err}
		}(i, k)
	}
	wg.Wait()

	// The current issue and its children (search results ∪ subtasks).
	cur := b.node(g.Issue)
	cur.Current, cur.Expanded = true, true
	seen := map[string]bool{}
	addKid := func(s wjira.IssueSummary) {
		if !seen[s.Key] {
			seen[s.Key] = true
			cur.Children = append(cur.Children, b.node(s))
		}
	}
	if results[0].err != nil {
		sec.Error = "Couldn't load child issues: " + results[0].err.Error()
	} else {
		for _, s := range results[0].kids {
			addKid(s)
		}
		if results[0].more {
			cur.More = &More{URL: b.Src.Jira.SearchURL(childrenJQL(g.Issue.Key))}
		}
	}
	for _, s := range g.Subtasks {
		addKid(s)
	}
	cur.HasChildren = boolPtr(len(cur.Children) > 0)

	// Walk upward, wrapping the path node in each ancestor.
	path := cur
	for i, a := range g.Ancestors {
		anc := b.node(a)
		anc.Expanded = true
		r := results[i+1]
		placed := false
		if r.err != nil {
			if sec.Error == "" {
				sec.Error = "Couldn't load some of the hierarchy: " + r.err.Error()
			}
		} else {
			for _, s := range r.kids {
				if s.Key == path.ID {
					anc.Children = append(anc.Children, path)
					placed = true
				} else {
					anc.Children = append(anc.Children, b.node(s))
				}
			}
			if r.more {
				anc.More = &More{URL: b.Src.Jira.SearchURL(childrenJQL(a.Key))}
			}
		}
		if !placed {
			// Capped out of, or missing from, the search: the path must show.
			anc.Children = append(anc.Children, path)
		}
		anc.HasChildren = boolPtr(true)
		path = anc
	}
	sec.Tree = []*TreeNode{path}
	return sec
}

// Children lists an issue's children for a lazily expanded tree node.
func (b *Builder) Children(ctx context.Context, key string) ([]*TreeNode, *More, error) {
	if b.Src.Jira == nil {
		return nil, nil, ErrNotConfigured
	}
	kids, more, err := b.Src.Jira.Search(ctx, childrenJQL(key), MaxChildren)
	if err != nil {
		return nil, nil, err
	}
	out := make([]*TreeNode, 0, len(kids))
	for _, s := range kids {
		out = append(out, b.node(s))
	}
	var m *More
	if more {
		m = &More{URL: b.Src.Jira.SearchURL(childrenJQL(key))}
	}
	return out, m, nil
}
```

Note: in `TestBuildJiraChildrenCap`, PROJ-1 is first among >50 children so it is within the cap; the `!placed` branch is covered by `TestBuildJiraHierarchySearchErrorKeepsPath`.

- [ ] **Step 4: Run tests**

Run: `go test ./internal/linked/ -race -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/linked/jira.go internal/linked/jira_test.go
git commit --signoff -m "feat(linked): Jira sections and hierarchy tree

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `internal/linked` — PR and Slack sections, `Build` entry point, count

**Files:**
- Create: `internal/linked/pr.go`, `internal/linked/slack.go`, `internal/linked/builder.go`
- Test: `internal/linked/builder_test.go`

**Interfaces:**
- Consumes: Tasks 6–8; `slack.ExtractURLs` (watcher v0.11.0).
- Produces: `func (b *Builder) Build(ctx context.Context, resType, id string, resolveLinks bool) (*Result, error)` — `resType` ∈ `pr|jira|slack`, otherwise `error` (`ErrUnsupportedType`). `var ErrUnsupportedType`.

- [ ] **Step 1: Write the failing tests** — `internal/linked/builder_test.go`:

```go
package linked

import (
	"context"
	"errors"
	"testing"
	"time"

	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/watcher/slack"
)

var fixedNow = func() time.Time { return time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC) }

func TestBuildPR(t *testing.T) {
	ref := wgithub.PRRef{Owner: "example", Repo: "repo", Number: 1}
	b := &Builder{Now: fixedNow, Src: Sources{
		PR: &fakePR{prs: map[wgithub.PRRef]wgithub.PRSummary{
			ref: {Title: "Me", URL: "https://github.com/example/repo/pull/1",
				Body: "Fixes https://example.atlassian.net/browse/PROJ-9 and https://github.com/example/repo/pull/1 (self)"},
		}},
		Jira: &fakeJira{issues: map[string]wjira.IssueSummary{"PROJ-9": sum("PROJ-9", "Story", 0)}},
		JiraState: &fakeState{byPR: map[string][]Item{"example/repo#1": {{Type: "jira", ID: "PROJ-7", Resolved: true}}}},
	}}
	r, err := b.Build(context.Background(), "pr", "example/repo#1", false)
	if err != nil {
		t.Fatal(err)
	}
	if r.FetchedAt != "2026-10-09T12:00:00Z" {
		t.Errorf("fetched_at %q", r.FetchedAt)
	}
	d := section(t, r.Sections, "description")
	if d == nil || len(d.Items) != 1 || d.Items[0].ID != "PROJ-9" || !d.Items[0].Resolved {
		t.Errorf("description %+v", d)
	}
	rb := section(t, r.Sections, "referenced_by")
	if rb == nil || rb.Title != "Referenced by Jira" || len(rb.Items) != 1 {
		t.Errorf("referenced_by %+v", rb)
	}
	if r.Count != 2 {
		t.Errorf("count = %d", r.Count)
	}
}

func TestBuildPRNoReverseHitsOmitsSection(t *testing.T) {
	ref := wgithub.PRRef{Owner: "example", Repo: "repo", Number: 1}
	b := &Builder{Src: Sources{PR: &fakePR{prs: map[wgithub.PRRef]wgithub.PRSummary{ref: {}}}, JiraState: &fakeState{}}}
	r, _ := b.Build(context.Background(), "pr", "example/repo#1", false)
	if section(t, r.Sections, "referenced_by") != nil {
		t.Error("empty reverse lookup must be omitted")
	}
}

func TestBuildPRErrors(t *testing.T) {
	if _, err := (&Builder{}).Build(context.Background(), "pr", "example/repo#1", false); !errors.Is(err, ErrNotConfigured) {
		t.Errorf("no PR source: %v", err)
	}
	b := &Builder{Src: Sources{PR: &fakePR{prs: map[wgithub.PRRef]wgithub.PRSummary{}}}}
	if _, err := b.Build(context.Background(), "pr", "example/repo#1", false); err == nil {
		t.Error("missing PR must error")
	}
	if _, err := b.Build(context.Background(), "link", "x", false); !errors.Is(err, ErrUnsupportedType) {
		t.Errorf("link: %v", err)
	}
}

func TestBuildSlack(t *testing.T) {
	b := &Builder{Src: Sources{Slack: &fakeSlack{threads: map[string]slack.Thread{
		"C0TEST:1700000000.000100": {Messages: []slack.Message{
			{Text: "<https://github.com/example/repo/pull/3>"},
			{Text: "<https://example.slack.com/archives/C0TEST/p1700000000000100> and <https://docs.example.com/x>"},
		}},
	}}}}
	r, err := b.Build(context.Background(), "slack", "C0TEST:1700000000.000100", false)
	if err != nil {
		t.Fatal(err)
	}
	s := section(t, r.Sections, "thread")
	if s == nil || s.Title != "Linked in thread" || len(s.Items) != 2 {
		t.Fatalf("thread section %+v (self thread link must be dropped)", s)
	}
	if s.Items[0].Type != "pr" || s.Items[1].Type != "link" {
		t.Errorf("order/types %+v", s.Items)
	}
}

func TestCountExcludesCurrentAndDedupes(t *testing.T) {
	b := &Builder{Src: Sources{Jira: storyFixture()}}
	r, err := b.Build(context.Background(), "jira", "PROJ-1", false)
	if err != nil {
		t.Fatal(err)
	}
	// description PROJ-9; links PROJ-3,4,5; tree FEAT-1, PROJ-8, PROJ-10, PROJ-0, PROJ-7, PROJ-2
	if r.Count != 10 {
		t.Errorf("count = %d", r.Count)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/linked/ -run 'Build|Count' -v`
Expected: FAIL — undefined `Build`.

- [ ] **Step 3: Implement** — `internal/linked/pr.go`:

```go
package linked

import (
	"context"
	"fmt"

	wgithub "github.com/mturley/watcher/github"
)

func (b *Builder) buildPR(ctx context.Context, id string, resolveLinks bool) ([]Section, error) {
	if b.Src.PR == nil {
		return nil, ErrNotConfigured
	}
	ref, err := wgithub.ParsePRResourceID(id)
	if err != nil {
		return nil, err
	}
	got, err := b.Src.PR.Summaries(ctx, []wgithub.PRRef{ref})
	if err != nil {
		return nil, err
	}
	pr, ok := got[ref]
	if !ok {
		return nil, fmt.Errorf("pull request %s not found", id)
	}
	desc := Classify(ExtractMarkdownURLs(pr.Body), Key{"pr", id})
	b.resolve(ctx, desc, resolveLinks)
	sections := []Section{{Kind: "description", Title: "Linked in description", Items: desc}}

	if b.Src.JiraState != nil {
		refs, err := b.Src.JiraState.IssuesReferencingPR(ctx, id)
		switch {
		case err != nil:
			sections = append(sections, Section{Kind: "referenced_by", Title: "Referenced by Jira", Error: err.Error()})
		case len(refs) > 0:
			sections = append(sections, Section{Kind: "referenced_by", Title: "Referenced by Jira", Items: refs})
		}
	}
	return sections, nil
}
```

`internal/linked/slack.go`:

```go
package linked

import (
	"context"
	"fmt"
	"strings"

	"github.com/mturley/watcher/slack"
)

func (b *Builder) buildSlack(ctx context.Context, id string, resolveLinks bool) ([]Section, error) {
	if b.Src.Slack == nil {
		return nil, ErrNotConfigured
	}
	ch, ts, ok := strings.Cut(id, ":")
	if !ok {
		return nil, fmt.Errorf("invalid slack thread id %q", id)
	}
	th, err := b.Src.Slack.Thread(ctx, ch, ts)
	if err != nil {
		return nil, err
	}
	var urls []string
	for _, m := range th.Messages {
		urls = append(urls, slack.ExtractURLs(m)...)
	}
	items := Classify(urls, Key{"slack", id})
	b.resolve(ctx, items, resolveLinks)
	return []Section{{Kind: "thread", Title: "Linked in thread", Items: items}}, nil
}
```

`internal/linked/builder.go`:

```go
package linked

import (
	"context"
	"errors"
	"time"
)

// ErrUnsupportedType: only PRs, Jira issues and Slack threads have links.
var ErrUnsupportedType = errors.New("linked resources are only available for pr, jira and slack")

// Build assembles the Linked Resources view for one resource. resolveLinks
// gates outbound fetches of arbitrary pages (plain-link titles); it is only
// set once the user opens the tab.
func (b *Builder) Build(ctx context.Context, resType, id string, resolveLinks bool) (*Result, error) {
	var sections []Section
	var err error
	switch resType {
	case "jira":
		sections, err = b.buildJira(ctx, id, resolveLinks)
	case "pr":
		sections, err = b.buildPR(ctx, id, resolveLinks)
	case "slack":
		sections, err = b.buildSlack(ctx, id, resolveLinks)
	default:
		return nil, ErrUnsupportedType
	}
	if err != nil {
		return nil, err
	}
	return &Result{
		FetchedAt: b.now().UTC().Format(time.RFC3339),
		Count:     count(sections),
		Sections:  sections,
	}, nil
}

// count is the number of distinct linked resources across every section,
// excluding the current issue in the hierarchy.
func count(sections []Section) int {
	seen := map[Key]bool{}
	add := func(it Item) { seen[Key{it.Type, it.ID}] = true }
	var walk func(n *TreeNode)
	walk = func(n *TreeNode) {
		if !n.Current {
			add(n.Item)
		}
		for _, c := range n.Children {
			walk(c)
		}
	}
	for _, s := range sections {
		for _, it := range s.Items {
			add(it)
		}
		for _, g := range s.Groups {
			for _, it := range g.Items {
				add(it)
			}
		}
		for _, n := range s.Tree {
			walk(n)
		}
	}
	return len(seen)
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./internal/linked/ -race -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/linked/pr.go internal/linked/slack.go internal/linked/builder.go internal/linked/builder_test.go
git commit --signoff -m "feat(linked): PR and Slack sections, Build entry point and count

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: webui — adapters, cache, `/api/linked-resources` routes

**Files:**
- Create: `internal/webui/linked_api.go`
- Test: `internal/webui/linked_api_test.go`
- Modify: `internal/webui/server.go` (route table ~line 164; new Server fields)

**Interfaces:**
- Consumes: `linked.Builder`, `linked.Sources`, `linked.ErrNotConfigured`, `linked.ErrUnsupportedType`; watcher `wjira.Client`, `wgithub.FetchPRSummaries`; `s.SlackClient`, `s.channelName`, `s.linkResolver()`; `wtjira.ConfiguredCustomFields`.
- Produces:
  - `GET /api/linked-resources?type=&id=[&resolve_links=1][&refresh=1]` → `linked.Result` JSON; 400 bad params / unsupported type; 503 `linked.ErrNotConfigured`; 502 other errors (`{"error": "..."}`).
  - `GET /api/linked-resources/children?key=` → `{"items": TreeNode[], "more": More|null}`; 400 invalid key.
  - Server field `LinkedSources func() linked.Sources` (test seam; nil → real sources).

- [ ] **Step 1: Write the failing tests** — `internal/webui/linked_api_test.go`:

```go
package webui

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/worktree/internal/linked"
)

type stubPR struct{ calls int }

func (s *stubPR) Summaries(_ context.Context, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
	s.calls++
	out := map[wgithub.PRRef]wgithub.PRSummary{}
	for _, r := range refs {
		out[r] = wgithub.PRSummary{Title: "T", Body: "https://docs.example.com/a"}
	}
	return out, nil
}

type stubJira struct{}

func (stubJira) LinkGraph(context.Context, string) (*wjira.LinkGraph, error) { return nil, nil }
func (stubJira) Search(_ context.Context, jql string, _ int) ([]wjira.IssueSummary, bool, error) {
	return []wjira.IssueSummary{{Key: "PROJ-2", Summary: "kid"}}, true, nil
}
func (stubJira) IssueURL(k string) string    { return "https://example.atlassian.net/browse/" + k }
func (stubJira) SearchURL(q string) string   { return "https://example.atlassian.net/issues/?jql=" + q }

func getJSON(t *testing.T, h http.Handler, url string, into interface{}) int {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", url, nil))
	if into != nil && rec.Code == 200 {
		if err := json.Unmarshal(rec.Body.Bytes(), into); err != nil {
			t.Fatal(err)
		}
	}
	return rec.Code
}

func TestLinkedResourcesCachesAndRefreshes(t *testing.T) {
	pr := &stubPR{}
	s := &Server{LinkedSources: func() linked.Sources { return linked.Sources{PR: pr} }}
	h := s.Handler()
	var r linked.Result
	if code := getJSON(t, h, "/api/linked-resources?type=pr&id=example/repo%231", &r); code != 200 {
		t.Fatalf("code %d", code)
	}
	if len(r.Sections) == 0 || r.Count != 1 {
		t.Fatalf("result %+v", r)
	}
	getJSON(t, h, "/api/linked-resources?type=pr&id=example/repo%231", nil)
	if pr.calls != 1 {
		t.Errorf("second request must hit the cache; calls=%d", pr.calls)
	}
	getJSON(t, h, "/api/linked-resources?type=pr&id=example/repo%231&resolve_links=1", nil)
	if pr.calls != 2 {
		t.Errorf("resolve_links is a separate cache entry; calls=%d", pr.calls)
	}
	getJSON(t, h, "/api/linked-resources?type=pr&id=example/repo%231&refresh=1", nil)
	if pr.calls != 3 {
		t.Errorf("refresh must bypass the cache; calls=%d", pr.calls)
	}
}

func TestLinkedResourcesErrors(t *testing.T) {
	s := &Server{LinkedSources: func() linked.Sources { return linked.Sources{} }}
	h := s.Handler()
	cases := map[string]int{
		"/api/linked-resources?type=pr":                    400,
		"/api/linked-resources?type=link&id=https://x.com": 400,
		"/api/linked-resources?type=pr&id=example/repo%231": 503,
		"/api/linked-resources/children?key=not%20a%20key":  400,
		"/api/linked-resources/children?key=PROJ-1":         503,
	}
	for url, want := range cases {
		if got := getJSON(t, h, url, nil); got != want {
			t.Errorf("%s: got %d want %d", url, got, want)
		}
	}
}

func TestLinkedChildren(t *testing.T) {
	s := &Server{LinkedSources: func() linked.Sources { return linked.Sources{Jira: stubJira{}} }}
	var body struct {
		Items []linked.TreeNode `json:"items"`
		More  *linked.More      `json:"more"`
	}
	if code := getJSON(t, s.Handler(), "/api/linked-resources/children?key=PROJ-1", &body); code != 200 {
		t.Fatalf("code %d", code)
	}
	if len(body.Items) != 1 || body.Items[0].ID != "PROJ-2" || body.More == nil {
		t.Errorf("body %+v", body)
	}
}

func TestJiraStateIndexFindsReferencingIssues(t *testing.T) {
	db := openTestDB(t) // existing helper in this package's tests; see Step 3 note
	_, err := db.Exec(`INSERT INTO watcher_resource_state (resource_type, resource_id, state_json, resource_updated_at, watcher_updated_at) VALUES
		('jira','PROJ-1','{"summary":"One","status":"Review","issue_type":"Story","git_pull_request_urls":["https://github.com/example/repo/pull/1/files"]}','x','x'),
		('jira','PROJ-2','{"summary":"Two","git_pull_request_urls":["https://github.com/example/repo/pull/2"]}','x','x'),
		('jira','PROJ-3','{"summary":"Three"}','x','x')`)
	if err != nil {
		t.Fatal(err)
	}
	idx := jiraStateIndex{db: db, issueURL: func(k string) string { return "https://example.atlassian.net/browse/" + k }}
	got, err := idx.IssuesReferencingPR(context.Background(), "example/repo#1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "PROJ-1" || got[0].Title != "One" || got[0].Status != "Review" || !got[0].Resolved {
		t.Errorf("got %+v", got)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/webui/ -run 'Linked|JiraStateIndex' -v`
Expected: FAIL — `unknown field LinkedSources`.

- [ ] **Step 3: Implement**

First find the existing in-package DB test helper: `grep -n "func .*\*sql.DB" internal/webui/*_test.go | head`. Use whatever helper opens a migrated temp worktree DB (rename `openTestDB` in the test above to it). If none exists, add to `linked_api_test.go`:

```go
func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := wdb.Open(filepath.Join(t.TempDir(), "w.db")) // internal/db; check its exported open/migrate func name
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}
```

In `internal/webui/server.go`, add to `Server` (next to `LinkResolver`):

```go
	// LinkedSources is a seam for tests; nil means real sources built from
	// the watcher config on each request (see linked_api.go).
	LinkedSources func() linked.Sources

	// linkedCache fronts /api/linked-resources; lazily built.
	linkedOnce  sync.Once
	linkedCache *ttlCache
```

and to the route table:

```go
		{"GET /api/linked-resources", s.handleLinkedResources},
		{"GET /api/linked-resources/children", s.handleLinkedChildren},
```

`internal/webui/linked_api.go`:

```go
package webui

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sync"
	"time"

	wconfig "github.com/mturley/watcher/config"
	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/watcher/slack"
	wtjira "github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/linked"
	"github.com/mturley/worktree/internal/linkmeta"
	"github.com/mturley/worktree/internal/resourceurl"
)

const (
	linkedTTL   = 2 * time.Minute
	linkMetaTTL = 30 * time.Minute
)

// ttlCache is a small TTL map with per-key single-flight: concurrent misses
// for the same key share one computation.
type ttlCache struct {
	mu       sync.Mutex
	entries  map[string]ttlEntry
	inflight map[string]*ttlCall
}

type ttlEntry struct {
	val     interface{}
	expires time.Time
}

type ttlCall struct {
	wg  sync.WaitGroup
	val interface{}
	err error
}

func newTTLCache() *ttlCache {
	return &ttlCache{entries: map[string]ttlEntry{}, inflight: map[string]*ttlCall{}}
}

// get returns the cached value for key, or computes it with fn. bypass
// skips the read but still stores the fresh value. Errors are not cached.
func (c *ttlCache) get(key string, ttl time.Duration, bypass bool, fn func() (interface{}, error)) (interface{}, error) {
	c.mu.Lock()
	if e, ok := c.entries[key]; ok && !bypass && time.Now().Before(e.expires) {
		c.mu.Unlock()
		return e.val, nil
	}
	if call, ok := c.inflight[key]; ok && !bypass {
		c.mu.Unlock()
		call.wg.Wait()
		return call.val, call.err
	}
	call := &ttlCall{}
	call.wg.Add(1)
	c.inflight[key] = call
	c.mu.Unlock()

	call.val, call.err = fn()
	call.wg.Done()

	c.mu.Lock()
	delete(c.inflight, key)
	if call.err == nil {
		c.entries[key] = ttlEntry{val: call.val, expires: time.Now().Add(ttl)}
	}
	c.mu.Unlock()
	return call.val, call.err
}

func (s *Server) linkedCacheOrInit() *ttlCache {
	s.linkedOnce.Do(func() { s.linkedCache = newTTLCache() })
	return s.linkedCache
}

// --- adapters from real clients to linked.Sources ---

type jiraAdapter struct {
	c       *wjira.Client
	host    string
	gitPRID string
}

func (a jiraAdapter) LinkGraph(_ context.Context, key string) (*wjira.LinkGraph, error) {
	return a.c.FetchLinkGraph(key, a.gitPRID)
}
func (a jiraAdapter) Search(_ context.Context, jql string, max int) ([]wjira.IssueSummary, bool, error) {
	return a.c.SearchSummaries(jql, max)
}
func (a jiraAdapter) IssueURL(key string) string { return wtjira.IssueURL(a.host, key) }
func (a jiraAdapter) SearchURL(jql string) string {
	return jiraBase(a.host) + "/issues/?jql=" + url.QueryEscape(jql)
}

// jiraBase is the configured Jira host as an origin.
func jiraBase(host string) string {
	u := wtjira.IssueURL(host, "X")
	return u[:len(u)-len("/browse/X")]
}

type prAdapter struct{ token string }

func (a prAdapter) Summaries(_ context.Context, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
	return wgithub.FetchPRSummaries(a.token, refs)
}

type slackAdapter struct{ s *Server }

func (a slackAdapter) Thread(ctx context.Context, ch, ts string) (slack.Thread, error) {
	return a.s.SlackClient.Replies(ctx, ch, ts)
}
func (a slackAdapter) ChannelName(ctx context.Context, id string) (string, error) {
	return a.s.channelName(ctx, id)
}

// cachedLinkResolver memoises linkmeta per URL for linkMetaTTL.
type cachedLinkResolver struct {
	r     *linkmeta.Resolver
	cache *ttlCache
}

func (c cachedLinkResolver) Resolve(ctx context.Context, u string) linkmeta.Meta {
	v, _ := c.cache.get("meta|"+u, linkMetaTTL, false, func() (interface{}, error) {
		return c.r.Resolve(ctx, u), nil
	})
	m, _ := v.(linkmeta.Meta)
	return m
}

// jiraStateIndex answers "which Jira issues name this PR in their Git Pull
// Request field?" from worktree's own cached state — deliberately no Jira
// search, which would be expensive.
type jiraStateIndex struct {
	db       *sql.DB
	issueURL func(string) string
}

func (j jiraStateIndex) IssuesReferencingPR(ctx context.Context, prID string) ([]linked.Item, error) {
	rows, err := j.db.QueryContext(ctx, `SELECT resource_id, state_json FROM watcher_resource_state
		WHERE resource_type = 'jira' AND state_json LIKE '%git_pull_request_urls%' ORDER BY resource_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []linked.Item
	for rows.Next() {
		var key, raw string
		if err := rows.Scan(&key, &raw); err != nil {
			return nil, err
		}
		var st struct {
			Summary          string   `json:"summary"`
			Status           string   `json:"status"`
			IssueType        string   `json:"issue_type"`
			IssueTypeIconURL string   `json:"issue_type_icon_url"`
			URLs             []string `json:"git_pull_request_urls"`
		}
		if json.Unmarshal([]byte(raw), &st) != nil {
			continue
		}
		for _, u := range st.URLs {
			// Compare by resource id, so ".../pull/1/files" matches PR 1.
			if t, id, ok := resourceurl.Infer(u); ok && t == "pr" && id == prID {
				out = append(out, linked.Item{
					Type: "jira", ID: key, URL: j.issueURL(key), Resolved: true,
					Title: st.Summary, Status: st.Status, IssueType: st.IssueType, IssueTypeIconURL: st.IssueTypeIconURL,
				})
				break
			}
		}
	}
	return out, rows.Err()
}

// linkedSources builds Sources from the watcher config. Unconfigured
// services are left nil, which the builder treats as "not configured".
func (s *Server) linkedSources() linked.Sources {
	if s.LinkedSources != nil {
		return s.LinkedSources()
	}
	var src linked.Sources
	src.Links = cachedLinkResolver{r: s.linkResolver(), cache: s.linkedCacheOrInit()}
	if s.SlackClient != nil {
		src.Slack = slackAdapter{s}
	}
	cfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		return src
	}
	if gh, err := cfg.GitHub(); err == nil {
		src.PR = prAdapter{token: gh.Token}
	}
	if jc, err := cfg.Jira(); err == nil {
		fields := wtjira.ConfiguredCustomFields(jc.CustomFields)
		ja := jiraAdapter{
			c:       &wjira.Client{BaseURL: jc.Host, Email: jc.Email, Token: jc.Token},
			host:    jc.Host,
			gitPRID: fields["git_pull_request"],
		}
		src.Jira = ja
		if s.DB != nil {
			src.JiraState = jiraStateIndex{db: s.DB, issueURL: ja.IssueURL}
		}
	}
	return src
}

func linkedErrorStatus(err error) int {
	switch {
	case errors.Is(err, linked.ErrNotConfigured):
		return http.StatusServiceUnavailable
	case errors.Is(err, linked.ErrUnsupportedType):
		return http.StatusBadRequest
	default:
		return http.StatusBadGateway
	}
}

func (s *Server) handleLinkedResources(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	resType, id := q.Get("type"), q.Get("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing id")
		return
	}
	if resType != "pr" && resType != "jira" && resType != "slack" {
		writeError(w, http.StatusBadRequest, linked.ErrUnsupportedType.Error())
		return
	}
	resolveLinks := q.Get("resolve_links") == "1"
	key := "linked|" + resType + "|" + id + "|" + q.Get("resolve_links")
	v, err := s.linkedCacheOrInit().get(key, linkedTTL, q.Get("refresh") == "1", func() (interface{}, error) {
		b := &linked.Builder{Src: s.linkedSources()}
		return b.Build(r.Context(), resType, id, resolveLinks)
	})
	if err != nil {
		writeError(w, linkedErrorStatus(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleLinkedChildren(w http.ResponseWriter, r *http.Request) {
	key, ok := wtjira.ParseKey(r.URL.Query().Get("key"))
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid issue key")
		return
	}
	type resp struct {
		Items []*linked.TreeNode `json:"items"`
		More  *linked.More       `json:"more"`
	}
	v, err := s.linkedCacheOrInit().get("children|"+key, linkedTTL, false, func() (interface{}, error) {
		b := &linked.Builder{Src: s.linkedSources()}
		items, more, err := b.Children(r.Context(), key)
		if err != nil {
			return nil, err
		}
		return resp{Items: items, More: more}, nil
	})
	if err != nil {
		writeError(w, linkedErrorStatus(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, v)
}
```

Check `wtjira.ParseKey`'s signature in `internal/jira/detect.go:60` (`func ParseKey(s string) (string, bool)`) — it is used as-is. Also confirm `writeError`/`writeJSON` helper names via `grep -n "^func write" internal/webui/*.go`.

**Context note:** the cached builder runs with `r.Context()` of whichever request missed first; a client disconnect cancels the shared computation and the error is not cached, so the next request retries. Acceptable.

- [ ] **Step 4: Run tests**

Run: `go test ./internal/webui/ -run 'Linked|JiraStateIndex' -race -v && make test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/webui/linked_api.go internal/webui/linked_api_test.go internal/webui/server.go
git commit --signoff -m "feat(webui): /api/linked-resources with TTL cache and lazy children

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: UI — types, API client, `useLinkedResources`

**Files:**
- Modify: `ui/src/api/types.ts`, `ui/src/api/client.ts`
- Create: `ui/src/hooks/useLinkedResources.ts`
- Test: `ui/src/hooks/useLinkedResources.test.tsx`

**Interfaces:**
- Produces (TS):
  ```ts
  export interface LinkedItem { type: "pr"|"jira"|"slack"|"link"; id: string; url: string; resolved: boolean
    title?: string; state?: string; is_draft?: boolean; status?: string; status_category?: string
    issue_type?: string; issue_type_icon_url?: string; channel_name?: string; excerpt?: string; domain?: string; favicon?: string }
  export interface LinkedTreeNode extends LinkedItem { current?: boolean; expanded: boolean; has_children: boolean | null; children?: LinkedTreeNode[]; more?: { url: string } }
  export interface LinkedSection { kind: "git_pr"|"description"|"hierarchy"|"links"|"referenced_by"|"thread"; title: string; error?: string
    items?: LinkedItem[]; groups?: { label: string; items: LinkedItem[] }[]; tree?: LinkedTreeNode[] }
  export interface LinkedResourcesDTO { fetched_at: string; count: number; sections: LinkedSection[] }
  api.linkedResources(type: string, id: string, opts?: { resolveLinks?: boolean; refresh?: boolean }): Promise<LinkedResourcesDTO>
  api.linkedChildren(key: string): Promise<{ items: LinkedTreeNode[]; more: { url: string } | null }>
  export function useLinkedResources(type: string, id: string, resolveLinks: boolean): {
    data?: LinkedResourcesDTO; isLoading: boolean; error: Error | null; refresh: () => Promise<void>; refreshing: boolean; refetch: () => void }
  export const LINKED_TYPES = new Set(["pr", "jira", "slack"])
  ```

- [ ] **Step 1: Write the failing test** — `ui/src/hooks/useLinkedResources.test.tsx`:

```tsx
import { afterEach, describe, it, expect, vi } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../api/client"
import type { LinkedResourcesDTO } from "../api/types"
import { useLinkedResources } from "./useLinkedResources"

const dto = (count: number): LinkedResourcesDTO => ({ fetched_at: "2026-10-09T12:00:00Z", count, sections: [] })
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
)

afterEach(() => vi.restoreAllMocks())

describe("useLinkedResources", () => {
  it("fetches without link resolution, then keeps showing data while resolving", async () => {
    const spy = vi.spyOn(api, "linkedResources")
      .mockResolvedValueOnce(dto(2))
      .mockImplementationOnce(() => new Promise(() => {})) // resolved fetch never lands
    const { result, rerender } = renderHook(({ r }) => useLinkedResources("pr", "o/r#1", r), {
      wrapper, initialProps: { r: false },
    })
    await waitFor(() => expect(result.current.data?.count).toBe(2))
    expect(spy).toHaveBeenCalledWith("pr", "o/r#1", { resolveLinks: false })
    rerender({ r: true })
    expect(spy).toHaveBeenLastCalledWith("pr", "o/r#1", { resolveLinks: true })
    expect(result.current.data?.count).toBe(2) // placeholder, not a spinner
  })

  it("refresh bypasses the server cache", async () => {
    const spy = vi.spyOn(api, "linkedResources").mockResolvedValueOnce(dto(1)).mockResolvedValueOnce(dto(5))
    const { result } = renderHook(() => useLinkedResources("jira", "PROJ-1", true), { wrapper })
    await waitFor(() => expect(result.current.data?.count).toBe(1))
    await act(() => result.current.refresh())
    expect(spy).toHaveBeenLastCalledWith("jira", "PROJ-1", { resolveLinks: true, refresh: true })
    await waitFor(() => expect(result.current.data?.count).toBe(5))
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/hooks/useLinkedResources.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Append to `ui/src/api/types.ts`:

```ts
/** One row in the Linked Resources tab. Field names mirror ResourceDTO. */
export interface LinkedItem {
  type: "pr" | "jira" | "slack" | "link"
  id: string
  url: string
  /** false → the details couldn't be fetched; render key/URL only. */
  resolved: boolean
  title?: string
  state?: string
  is_draft?: boolean
  status?: string
  status_category?: string
  issue_type?: string
  issue_type_icon_url?: string
  channel_name?: string
  excerpt?: string
  domain?: string
  favicon?: string
}

export interface LinkedTreeNode extends LinkedItem {
  current?: boolean
  /** The server's initial expansion: ancestors and the current branch. */
  expanded: boolean
  /** null = unknown; the UI offers a lazy expand. */
  has_children: boolean | null
  children?: LinkedTreeNode[]
  more?: { url: string }
}

export interface LinkedSection {
  kind: "git_pr" | "description" | "hierarchy" | "links" | "referenced_by" | "thread"
  title: string
  error?: string
  items?: LinkedItem[]
  groups?: { label: string; items: LinkedItem[] }[]
  tree?: LinkedTreeNode[]
}

export interface LinkedResourcesDTO {
  fetched_at: string
  count: number
  sections: LinkedSection[]
}
```

In `ui/src/api/client.ts`, add `LinkedResourcesDTO, LinkedTreeNode` to the type import, and add to `api`:

```ts
  linkedResources: (type: string, id: string, opts: { resolveLinks?: boolean; refresh?: boolean } = {}) => {
    const params = new URLSearchParams({ type, id })
    if (opts.resolveLinks) params.set("resolve_links", "1")
    if (opts.refresh) params.set("refresh", "1")
    return fetchJSON<LinkedResourcesDTO>(`/api/linked-resources?${params}`)
  },
  linkedChildren: (key: string) =>
    fetchJSON<{ items: LinkedTreeNode[]; more: { url: string } | null }>(
      `/api/linked-resources/children?key=${encodeURIComponent(key)}`,
    ),
```

`ui/src/hooks/useLinkedResources.ts`:

```ts
import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"

/** Resource types that have a Linked Resources tab. */
export const LINKED_TYPES = new Set(["pr", "jira", "slack"])

/** Matches the server's cache lifetime, so remounts don't refetch early. */
const STALE_MS = 2 * 60_000

/**
 * A resource's linked resources. Fired on selection with resolveLinks
 * false (drives the tab's count, no outbound page fetches); the tab flips
 * resolveLinks on when first opened, and the placeholder shows the
 * unresolved rows until titles arrive instead of a spinner.
 */
export function useLinkedResources(type: string, id: string, resolveLinks: boolean) {
  const qc = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const key = ["linked", type, id, resolveLinks] as const
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.linkedResources(type, id, { resolveLinks }),
    staleTime: STALE_MS,
    // Carry data across the resolveLinks flip of the SAME resource only —
    // never from one resource into another's tab while it loads.
    placeholderData: (prev, prevQuery) =>
      prevQuery && prevQuery.queryKey[1] === type && prevQuery.queryKey[2] === id ? prev : undefined,
    enabled: LINKED_TYPES.has(type),
  })
  async function refresh() {
    setRefreshing(true)
    try {
      const fresh = await api.linkedResources(type, id, { resolveLinks, refresh: true })
      qc.setQueryData(key, fresh)
    } finally {
      setRefreshing(false)
    }
  }
  return {
    data: q.data,
    isLoading: q.isLoading,
    error: q.error as Error | null,
    refresh,
    refreshing,
    refetch: () => void q.refetch(),
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run src/hooks/useLinkedResources.test.tsx && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/types.ts ui/src/api/client.ts ui/src/hooks/useLinkedResources.ts ui/src/hooks/useLinkedResources.test.tsx
git commit --signoff -m "feat(ui): linked-resources API client and query hook

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: UI — shared action hooks, `LinkedResourceActions`, follow/view wiring

**Files:**
- Create: `ui/src/components/resourceActionHooks.ts`
- Modify: `ui/src/components/ResourceActions.tsx` (use the hooks; export `ExistingTabButtons` with a `switchLabel` prop)
- Create: `ui/src/components/linked/LinkedActionsContext.tsx`
- Create: `ui/src/components/linked/LinkedResourceActions.tsx`
- Test: `ui/src/components/linked/LinkedResourceActions.test.tsx`
- Modify: `ui/src/pages/WorktreeDetailPage.tsx` (provide the context; follow modal with `defaultRelated`)

**Interfaces:**
- Consumes: `useResourceCmuxTab` (`ui/src/api/cmux.ts`), `api.cmuxFocusTab`, `cmuxBrowserTabsKey`, `CopyLinkIcon`, `AddResourceModal`'s `initialUrl`/`defaultRelated`, `LinkedItem`.
- Produces:
  ```ts
  // resourceActionHooks.ts
  export function useCopyLink(url: string): { copied: boolean; copy: () => Promise<void> }
  export function useSwitchToTab(url: string, existing: CmuxBrowserTab): () => Promise<void>
  // ResourceActions.tsx
  export function ExistingTabButtons(props: { url: string; label: string; switchLabel: string; existing: CmuxBrowserTab }): JSX.Element
  // LinkedActionsContext.tsx
  export interface LinkedActions { requestFollow?: (url: string) => void; trackedResource?: (type: string, id: string) => ResourceKey | null; selectResource?: (key: ResourceKey) => void }
  export const LinkedActionsContext: React.Context<LinkedActions>
  export function useLinkedActions(): LinkedActions
  // LinkedResourceActions.tsx
  export function LinkedResourceActions(props: { item: LinkedItem; path?: string; hideFollow?: boolean }): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests** — `ui/src/components/linked/LinkedResourceActions.test.tsx`:

```tsx
import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { CmuxResponse, LinkedItem } from "../../api/types"
import { LinkedActionsContext, type LinkedActions } from "./LinkedActionsContext"
import { LinkedResourceActions } from "./LinkedResourceActions"

const item = (over: Partial<LinkedItem> = {}): LinkedItem =>
  ({ type: "jira", id: "PROJ-9", url: "https://example.atlassian.net/browse/PROJ-9", resolved: true, ...over })

function wrap(ui: React.ReactNode, actions: LinkedActions = {}) {
  return render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <LinkedActionsContext.Provider value={actions}>{ui}</LinkedActionsContext.Provider>
      </QueryClientProvider>
    </MantineProvider>,
  )
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("LinkedResourceActions", () => {
  it("Follow opens the follow modal with the URL", async () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false } as never)
    const requestFollow = vi.fn()
    wrap(<LinkedResourceActions item={item()} />, { requestFollow, trackedResource: () => null })
    await userEvent.click(screen.getByRole("button", { name: "Follow" }))
    expect(requestFollow).toHaveBeenCalledWith("https://example.atlassian.net/browse/PROJ-9")
  })

  it("an already-followed resource offers View in worktree instead", async () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false } as never)
    const selectResource = vi.fn()
    wrap(<LinkedResourceActions item={item()} />, {
      requestFollow: vi.fn(),
      trackedResource: (t, id) => (t === "jira" && id === "PROJ-9" ? { type: "jira", id: "PROJ-9" } : null),
      selectResource,
    })
    expect(screen.queryByRole("button", { name: "Follow" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "View in worktree" }))
    expect(selectResource).toHaveBeenCalledWith({ type: "jira", id: "PROJ-9" })
  })

  it("Open is a new-tab link; Slack says Open in Slack", () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false } as never)
    wrap(<LinkedResourceActions item={item()} />)
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("target", "_blank")
    cleanup()
    wrap(<LinkedResourceActions item={item({ type: "slack", id: "C0TEST:1.2", url: "https://x.slack.com/archives/C0TEST/p12" })} />)
    expect(screen.getByRole("link", { name: "Open in Slack" })).toBeInTheDocument()
  })

  it("an issue open in a cmux tab offers Switch to tab", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: true, workspaces: [], matches: {} } as unknown as CmuxResponse)
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({
      available: true,
      tabs: [{ workspaceId: "w1", workspaceRef: "workspace:1", workspaceTitle: "ws", surface: "s1",
        url: "https://example.atlassian.net/browse/PROJ-9", title: "PROJ-9" }],
    } as never)
    const focus = vi.spyOn(api, "cmuxFocusTab").mockResolvedValue({ ok: true } as never)
    wrap(<LinkedResourceActions item={item()} />)
    await userEvent.click(await screen.findByRole("button", { name: "Switch to tab" }))
    expect(focus).toHaveBeenCalledWith("w1", "s1")
  })

  it("hideFollow hides both Follow and View in worktree", () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false } as never)
    wrap(<LinkedResourceActions item={item()} hideFollow />, { requestFollow: vi.fn(), trackedResource: () => null })
    expect(screen.queryByRole("button", { name: "Follow" })).not.toBeInTheDocument()
  })

  it("copies the URL", async () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false } as never)
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    wrap(<LinkedResourceActions item={item()} />)
    await user.click(screen.getByRole("button", { name: /copy link/i }))
    expect(writeText).toHaveBeenCalledWith("https://example.atlassian.net/browse/PROJ-9")
  })
})
```

Before writing these, check the exact `CmuxBrowserTabsResponse` / `CmuxBrowserTab` shape in `ui/src/api/types.ts` and how `ResourceActions.test.tsx` mocks a matching tab; copy that mock shape exactly (field names above are best-effort).

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/components/linked/LinkedResourceActions.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`ui/src/components/resourceActionHooks.ts`:

```ts
import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import { cmuxBrowserTabsKey } from "../api/cmux"
import type { CmuxBrowserTab } from "../api/types"

const COPIED_FEEDBACK_MS = 1500

/** Copy a URL with brief "Copied!" feedback. Shared by every copy-link button. */
export function useCopyLink(url: string) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    } catch {
      // Clipboard access can be denied; failing silently beats an error
      // state on a convenience.
    }
  }
  return { copied, copy }
}

/**
 * Switch cmux to the tab already showing `url`. If the tab has gone since
 * the last poll, open the URL anyway and re-read the tabs so the label stops
 * claiming one.
 */
export function useSwitchToTab(url: string, existing: CmuxBrowserTab) {
  const qc = useQueryClient()
  return async () => {
    let ok = false
    try {
      ok = (await api.cmuxFocusTab(existing.workspaceId, existing.surface)).ok
    } catch {
      // Treated like a refusal below.
    }
    if (ok) return
    window.open(url, "_blank", "noreferrer")
    void qc.invalidateQueries({ queryKey: cmuxBrowserTabsKey })
  }
}
```

In `ui/src/components/ResourceActions.tsx`: replace the local `copied` state + `handleCopy` with `const { copied, copy } = useCopyLink(r.url)` (call the hook before the `if (!r.url) return null` early return — hooks must not be conditional; `useCopyLink("")` is harmless), and change `ExistingTabButtons` to be exported with props `{ url, label, switchLabel, existing }`, using `const handleSwitch = useSwitchToTab(url, existing)` in place of its inline function, rendering `{switchLabel}` in the button and `href={url}` in the menu item. Update the call site to `<ExistingTabButtons url={r.url} label={label} switchLabel={`Switch to open ${serviceName(r.type)} tab`} existing={existing} />`. Remove the now-unused `COPIED_FEEDBACK_MS` and `useQueryClient` imports. `ResourceActions.test.tsx` must still pass unchanged.

`ui/src/components/linked/LinkedActionsContext.tsx`:

```tsx
import { createContext, useContext } from "react"
import type { ResourceKey } from "../../lib/resourceKey"

export interface LinkedActions {
  /** Open the follow modal pre-filled with this URL (Related preselected). */
  requestFollow?: (url: string) => void
  /** This worktree's resource key for (type, id), or null if not followed. */
  trackedResource?: (type: string, id: string) => ResourceKey | null
  /** Select a followed resource in the detail pane. */
  selectResource?: (key: ResourceKey) => void
}

/**
 * What a Linked Resources row can do to the surrounding worktree. Supplied by
 * WorktreeDetailPage — the only place that knows the resource list and the
 * selection — via context, like ThreadActionsContext, because rows sit
 * several layers below it. Empty outside a worktree: Follow simply hides.
 */
export const LinkedActionsContext = createContext<LinkedActions>({})

export function useLinkedActions(): LinkedActions {
  return useContext(LinkedActionsContext)
}
```

`ui/src/components/linked/LinkedResourceActions.tsx`:

```tsx
import { Button, Tooltip } from "@mantine/core"
import { useResourceCmuxTab } from "../../api/cmux"
import type { LinkedItem } from "../../api/types"
import { CopyLinkIcon } from "../CopyLinkIcon"
import { ExistingTabButtons } from "../ResourceActions"
import { useCopyLink } from "../resourceActionHooks"
import { useLinkedActions } from "./LinkedActionsContext"

const btn = { root: { flexShrink: 0 }, label: { whiteSpace: "nowrap" as const } }

/**
 * Follow / Open / Copy link for one linked resource. Follow becomes "View in
 * worktree" when this worktree already follows it; Open becomes "Switch to
 * tab" when cmux already has it open (PRs and Jira only — the only types
 * cmux tab matching knows).
 */
export function LinkedResourceActions({ item, path, hideFollow }: { item: LinkedItem; path?: string; hideFollow?: boolean }) {
  const actions = useLinkedActions()
  const existing = useResourceCmuxTab(path, item.type, item.url)
  const { copied, copy } = useCopyLink(item.url)
  const tracked = actions.trackedResource?.(item.type, item.id) ?? null
  const openLabel = item.type === "slack" ? "Open in Slack" : "Open"

  return (
    <Button.Group className="compound-group" style={{ flexShrink: 0 }}>
      {!hideFollow && tracked && actions.selectResource && (
        <Button size="xs" variant="light" styles={btn} onClick={() => actions.selectResource!(tracked)}>
          View in worktree
        </Button>
      )}
      {!hideFollow && !tracked && actions.requestFollow && (
        <Button size="xs" variant="light" styles={btn} onClick={() => actions.requestFollow!(item.url)}>
          Follow
        </Button>
      )}
      {existing ? (
        <ExistingTabButtons url={item.url} label={openLabel} switchLabel="Switch to tab" existing={existing} />
      ) : (
        <Button size="xs" variant="light" component="a" href={item.url} target="_blank" rel="noreferrer" styles={btn}>
          {openLabel}
        </Button>
      )}
      <Tooltip label={copied ? "Copied!" : "Copy link"}>
        <Button size="xs" variant="light" px="xs" aria-label="Copy link" onClick={() => void copy()} styles={{ root: { flexShrink: 0 } }}>
          <CopyLinkIcon />
        </Button>
      </Tooltip>
    </Button.Group>
  )
}
```

In `ui/src/pages/WorktreeDetailPage.tsx`:
- Add state: `const [pendingFollowUrl, setPendingFollowUrl] = useState<string | null>(null)`.
- Build actions next to `threadActions`:

```tsx
  const linkedActions = {
    requestFollow: (url: string) => setPendingFollowUrl(url),
    trackedResource: (type: string, id: string) => {
      const hit = items.find((r) => r.type === type && r.id === id)
      return hit ? { type: hit.type, id: hit.id } : null
    },
    selectResource: (key: { type: string; id: string }) => select(key),
  }
```

- Wrap the returned tree's content in `<LinkedActionsContext.Provider value={linkedActions}>` (inside the existing `ThreadActionsContext.Provider`).
- Render a second modal beside the thread one:

```tsx
      {pendingFollowUrl !== null && (
        // Keyed by URL: the modal reads initialUrl at mount.
        <AddResourceModal
          key={pendingFollowUrl}
          opened
          path={path}
          initialUrl={pendingFollowUrl}
          defaultRelated
          onClose={() => setPendingFollowUrl(null)}
          onAdded={() => {
            setPendingFollowUrl(null)
            void resources.refetch()
          }}
        />
      )}
```

`items` is the page's full resource list (used by `resolveResource` at ~line 102); confirm the name before using it.

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run src/components/linked src/components/ResourceActions.test.tsx && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/resourceActionHooks.ts ui/src/components/ResourceActions.tsx ui/src/components/linked/LinkedActionsContext.tsx ui/src/components/linked/LinkedResourceActions.tsx ui/src/components/linked/LinkedResourceActions.test.tsx ui/src/pages/WorktreeDetailPage.tsx
git commit --signoff -m "feat(ui): Follow/Open/Copy actions for linked resources

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: UI — rows, hierarchy tree, panel, and tabs

**Files:**
- Create: `ui/src/components/linked/LinkedResourceRow.tsx`, `HierarchyTree.tsx`, `LinkedResourcesPanel.tsx`
- Test: `ui/src/components/linked/LinkedResourcesPanel.test.tsx`
- Modify: `ui/src/components/ResourceDetailPane.tsx` (`TimelineBody` tabs; key by resource)
- Modify: `ui/src/components/SlackThreadPane.tsx` (Thread / Linked tabs)
- Test: extend `ui/src/components/ResourceDetailPane.test.tsx` and `ResourceDetailPane.slack.test.tsx`

**Interfaces:**
- Consumes: `useLinkedResources`, `LinkedResourceActions`, `ResourceStatusIcon`, `LinkFavicon`, `jiraIconProxy`, `api.linkedChildren`, `relativeTime`.
- Produces:
  ```ts
  export function LinkedResourceRow(props: { item: LinkedItem; path?: string; hideFollow?: boolean; marker?: React.ReactNode }): JSX.Element
  export function HierarchyTree(props: { roots: LinkedTreeNode[]; path?: string }): JSX.Element
  export function LinkedResourcesPanel(props: { query: ReturnType<typeof useLinkedResources>; path?: string }): JSX.Element
  export function linkedTabLabel(data?: { count: number }): string // "Linked Resources (N)" | "Linked Resources"
  export function LinkedTabControls(props: { query: ReturnType<typeof useLinkedResources> }): JSX.Element // "Fetched 1m ago" + refresh
  ```

- [ ] **Step 1: Write the failing tests** — `ui/src/components/linked/LinkedResourcesPanel.test.tsx`:

```tsx
import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { LinkedResourcesDTO } from "../../api/types"
import { LinkedResourcesPanel, linkedTabLabel } from "./LinkedResourcesPanel"

type Q = Parameters<typeof LinkedResourcesPanel>[0]["query"]
const q = (over: Partial<Q>): Q => ({ data: undefined, isLoading: false, error: null, refresh: vi.fn(), refreshing: false, refetch: vi.fn(), ...over })
const wrap = (ui: React.ReactNode) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
    </MantineProvider>,
  )

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const dto: LinkedResourcesDTO = {
  fetched_at: "2026-10-09T12:00:00Z",
  count: 4,
  sections: [
    { kind: "description", title: "Linked in description", items: [
      { type: "pr", id: "example/repo#2", url: "https://github.com/example/repo/pull/2", resolved: true, title: "Fix thing", state: "OPEN" },
      { type: "jira", id: "GONE-1", url: "https://example.atlassian.net/browse/GONE-1", resolved: false },
    ] },
    { kind: "links", title: "Linked work items", groups: [
      { label: "is blocked by", items: [{ type: "jira", id: "PROJ-3", url: "u3", resolved: true, title: "Blocker", status: "New", issue_type: "Bug" }] },
    ] },
    { kind: "hierarchy", title: "Hierarchy", tree: [
      { type: "jira", id: "PROJ-10", url: "u10", resolved: true, title: "Epic", issue_type: "Epic", expanded: true, has_children: true, children: [
        { type: "jira", id: "PROJ-1", url: "u1", resolved: true, title: "Me", issue_type: "Story", current: true, expanded: true, has_children: false },
        { type: "jira", id: "PROJ-7", url: "u7", resolved: true, title: "Sibling", issue_type: "Story", expanded: false, has_children: null },
      ] },
    ] },
    { kind: "git_pr", title: "Git Pull Request", items: [] },
    { kind: "thread", title: "Linked in thread", error: "boom" },
  ],
}

describe("LinkedResourcesPanel", () => {
  it("renders sections, groups, unresolved items and section errors; hides empty sections", () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false } as never)
    wrap(<LinkedResourcesPanel query={q({ data: dto })} />)
    expect(screen.getByText("Linked in description")).toBeInTheDocument()
    expect(screen.getByText("Fix thing")).toBeInTheDocument()
    expect(screen.getByText("example/repo#2")).toBeInTheDocument()
    expect(screen.getByText("couldn't load details")).toBeInTheDocument()
    expect(screen.getByText("is blocked by")).toBeInTheDocument()
    expect(screen.getByText("Bug PROJ-3")).toBeInTheDocument()
    expect(screen.queryByText("Git Pull Request")).not.toBeInTheDocument()
    expect(screen.getByText("boom")).toBeInTheDocument()
    expect(screen.getByText("this issue")).toBeInTheDocument()
  })

  it("lazily loads a collapsed node's children", async () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false } as never)
    const kids = vi.spyOn(api, "linkedChildren").mockResolvedValue({
      items: [{ type: "jira", id: "PROJ-70", url: "u70", resolved: true, title: "Grandkid", expanded: false, has_children: null }],
      more: { url: "https://example.atlassian.net/issues/?jql=x" },
    })
    wrap(<LinkedResourcesPanel query={q({ data: dto })} />)
    expect(screen.queryByText("Grandkid")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Expand PROJ-7" }))
    expect(await screen.findByText("Grandkid")).toBeInTheDocument()
    expect(kids).toHaveBeenCalledWith("PROJ-7")
    expect(screen.getByRole("link", { name: "More on Jira…" })).toBeInTheDocument()
  })

  it("empty, loading and error states", async () => {
    wrap(<LinkedResourcesPanel query={q({ data: { fetched_at: "", count: 0, sections: [{ kind: "description", title: "Linked in description", items: [] }] } })} />)
    expect(screen.getByText("No linked resources found")).toBeInTheDocument()
    cleanup()
    const refetch = vi.fn()
    wrap(<LinkedResourcesPanel query={q({ error: new Error("Jira 500"), refetch })} />)
    expect(screen.getByText(/Jira 500/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(refetch).toHaveBeenCalled()
  })

  it("tab label carries the count only once loaded", () => {
    expect(linkedTabLabel(undefined)).toBe("Linked Resources")
    expect(linkedTabLabel({ count: 7 })).toBe("Linked Resources (7)")
  })
})
```

Add to `ui/src/components/ResourceDetailPane.test.tsx` (follow that file's existing render helper and mocks; it already mocks the timeline fetch):

```tsx
  it("shows Activity by default, switches to Linked Resources, and resets on resource change", async () => {
    vi.spyOn(api, "linkedResources").mockResolvedValue({ fetched_at: "2026-10-09T12:00:00Z", count: 3, sections: [] })
    const { rerender } = renderPane(prResource("o/r#1"))   // use the file's existing helper names
    expect(await screen.findByRole("tab", { name: "Linked Resources (3)" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true")
    await userEvent.click(screen.getByRole("tab", { name: "Linked Resources (3)" }))
    expect(screen.queryByRole("button", { name: /Mark .* as read/ })).not.toBeInTheDocument()
    rerenderPane(rerender, prResource("o/r#2"))
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true")
  })
```

Add to `ui/src/components/ResourceDetailPane.slack.test.tsx`:

```tsx
  it("has Thread and Linked Resources tabs and keeps the thread mounted", async () => {
    vi.spyOn(api, "linkedResources").mockResolvedValue({ fetched_at: "", count: 0, sections: [] })
    renderSlackPane()   // existing helper in this file
    expect(await screen.findByRole("tab", { name: "Thread" })).toHaveAttribute("aria-selected", "true")
    const composer = await screen.findByRole("textbox")  // whatever the file already uses to find the composer
    await userEvent.click(screen.getByRole("tab", { name: /Linked Resources/ }))
    expect(composer).toBeInTheDocument() // still mounted (hidden), so drafts survive
  })
```

(Adapt helper names to those files' actual helpers; the assertions are the contract.)

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/components/linked src/components/ResourceDetailPane`
Expected: FAIL — modules/tabs not found.

- [ ] **Step 3: Implement**

`ui/src/components/linked/LinkedResourceRow.tsx`:

```tsx
import { Badge, Group, Text } from "@mantine/core"
import { IconMessage } from "@tabler/icons-react"
import type { LinkedItem, ResourceDTO } from "../../api/types"
import { LinkFavicon, ResourceStatusIcon } from "../ResourceStatusIcon"
import { LinkedResourceActions } from "./LinkedResourceActions"

/** A ResourceDTO-shaped view of an item, so the shared status icon applies. */
export function asResource(item: LinkedItem): ResourceDTO {
  return {
    type: item.type, id: item.id, url: item.url, primary: false,
    title: item.title, state: item.state, status: item.status, issue_type: item.issue_type,
    issue_type_icon_url: item.issue_type_icon_url, channel_name: item.channel_name, favicon: item.favicon,
  }
}

function keyText(item: LinkedItem): string {
  switch (item.type) {
    case "pr": return item.id
    case "jira": return item.issue_type ? `${item.issue_type} ${item.id}` : item.id
    case "slack": return item.channel_name ? `Thread in #${item.channel_name}` : "Slack thread"
    default: return item.domain ?? ""
  }
}

function titleText(item: LinkedItem): string {
  if (item.type === "slack") return item.excerpt ?? ""
  return item.title || (item.type === "link" ? item.url : "")
}

function statusText(item: LinkedItem): string | undefined {
  if (item.type === "jira") return item.status
  if (item.type === "pr" && item.state) return item.is_draft && item.state === "OPEN" ? "draft" : item.state.toLowerCase()
  return undefined
}

function icon(item: LinkedItem) {
  if (item.type === "slack") {
    return <IconMessage size={14} aria-hidden style={{ color: "var(--mantine-color-grape-6)", flexShrink: 0 }} />
  }
  if (item.type === "link") return <LinkFavicon r={asResource(item)} />
  return <ResourceStatusIcon r={asResource(item)} />
}

/**
 * One linked resource: [icon] [key] title [status] [actions]. Wraps so the
 * actions drop below the text on narrow viewports rather than crushing it.
 */
export function LinkedResourceRow({ item, path, hideFollow, marker }: {
  item: LinkedItem
  path?: string
  hideFollow?: boolean
  marker?: React.ReactNode
}) {
  const status = statusText(item)
  return (
    <Group justify="space-between" gap="xs" wrap="wrap" py={4}>
      <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
        {icon(item)}
        <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>{keyText(item)}</Text>
        {item.resolved ? (
          <Text size="sm" truncate="end" style={{ minWidth: 0 }}>{titleText(item)}</Text>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">couldn't load details</Text>
        )}
        {status && <Badge size="sm" variant="light" color="gray" style={{ flexShrink: 0 }}>{status}</Badge>}
        {marker}
      </Group>
      <LinkedResourceActions item={item} path={path} hideFollow={hideFollow} />
    </Group>
  )
}
```

`ui/src/components/linked/HierarchyTree.tsx`:

```tsx
import { useState } from "react"
import { ActionIcon, Anchor, Badge, Box, Loader, Text } from "@mantine/core"
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { LinkedTreeNode } from "../../api/types"
import { LinkedResourceRow } from "./LinkedResourceRow"

const INDENT_PX = 20

function MoreRow({ url, depth }: { url: string; depth: number }) {
  return (
    <Box pl={depth * INDENT_PX + 26} py={4}>
      <Anchor href={url} target="_blank" rel="noreferrer" size="sm">More on Jira…</Anchor>
    </Box>
  )
}

function TreeNodeView({ node, depth, path }: { node: LinkedTreeNode; depth: number; path?: string }) {
  const [expanded, setExpanded] = useState(node.expanded)
  const lazy = !node.children && node.has_children !== false
  const kids = useQuery({
    queryKey: ["linked-children", node.id],
    queryFn: () => api.linkedChildren(node.id),
    enabled: expanded && lazy,
    staleTime: 2 * 60_000,
  })
  const children = node.children ?? kids.data?.items
  const more = node.more ?? kids.data?.more ?? undefined
  const canExpand = node.has_children !== false && (node.children ? node.children.length > 0 : true)
  const loadedEmpty = lazy && kids.isSuccess && (kids.data?.items.length ?? 0) === 0

  return (
    <>
      <Box
        pl={depth * INDENT_PX}
        style={node.current ? {
          borderLeft: "3px solid var(--mantine-primary-color-filled)",
          background: "var(--mantine-primary-color-light)",
          borderRadius: 4,
        } : undefined}
      >
        <Box style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {canExpand && !loadedEmpty ? (
            <ActionIcon
              variant="subtle" size="sm" color="gray"
              aria-label={`${expanded ? "Collapse" : "Expand"} ${node.id}`}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            </ActionIcon>
          ) : (
            <Box w={22} />
          )}
          <Box style={{ flex: 1, minWidth: 0 }}>
            <LinkedResourceRow
              item={node}
              path={path}
              hideFollow={node.current}
              marker={node.current ? <Badge size="sm" variant="filled">this issue</Badge> : undefined}
            />
          </Box>
        </Box>
      </Box>
      {expanded && kids.isLoading && <Box pl={(depth + 1) * INDENT_PX + 26}><Loader size="xs" /></Box>}
      {expanded && kids.error && (
        <Text size="xs" c="red" pl={(depth + 1) * INDENT_PX + 26}>Couldn't load child issues</Text>
      )}
      {expanded && children?.map((c) => <TreeNodeView key={c.id} node={c} depth={depth + 1} path={path} />)}
      {expanded && more && <MoreRow url={more.url} depth={depth + 1} />}
    </>
  )
}

/** The Jira hierarchy as an indented tree; collapsed nodes load lazily. */
export function HierarchyTree({ roots, path }: { roots: LinkedTreeNode[]; path?: string }) {
  return <>{roots.map((n) => <TreeNodeView key={n.id} node={n} depth={0} path={path} />)}</>
}
```

`ui/src/components/linked/LinkedResourcesPanel.tsx`:

```tsx
import { ActionIcon, Alert, Button, Center, Group, Loader, Stack, Text, Title, Tooltip } from "@mantine/core"
import { IconRefresh } from "@tabler/icons-react"
import type { LinkedSection } from "../../api/types"
import type { useLinkedResources } from "../../hooks/useLinkedResources"
import { relativeTime } from "../../lib/relativeTime"
import { HierarchyTree } from "./HierarchyTree"
import { LinkedResourceRow } from "./LinkedResourceRow"

type LinkedQuery = ReturnType<typeof useLinkedResources>

export function linkedTabLabel(data?: { count: number }): string {
  return data ? `Linked Resources (${data.count})` : "Linked Resources"
}

function isEmpty(s: LinkedSection): boolean {
  return !s.error && !s.items?.length && !s.groups?.length && !s.tree?.length
}

function SectionView({ s, path }: { s: LinkedSection; path?: string }) {
  return (
    <Stack gap={2}>
      <Title order={6}>{s.title}</Title>
      {s.error && <Alert color="red" variant="light" p="xs"><Text size="sm">{s.error}</Text></Alert>}
      {s.items?.map((it) => <LinkedResourceRow key={`${it.type}:${it.id}`} item={it} path={path} />)}
      {s.groups?.map((g) => (
        <Stack key={g.label} gap={0} pl="xs">
          <Text size="xs" c="dimmed" fw={600}>{g.label}</Text>
          {g.items.map((it) => <LinkedResourceRow key={`${it.type}:${it.id}`} item={it} path={path} />)}
        </Stack>
      ))}
      {s.tree && <HierarchyTree roots={s.tree} path={path} />}
    </Stack>
  )
}

/** The Linked Resources tab body. */
export function LinkedResourcesPanel({ query, path }: { query: LinkedQuery; path?: string }) {
  if (query.error && !query.data) {
    return (
      <Alert color="red" variant="light" title="Couldn't load linked resources">
        <Group gap="sm">
          <Text size="sm">{query.error.message}</Text>
          <Button size="compact-sm" variant="light" onClick={query.refetch}>Retry</Button>
        </Group>
      </Alert>
    )
  }
  if (!query.data) {
    return <Center py="md"><Loader size="sm" /></Center>
  }
  const visible = query.data.sections.filter((s) => !isEmpty(s))
  if (visible.length === 0) {
    return <Text size="sm" c="dimmed" ta="center" py="md">No linked resources found</Text>
  }
  return <Stack gap="md">{visible.map((s) => <SectionView key={s.kind} s={s} path={path} />)}</Stack>
}

/** Sits where the Activity tab's "Updated …" goes. */
export function LinkedTabControls({ query }: { query: LinkedQuery }) {
  return (
    <Group gap={4} wrap="nowrap" style={{ flex: "none" }}>
      {query.data?.fetched_at && (
        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>{`Fetched ${relativeTime(query.data.fetched_at)}`}</Text>
      )}
      <Tooltip label="Refresh linked resources">
        <ActionIcon variant="subtle" size="sm" aria-label="Refresh linked resources" loading={query.refreshing} onClick={() => void query.refresh()}>
          <IconRefresh size={14} />
        </ActionIcon>
      </Tooltip>
    </Group>
  )
}
```

Check that `relativeTime` accepts an ISO string (it is used with `watcher.last_success` in `ResourceDetailPane`); if it takes a `Date`/number, convert.

**`ResourceDetailPane.tsx`** — in `TimelineBody`:

1. Add state + query at the top:

```tsx
  const [tab, setTab] = useState<string>("activity")
  const [linkedOpened, setLinkedOpened] = useState(false)
  const linked = useLinkedResources(resource.type, resource.id, linkedOpened)
```

2. Replace the header `Group` (the one containing `<Title order={5}>Activity</Title>`) and everything below the `ResourceCard` with:

```tsx
      <Tabs
        value={tab}
        onChange={(v) => {
          if (!v) return
          setTab(v)
          if (v === "linked") setLinkedOpened(true)
        }}
      >
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap={6} wrap="nowrap" align="center">
            <Tabs.List>
              <Tabs.Tab value="activity">Activity</Tabs.Tab>
              <Tabs.Tab value="linked">{linkedTabLabel(linked.data)}</Tabs.Tab>
            </Tabs.List>
            {tab === "activity" && (
              <>
                <RefreshWatchersButton />
                {/* existing "Mark N events as read" Button, unchanged */}
              </>
            )}
          </Group>
          {tab === "activity" ? (
            /* existing "Updated …" + WatcherErrorMark Group, unchanged */
          ) : (
            <LinkedTabControls query={linked} />
          )}
        </Group>
        <Tabs.Panel value="activity" pt="sm">
          {/* existing TimelineFeed and "More activity on …" Center, unchanged */}
        </Tabs.Panel>
        <Tabs.Panel value="linked" pt="sm">
          <LinkedResourcesPanel query={linked} path={path} />
        </Tabs.Panel>
      </Tabs>
```

(Move the existing JSX blocks into the marked slots verbatim — do not rewrite them. Import `Tabs` from `@mantine/core`, `useState` from react, and the new modules.)

3. In `ResourceDetailPane`, key the `TimelineBody` and `SlackThreadPane` by resource so tab state resets on selection change: `key={`${resource.type}:${resource.id}`}`.

**`SlackThreadPane.tsx`** — same pattern between `ResourceCard` and `ThreadView`:

```tsx
  const [tab, setTab] = useState<string>("thread")
  const [linkedOpened, setLinkedOpened] = useState(false)
  const linked = useLinkedResources(resource.type, resource.id, linkedOpened)
  ...
      <Tabs
        value={tab}
        // keepMounted: the hidden Thread panel keeps its composer draft,
        // scroll position and unread-divider placement across tab switches.
        keepMounted
        onChange={(v) => {
          if (!v) return
          setTab(v)
          if (v === "linked") setLinkedOpened(true)
        }}
      >
        <Group justify="space-between" align="center" wrap="nowrap">
          <Tabs.List>
            <Tabs.Tab value="thread">Thread</Tabs.Tab>
            <Tabs.Tab value="linked">{linkedTabLabel(linked.data)}</Tabs.Tab>
          </Tabs.List>
          {tab === "linked" && <LinkedTabControls query={linked} />}
        </Group>
        <Tabs.Panel value="thread" pt="sm">
          <ThreadView ... />  {/* unchanged props */}
        </Tabs.Panel>
        <Tabs.Panel value="linked" pt="sm">
          <LinkedResourcesPanel query={linked} path={path} />
        </Tabs.Panel>
      </Tabs>
```

Hooks must be called before the `isNotConfigured` early return in `SlackThreadPane` — place the new `useState`/`useLinkedResources` calls next to the existing `useThread` call.

**Sticky composer check:** `ThreadView`'s composer is `position: sticky` relative to the page scroller. A Mantine `Tabs.Panel` is a plain block `div`, which does not break sticky positioning. Verify manually in Task 14.

- [ ] **Step 4: Run tests**

Run: `cd ui && npm test && npx tsc -b`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/linked/LinkedResourceRow.tsx ui/src/components/linked/HierarchyTree.tsx ui/src/components/linked/LinkedResourcesPanel.tsx ui/src/components/linked/LinkedResourcesPanel.test.tsx ui/src/components/ResourceDetailPane.tsx ui/src/components/ResourceDetailPane.test.tsx ui/src/components/SlackThreadPane.tsx ui/src/components/ResourceDetailPane.slack.test.tsx
git commit --signoff -m "feat(ui): Linked Resources tab for PR, Jira and Slack resources

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Docs, build, and end-to-end verification

**Files:**
- Modify: `docs/web-ui-architecture.md` (new "Linked resources" section)
- Modify: `.claude/CLAUDE.md` (add `internal/linked` to the package list)
- Modify: `docs/superpowers/specs/2026-10-09-linked-resources-tab-design.md` (record the two deviations)

- [ ] **Step 1: Write docs.** In `docs/web-ui-architecture.md` add a "Linked resources" section covering: the two routes and their params; the DTO (point at `internal/linked/types.go` and `ui/src/api/types.ts`); on-demand fetch with the 2-minute cache, `refresh=1`, and why it is not polled; `resolve_links` gating outbound page fetches until the tab opens; Jira hierarchy from `parent` + `parent = KEY` (not Epic Link/Parent Link); the reverse "Referenced by Jira" lookup reading only cached `git_pull_request_urls` (which requires `git_pull_request` in `config.yaml`'s `jira.custom_fields`); `LinkedActionsContext` supplied by `WorktreeDetailPage`. In `.claude/CLAUDE.md`'s `internal/` list add:

```markdown
  - `linked` — assembles the detail pane's "Linked Resources" tab (PR
    description links, Jira Git PR field / description / hierarchy / issue
    links, Slack thread links) from watcher-library sources behind
    interfaces. Pure; the webui adapters and 2-minute cache live in
    `internal/webui/linked_api.go`. Fetched on demand, never polled.
```

In the spec, under Architecture, add a short "Deviations" note: no overflow count (`more: {url}` only, since `/search/jql` reports no total) and `favicon` instead of `favicon_url`.

- [ ] **Step 2: Full build + tests**

Run: `make build && make test && (cd ui && npm test)`
Expected: all pass.

- [ ] **Step 3: Install and verify against real data.** Run `NONINTERACTIVE=1 make install` (the running `worktree ui` restarts itself within ~5s; do not kill any mprocs process). In the web UI on a worktree, follow (as Related) and check:
  - **RHOAIENG-96640**: Git Pull Request section shows odh-dashboard PR #10187 with its state; Hierarchy shows RHAISTRAT-1988 (Feature) → RHOAIENG-96533 (Epic, expanded) → RHOAIENG-96640 marked "this issue", with sibling stories; the other epics under the feature are collapsed and expand lazily.
  - **RHOAIENG-62835**: its 8 sub-tasks are its children in the tree.
  - **RHOAIENG-96533**: Linked work items shows an "is related to" group.
  - A followed PR with Jira links in its body: Linked in description shows the issues with type/status; "Referenced by Jira" lists any followed Jira issue whose Git PR field names it (after one poll cycle, since `git_pull_request_urls` is new).
  - A Slack thread containing PR/Jira/Slack links: Thread tab default; switching to Linked Resources and back keeps a typed composer draft; the sticky composer still sticks.
  - Follow opens the modal with Related preselected; after adding, the row says "View in worktree" and clicking it selects that resource. Open on an issue already open in cmux says "Switch to tab" and switches. Copy link copies.
  - Switching resources while on the Linked tab resets to Activity/Thread.

  Use Playwright per `~/.agents/context/playwright.md` if driving the UI from the agent; otherwise ask Mike to check it.

- [ ] **Step 4: Commit**

```bash
git add docs/web-ui-architecture.md .claude/CLAUDE.md docs/superpowers/specs/2026-10-09-linked-resources-tab-design.md
git commit --signoff -m "docs: Linked Resources tab architecture notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
