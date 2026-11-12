package jira

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/worktree/internal/config"
)

type Issue struct {
	Key      string
	Summary  string
	Type     string
	Status   string
	Priority string
	Assignee string
	URL      string
}

type Client struct {
	host  string
	email string
	token string
}

func NewClient(host, email, token string) (*Client, error) {
	if host == "" || email == "" {
		return nil, fmt.Errorf("jira host and email must be configured")
	}
	if token == "" {
		return nil, fmt.Errorf("jira token not configured (run worktree setup)")
	}
	return &Client{host: host, email: email, token: token}, nil
}

// baseURL returns the client's host as a scheme-qualified origin. The host
// may be configured either bare ("example.atlassian.net") or as a full URL
// ("https://example.atlassian.net") — worktree's watcher-auth.yaml stores the
// latter — so normalize before building request URLs.
func (c *Client) baseURL() string {
	return normalizeHost(c.host)
}

func normalizeHost(host string) string {
	host = strings.TrimSuffix(host, "/")
	if strings.Contains(host, "://") {
		return host
	}
	return "https://" + host
}

func (c *Client) FetchIssue(key string) (*Issue, error) {
	url := fmt.Sprintf("%s/rest/api/2/issue/%s?fields=summary,issuetype,status,priority,assignee", c.baseURL(), key)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(c.email, c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("jira API returned %d: %s", resp.StatusCode, string(body))
	}

	var raw struct {
		Key    string `json:"key"`
		Fields struct {
			Summary   string `json:"summary"`
			IssueType struct {
				Name string `json:"name"`
			} `json:"issuetype"`
			Status struct {
				Name string `json:"name"`
			} `json:"status"`
			Priority struct {
				Name string `json:"name"`
			} `json:"priority"`
			Assignee *struct {
				DisplayName string `json:"displayName"`
			} `json:"assignee"`
		} `json:"fields"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}

	assignee := ""
	if raw.Fields.Assignee != nil {
		assignee = raw.Fields.Assignee.DisplayName
	}

	return &Issue{
		Key:      raw.Key,
		Summary:  raw.Fields.Summary,
		Type:     raw.Fields.IssueType.Name,
		Status:   raw.Fields.Status.Name,
		Priority: raw.Fields.Priority.Name,
		Assignee: assignee,
		URL:      fmt.Sprintf("%s/browse/%s", c.baseURL(), raw.Key),
	}, nil
}

func (c *Client) TestConnection() error {
	url := fmt.Sprintf("%s/rest/api/2/myself", c.baseURL())
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(c.email, c.token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		return fmt.Errorf("authentication failed (401) — check your email and token")
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	return nil
}

func IssueURL(host, key string) string {
	return fmt.Sprintf("%s/browse/%s", normalizeHost(host), key)
}

// ConfiguredHost returns the Jira host configured in worktree's
// watcher-auth.yaml (Services.Jira), or "" if Jira isn't configured there.
// worktree's config.yaml holds no Jira credentials, so building an issue
// URL reads the host from the credentials file.
func ConfiguredHost() string {
	wcfg, err := wconfig.Load(config.WatcherAuthPath())
	if err != nil {
		return ""
	}
	creds, err := wcfg.Jira()
	if err != nil {
		return ""
	}
	return creds.Host
}

// ConfiguredCustomFields returns the Jira custom-field IDs to fetch
// (jira.custom_fields in worktree's config.yaml). A missing or unreadable
// file gives an empty map.
func ConfiguredCustomFields() map[string]string {
	out := map[string]string{}
	if e, _, err := config.ReadEditable(config.ConfigPath()); err == nil {
		for k, v := range e.JiraCustomFields {
			out[k] = v
		}
	}
	return out
}

// ConfiguredIssueURL returns key's browse URL on the Jira host configured in
// worktree's watcher-auth.yaml, or "" when no host is configured — never a
// hostless "https:///browse/KEY", which IssueURL would build from an empty
// host.
func ConfiguredIssueURL(key string) string {
	host := ConfiguredHost()
	if host == "" {
		return ""
	}
	return IssueURL(host, key)
}
