package jira

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	wconfig "github.com/mturley/watcher/config"
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
// ("https://example.atlassian.net") — the shared watcher auth.yaml stores the
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

// HostFromWatcherConfig returns the Jira host configured in the shared
// watcher auth.yaml (wcfg.Services.Jira), or "" if Jira isn't configured
// there. worktree's own config.yaml no longer stores Jira credentials —
// only Projects (see internal/config.JiraConfig) — so building a Jira issue
// URL requires reading the host from the watcher config.
func HostFromWatcherConfig() string {
	wcfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		return ""
	}
	creds, err := wcfg.Jira()
	if err != nil {
		return ""
	}
	return creds.Host
}
