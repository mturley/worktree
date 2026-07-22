package github

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

type PRInfo struct {
	Number    int
	Title     string
	URL       string
	HeadRef   string
	HeadOwner string
	Author    string
	State     string
	Body      string
}

var prURLPattern = regexp.MustCompile(`github\.com/([^/]+)/([^/]+)/pull/(\d+)`)

func ParsePRURL(url string) (owner, repo string, number int, ok bool) {
	m := prURLPattern.FindStringSubmatch(url)
	if m == nil {
		return "", "", 0, false
	}
	n, _ := strconv.Atoi(m[3])
	return m[1], m[2], n, true
}

func IsPRNumber(s string) bool {
	_, err := strconv.Atoi(s)
	return err == nil && len(s) > 0
}

func FetchPR(repoDir string, number int) (*PRInfo, error) {
	if !isGHAvailable() {
		return nil, fmt.Errorf("gh CLI not installed")
	}

	cmd := exec.Command("gh", "pr", "view", strconv.Itoa(number),
		"--json", "number,title,url,headRefName,headRepositoryOwner,author,state,body",
		"--repo", repoSlugFromDir(repoDir),
	)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("gh pr view: %w", err)
	}

	var raw struct {
		Number              int    `json:"number"`
		Title               string `json:"title"`
		URL                 string `json:"url"`
		HeadRefName         string `json:"headRefName"`
		HeadRepositoryOwner struct {
			Login string `json:"login"`
		} `json:"headRepositoryOwner"`
		Author struct {
			Login string `json:"login"`
		} `json:"author"`
		State string `json:"state"`
		Body  string `json:"body"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("parsing PR data: %w", err)
	}

	return &PRInfo{
		Number:    raw.Number,
		Title:     raw.Title,
		URL:       raw.URL,
		HeadRef:   raw.HeadRefName,
		HeadOwner: raw.HeadRepositoryOwner.Login,
		Author:    raw.Author.Login,
		State:     raw.State,
		Body:      raw.Body,
	}, nil
}

func FetchPRByRepo(owner, repo string, number int) (*PRInfo, error) {
	if !isGHAvailable() {
		return nil, fmt.Errorf("gh CLI not installed")
	}

	cmd := exec.Command("gh", "pr", "view", strconv.Itoa(number),
		"--json", "number,title,url,headRefName,headRepositoryOwner,author,state,body",
		"--repo", owner+"/"+repo,
	)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("gh pr view: %w", err)
	}

	var raw struct {
		Number              int    `json:"number"`
		Title               string `json:"title"`
		URL                 string `json:"url"`
		HeadRefName         string `json:"headRefName"`
		HeadRepositoryOwner struct {
			Login string `json:"login"`
		} `json:"headRepositoryOwner"`
		Author struct {
			Login string `json:"login"`
		} `json:"author"`
		State string `json:"state"`
		Body  string `json:"body"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("parsing PR data: %w", err)
	}

	return &PRInfo{
		Number:    raw.Number,
		Title:     raw.Title,
		URL:       raw.URL,
		HeadRef:   raw.HeadRefName,
		HeadOwner: raw.HeadRepositoryOwner.Login,
		Author:    raw.Author.Login,
		State:     raw.State,
		Body:      raw.Body,
	}, nil
}

func Slugify(title string) string {
	s := strings.ToLower(title)
	s = regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 50 {
		s = s[:50]
		if last := strings.LastIndex(s, "-"); last > 20 {
			s = s[:last]
		}
	}
	return s
}

func isGHAvailable() bool {
	_, err := exec.LookPath("gh")
	return err == nil
}

func repoSlugFromDir(dir string) string {
	cmd := exec.Command("git", "-C", dir, "remote")
	remoteOut, err := cmd.Output()
	if err != nil {
		return ""
	}
	for _, remote := range strings.Fields(string(remoteOut)) {
		urlCmd := exec.Command("git", "-C", dir, "remote", "get-url", remote)
		out, err := urlCmd.Output()
		if err != nil {
			continue
		}
		url := strings.TrimSpace(string(out))
		url = strings.TrimSuffix(url, ".git")
		if idx := strings.LastIndex(url, ":"); idx >= 0 && !strings.Contains(url[idx:], "/") {
			return url[idx+1:]
		}
		parts := strings.Split(url, "/")
		if len(parts) >= 2 {
			return parts[len(parts)-2] + "/" + parts[len(parts)-1]
		}
	}
	return ""
}
