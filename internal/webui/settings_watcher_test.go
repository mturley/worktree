package webui

import (
	"net/http"
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
	s, _ := settingsServer(t, "")
	if err := os.WriteFile(s.WatcherAuthPath, []byte(authYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := doReq(s, "PUT", "/api/settings/watcher-auth", `{"jira":{"host":"https://z.atlassian.net/","email":"z@z"},"slack":{"workspace_domain":"z.slack.com"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	data, _ := os.ReadFile(s.WatcherAuthPath)
	for _, want := range []string{"JIRA_SECRET2", "xoxd-SECRET4", "/tmp/w.db", "https://z.atlassian.net\n", "z.slack.com"} {
		if !strings.Contains(string(data), want) {
			t.Errorf("auth.yaml lost %q:\n%s", want, data)
		}
	}
}

func TestWatcherAuthPutValidatesHost(t *testing.T) {
	s, _ := settingsServer(t, "")
	rec := doReq(s, "PUT", "/api/settings/watcher-auth", `{"jira":{"host":"not a url","email":""},"slack":{"workspace_domain":""}}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestWatcherConfigPutRejectsBlankField(t *testing.T) {
	s, _ := settingsServer(t, "")
	rec := doReq(s, "PUT", "/api/settings/watcher-config", `{"jira":{"bot_usernames":[],"custom_fields":{"epic_key":" "}}}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d", rec.Code)
	}
}
