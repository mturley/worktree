package webui

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	wconfig "github.com/mturley/watcher/config"
	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/config"
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
	mu        sync.Mutex
	lastSweep time.Time
	entries   map[string]ttlEntry
	inflight  map[string]*ttlCall
	// now is the clock; tests replace it. nil means time.Now.
	now func() time.Time
}

type ttlEntry struct {
	val     interface{}
	err     error
	expires time.Time
}

func (c *ttlCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
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
func (c *ttlCache) get(key string, ttl time.Duration, bypass bool, fn func() (interface{}, error)) (val interface{}, err error) {
	return c.getErrTTL(key, ttl, 0, bypass, fn)
}

// getErrTTL is get, but an error is cached too, for errTTL (never when
// errTTL is 0), so a failing upstream is not asked again on every call.
func (c *ttlCache) getErrTTL(key string, ttl, errTTL time.Duration, bypass bool, fn func() (interface{}, error)) (val interface{}, err error) {
	c.mu.Lock()
	if e, ok := c.entries[key]; ok && !bypass && c.clock().Before(e.expires) {
		c.mu.Unlock()
		return e.val, e.err
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

	// The deferred cleanup runs even if fn panics, so waiters are released
	// (with an error) and the key is never wedged.
	defer func() {
		if rec := recover(); rec != nil {
			call.val, call.err = nil, fmt.Errorf("linked: computation panicked: %v", rec)
		}
		c.mu.Lock()
		if c.inflight[key] == call {
			delete(c.inflight, key)
		}
		switch {
		case call.err == nil:
			now := c.clock()
			c.sweepLocked(now)
			c.entries[key] = ttlEntry{val: call.val, expires: now.Add(ttl)}
		case errTTL > 0:
			now := c.clock()
			c.sweepLocked(now)
			c.entries[key] = ttlEntry{err: call.err, expires: now.Add(errTTL)}
		}
		c.mu.Unlock()
		call.wg.Done()
		val, err = call.val, call.err
	}()
	call.val, call.err = fn()
	return call.val, call.err
}

// del drops keys' cached values. A computation already in flight still
// stores its result when it finishes.
// peek is key's cached value when it is present, unexpired and not an
// error. It never fetches.
func (c *ttlCache) peek(key string) (interface{}, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || e.err != nil || !c.clock().Before(e.expires) {
		return nil, false
	}
	return e.val, true
}

func (c *ttlCache) del(keys ...string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, k := range keys {
		delete(c.entries, k)
	}
}

// sweepInterval bounds how often inserts scan for expired entries.
const sweepInterval = time.Minute

// sweepLocked drops expired entries, at most once per sweepInterval. The
// caller holds c.mu.
func (c *ttlCache) sweepLocked(now time.Time) {
	if now.Sub(c.lastSweep) < sweepInterval {
		return
	}
	c.lastSweep = now
	for k, e := range c.entries {
		if !now.Before(e.expires) {
			delete(c.entries, k)
		}
	}
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
type metaResolver interface {
	Resolve(ctx context.Context, u string) linkmeta.Meta
}

type cachedLinkResolver struct {
	r     metaResolver
	cache *ttlCache
}

func (c cachedLinkResolver) Resolve(ctx context.Context, u string) linkmeta.Meta {
	v, _ := c.cache.get("meta|"+u, linkMetaTTL, false, func() (interface{}, error) {
		m := c.r.Resolve(ctx, u)
		// A cancelled fetch may be degraded; return it but don't cache it.
		return m, ctx.Err()
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
			if t, id, ok := resourceurl.Infer(u); ok && t == "pr" && samePRID(id, prID) {
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

// samePRID compares "owner/repo#N" ids with owner/repo case-insensitively
// (GitHub names are) and the number exactly.
func samePRID(a, b string) bool {
	ra, na, oka := strings.Cut(a, "#")
	rb, nb, okb := strings.Cut(b, "#")
	return oka && okb && na == nb && strings.EqualFold(ra, rb)
}

// linkedSources builds Sources from the watcher config. Unconfigured
// services, and services whose watcher is off, are left nil, which the
// builder treats as "not configured": their links still list, unenriched,
// and their credentials are never read.
func (s *Server) linkedSources() linked.Sources {
	if s.LinkedSources != nil {
		return s.LinkedSources()
	}
	var src linked.Sources
	src.Links = cachedLinkResolver{r: s.linkResolver(), cache: s.linkedCacheOrInit()}
	if s.slackOn() {
		src.Slack = slackAdapter{s}
	}
	cfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		return src
	}
	if gh, err := cfg.GitHub(); err == nil && s.WatcherEnabled(config.ServiceGitHub) {
		src.PR = prAdapter{token: gh.Token}
	}
	if jc, err := cfg.Jira(); err == nil && s.WatcherEnabled(config.ServiceJira) {
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

// validLinkedID reports whether id is well-formed for the resource type, so
// a malformed id is a 400 rather than a 502 from the upstream service.
func validLinkedID(resType, id string) bool {
	switch resType {
	case "pr":
		_, err := wgithub.ParsePRResourceID(id)
		return err == nil
	case "jira":
		_, ok := wtjira.ParseKey(id)
		return ok
	case "slack":
		ch, ts, ok := strings.Cut(id, ":")
		return ok && ch != "" && ts != ""
	}
	return false
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
	if !validLinkedID(resType, id) {
		writeError(w, http.StatusBadRequest, "invalid id for type "+resType)
		return
	}
	if svc := serviceForType(resType); !s.WatcherEnabled(svc) {
		watcherOffError(w, serviceName(svc))
		return
	}
	resolveLinks := q.Get("resolve_links") == "1"
	key := "linked|" + resType + "|" + id + "|" + q.Get("resolve_links")
	v, err := s.linkedCacheOrInit().get(key, linkedTTL, q.Get("refresh") == "1", func() (interface{}, error) {
		b := &linked.Builder{Src: s.linkedSources()}
		res, err := b.Build(r.Context(), resType, id, resolveLinks)
		if err == nil && r.Context().Err() != nil {
			return nil, r.Context().Err()
		}
		return res, err
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
	if !s.WatcherEnabled(config.ServiceJira) {
		watcherOffError(w, "Jira")
		return
	}
	type resp struct {
		Items []*linked.TreeNode `json:"items"`
		More  *linked.More       `json:"more"`
	}
	v, err := s.linkedCacheOrInit().get("children|"+key, linkedTTL, false, func() (interface{}, error) {
		b := &linked.Builder{Src: s.linkedSources()}
		items, more, err := b.Children(r.Context(), key)
		if err == nil {
			err = r.Context().Err()
		}
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
