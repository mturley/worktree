package jira

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

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

func NewClient(cfg config.JiraConfig) (*Client, error) {
	if cfg.Host == "" || cfg.Email == "" {
		return nil, fmt.Errorf("jira host and email must be configured")
	}
	if cfg.Token == "" {
		return nil, fmt.Errorf("jira token not configured (run worktree setup)")
	}
	token := cfg.Token
	return &Client{host: cfg.Host, email: cfg.Email, token: token}, nil
}

func (c *Client) FetchIssue(key string) (*Issue, error) {
	url := fmt.Sprintf("https://%s/rest/api/2/issue/%s?fields=summary,issuetype,status,priority,assignee", c.host, key)

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
		URL:      fmt.Sprintf("https://%s/browse/%s", c.host, raw.Key),
	}, nil
}

func (c *Client) TestConnection() error {
	url := fmt.Sprintf("https://%s/rest/api/2/myself", c.host)
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
	return fmt.Sprintf("https://%s/browse/%s", host, key)
}
