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

func putAuth(s *Server, host, email string) *httptest.ResponseRecorder {
	return doReq(s, "PUT", "/api/settings/watcher-auth",
		`{"jira":{"host":"`+host+`","email":"`+email+`"},"slack":{"workspace_domain":"x.slack.com"}}`)
}

func TestWatcherAuthHostChangeWithStoredTokenRefused(t *testing.T) {
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
	s, _ := settingsServer(t, "")
	if rec := putAuth(s, "https://z.atlassian.net", "z@z"); rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
}

func TestWatcherAuthHostCaseAndSlashNotAChange(t *testing.T) {
	s, _ := settingsServer(t, "")
	if err := os.WriteFile(s.WatcherAuthPath, []byte(authYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	if rec := putAuth(s, "HTTPS://X.atlassian.net/", "me@x.com"); rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
}

func TestWatcherConfigPutRejectsDuplicateTrimmedNames(t *testing.T) {
	s, _ := settingsServer(t, "")
	rec := doReq(s, "PUT", "/api/settings/watcher-config", `{"jira":{"bot_usernames":[],"custom_fields":{"epic":"a"," epic ":"b"}}}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "duplicate custom field name: epic") {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
}
