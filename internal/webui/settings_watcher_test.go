package webui

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

const authYAML = `services:
    github:
        token: ghp_SECRET1
    jira:
        host: https://x.atlassian.net
        email: me@x.com
        token: JIRA_SECRET2
    slack:
        token: xoxc-SECRET3
        cookie: xoxd-SECRET4
        workspace_domain: x.slack.com
consumers:
    worktree:
        db: /tmp/w.db
`

func TestWatcherSettingsGetHidesSecrets(t *testing.T) {
	t.Parallel()
	s, _ := settingsServer(t, "ui:\n    password: PW_SECRET5\n")
	if err := os.WriteFile(s.WatcherAuthPath, []byte(authYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := doReq(s, "GET", "/api/settings", "")
	for _, secret := range []string{"ghp_SECRET1", "JIRA_SECRET2", "xoxc-SECRET3", "xoxd-SECRET4", "PW_SECRET5"} {
		if strings.Contains(rec.Body.String(), secret) {
			t.Fatalf("response leaks %s: %s", secret, rec.Body)
		}
	}
	got := decodeSettings(t, rec)
	if !got.Secrets.GitHubToken || !got.Secrets.JiraToken || !got.Secrets.SlackToken || !got.Secrets.SlackCookie || !got.Secrets.UIPassword {
		t.Fatalf("secrets = %+v", got.Secrets)
	}
	if got.WatcherAuth.Jira.Host != "https://x.atlassian.net" || got.WatcherAuth.Slack.WorkspaceDomain != "x.slack.com" {
		t.Fatalf("auth = %+v", got.WatcherAuth)
	}
	if strings.Contains(rec.Body.String(), "consumers") || strings.Contains(rec.Body.String(), "/tmp/w.db") {
		t.Fatal("consumers must not be exposed")
	}
}

func TestWatcherSettingsMissingFiles(t *testing.T) {
	t.Parallel()
	s, _ := settingsServer(t, "")
	got := decodeSettings(t, doReq(s, "GET", "/api/settings", ""))
	if got.WatcherConfig.Jira.BotUsernames == nil || got.WatcherConfig.Jira.CustomFields == nil {
		t.Fatal("empty watcher config must be [] / {}")
	}
	rec := doReq(s, "PUT", "/api/settings/watcher-auth", `{"jira":{"host":"https://y.atlassian.net","email":"a@b"},"slack":{"workspace_domain":""}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	info, err := os.Stat(s.WatcherAuthPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("auth.yaml: %v %v", info, err)
	}
	rec = doReq(s, "PUT", "/api/settings/watcher-config", `{"jira":{"bot_usernames":["bot"],"custom_fields":{"epic_key":"customfield_1"}}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	got = decodeSettings(t, rec)
	if got.WatcherConfig.Jira.CustomFields["epic_key"] != "customfield_1" {
		t.Fatalf("got %+v", got.WatcherConfig)
	}
}

func TestWatcherAuthPutKeepsSecretsAndConsumers(t *testing.T) {
	t.Parallel()
	s, _ := settingsServer(t, "")
	if err := os.WriteFile(s.WatcherAuthPath, []byte(authYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := doReq(s, "PUT", "/api/settings/watcher-auth", `{"jira":{"host":"https://x.atlassian.net/","email":"z@z"},"slack":{"workspace_domain":"z.slack.com"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	data, _ := os.ReadFile(s.WatcherAuthPath)
	for _, want := range []string{"JIRA_SECRET2", "xoxd-SECRET4", "/tmp/w.db", "email: z@z", "z.slack.com"} {
		if !strings.Contains(string(data), want) {
			t.Errorf("auth.yaml lost %q:\n%s", want, data)
		}
	}
}

func TestWatcherAuthPutValidatesHost(t *testing.T) {
	t.Parallel()
	s, _ := settingsServer(t, "")
	rec := doReq(s, "PUT", "/api/settings/watcher-auth", `{"jira":{"host":"not a url","email":""},"slack":{"workspace_domain":""}}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestWatcherConfigPutRejectsBlankField(t *testing.T) {
	t.Parallel()
	s, _ := settingsServer(t, "")
	rec := doReq(s, "PUT", "/api/settings/watcher-config", `{"jira":{"bot_usernames":[],"custom_fields":{"epic_key":" "}}}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d", rec.Code)
	}
}

func putAuth(s *Server, host, email string) *httptest.ResponseRecorder {
	return doReq(s, "PUT", "/api/settings/watcher-auth",
		`{"jira":{"host":"`+host+`","email":"`+email+`"},"slack":{"workspace_domain":"x.slack.com"}}`)
}

func TestWatcherAuthHostChangeWithStoredTokenRefused(t *testing.T) {
	t.Parallel()
	s, _ := settingsServer(t, "")
	if err := os.WriteFile(s.WatcherAuthPath, []byte(authYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := putAuth(s, "https://evil.example.com", "me@x.com")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Changing the Jira host needs the API token too: enter it under API token and press Replace.") {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if got, _ := os.ReadFile(s.WatcherAuthPath); string(got) != authYAML {
		t.Fatalf("auth.yaml changed:\n%s", got)
	}
}

func TestWatcherAuthEmailOnlyChangeAllowed(t *testing.T) {
	t.Parallel()
	s, _ := settingsServer(t, "")
	if err := os.WriteFile(s.WatcherAuthPath, []byte(authYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	if rec := putAuth(s, "https://x.atlassian.net", "new@x.com"); rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if got, _ := os.ReadFile(s.WatcherAuthPath); !strings.Contains(string(got), "email: new@x.com") {
		t.Fatalf("not saved:\n%s", got)
	}
}

func TestWatcherAuthHostChangeWithoutTokenAllowed(t *testing.T) {
	t.Parallel()
	s, _ := settingsServer(t, "")
	if rec := putAuth(s, "https://z.atlassian.net", "z@z"); rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
}

func TestWatcherAuthHostCaseAndSlashNotAChange(t *testing.T) {
	t.Parallel()
	s, _ := settingsServer(t, "")
	if err := os.WriteFile(s.WatcherAuthPath, []byte(authYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	if rec := putAuth(s, "HTTPS://X.atlassian.net/", "me@x.com"); rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
}

func TestWatcherConfigPutRejectsDuplicateTrimmedNames(t *testing.T) {
	t.Parallel()
	s, _ := settingsServer(t, "")
	rec := doReq(s, "PUT", "/api/settings/watcher-config", `{"jira":{"bot_usernames":[],"custom_fields":{"epic":"a"," epic ":"b"}}}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "duplicate custom field name: epic") {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
}

func TestWatcherConfigGitHubBotUsernames(t *testing.T) {
	t.Parallel()
	s, _ := settingsServer(t, "")
	s.DB = unreadTestDB(t)
	insertUnreadEvent(t, s.DB, "ci", "2026-01-01T00:00:00Z", "github", "pr", "o/r#1")
	insertUnreadEvent(t, s.DB, "human", "2026-01-01T00:00:01Z", "github", "pr", "o/r#1")
	if _, err := s.DB.Exec(`UPDATE watcher_events SET author = CASE id WHEN 'ci' THEN 'rhods-ci-bot' ELSE 'alice' END, author_type = 'user'`); err != nil {
		t.Fatal(err)
	}
	authorType := func(id string) string {
		t.Helper()
		var at string
		if err := s.DB.QueryRow(`SELECT author_type FROM watcher_events WHERE id = ?`, id).Scan(&at); err != nil {
			t.Fatal(err)
		}
		return at
	}

	got := decodeSettings(t, doReq(s, "GET", "/api/settings", ""))
	if got.WatcherConfig.GitHub == nil || got.WatcherConfig.GitHub.BotUsernames == nil {
		t.Fatal("an empty github block must still be sent, as []")
	}
	rec := doReq(s, "PUT", "/api/settings/watcher-config", `{"github":{"bot_usernames":[" *ci-bot* ",""]},"jira":{"bot_usernames":[],"custom_fields":{}}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if got := decodeSettings(t, rec).WatcherConfig.GitHub.BotUsernames; len(got) != 1 || got[0] != "*ci-bot*" {
		t.Fatalf("saved %v, want [*ci-bot*]", got)
	}
	// The save re-marks events already stored.
	if authorType("ci") != "bot" || authorType("human") != "user" {
		t.Fatalf("after save: ci=%s human=%s, want bot/user", authorType("ci"), authorType("human"))
	}
	// A PUT without the github block (an older client) leaves it alone.
	rec = doReq(s, "PUT", "/api/settings/watcher-config", `{"jira":{"bot_usernames":["jbot"],"custom_fields":{}}}`)
	if got := decodeSettings(t, rec).WatcherConfig.GitHub.BotUsernames; len(got) != 1 || got[0] != "*ci-bot*" {
		t.Fatalf("absent github block changed the list to %v", got)
	}
	// An empty list clears it.
	rec = doReq(s, "PUT", "/api/settings/watcher-config", `{"github":{"bot_usernames":[]},"jira":{"bot_usernames":[],"custom_fields":{}}}`)
	if got := decodeSettings(t, rec).WatcherConfig.GitHub.BotUsernames; len(got) != 0 {
		t.Fatalf("cleared list is %v", got)
	}
	// Kept as an empty block, so `worktree setup` does not reseed it.
	data, _ := os.ReadFile(s.WatcherConfigPath)
	if !strings.Contains(string(data), "github: {}") {
		t.Fatalf("a cleared list must stay as github: {}:\n%s", data)
	}
}

func TestWatcherConfigPutLeavesUnsetGitHubBlockAbsent(t *testing.T) {
	t.Parallel()
	s, _ := settingsServer(t, "")
	rec := doReq(s, "PUT", "/api/settings/watcher-config", `{"github":{"bot_usernames":[]},"jira":{"bot_usernames":["jbot"],"custom_fields":{}}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	data, _ := os.ReadFile(s.WatcherConfigPath)
	if strings.Contains(string(data), "github") {
		t.Fatalf("saving another setting must not create a github block (setup seeds only an absent one):\n%s", data)
	}
}

func TestGitHubPollOptionsReadBotUsernames(t *testing.T) {
	t.Parallel()
	s, _ := settingsServer(t, "")
	if got := s.githubPollOptions().BotUsernames; len(got) != 0 {
		t.Fatalf("no config: %v", got)
	}
	if err := os.WriteFile(s.WatcherConfigPath, []byte("github:\n  bot_usernames:\n    - \"*ci-bot*\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := s.githubPollOptions().BotUsernames; len(got) != 1 || got[0] != "*ci-bot*" {
		t.Fatalf("got %v", got)
	}
}
