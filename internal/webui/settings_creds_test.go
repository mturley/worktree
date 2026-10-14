package webui

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	wslack "github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/uisession"
)

type credLog struct{ github, jira, slack [][]string }

func credServer(t *testing.T, githubErr, jiraErr, slackErr error) (*Server, *credLog) {
	t.Helper()
	s, _ := settingsServer(t, "ui:\n    password: old\n")
	if err := os.WriteFile(s.WatcherAuthPath, []byte(authYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	log := &credLog{}
	s.credCheck = &credValidators{
		github: func(tok string) error { log.github = append(log.github, []string{tok}); return githubErr },
		jira: func(h, e, tok string) error {
			log.jira = append(log.jira, []string{h, e, tok})
			return jiraErr
		},
		slack:       func(tok, ck string) error { log.slack = append(log.slack, []string{tok, ck}); return slackErr },
		slackDomain: func(tok, ck string) string { return "new.slack.com" },
	}
	return s, log
}

func decodeCredResult(t *testing.T, body string) credResult {
	t.Helper()
	var r credResult
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestCredTestStored(t *testing.T) {
	s, log := credServer(t, nil, nil, nil)
	rec := doReq(s, "POST", "/api/settings/credentials/github/test", `{}`)
	if r := decodeCredResult(t, rec.Body.String()); !r.OK || r.Kind != "ok" || log.github[0][0] != "ghp_SECRET1" {
		t.Fatalf("rec=%s log=%v", rec.Body, log.github)
	}
}

func TestCredTestKinds(t *testing.T) {
	s, _ := credServer(t, wgithub.ErrAuth, errors.New("dial tcp: timeout"), nil)
	if r := decodeCredResult(t, doReq(s, "POST", "/api/settings/credentials/github/test", `{}`).Body.String()); r.Kind != "auth" {
		t.Fatalf("github kind = %q", r.Kind)
	}
	if r := decodeCredResult(t, doReq(s, "POST", "/api/settings/credentials/jira/test", `{}`).Body.String()); r.Kind != "network" {
		t.Fatalf("jira kind = %q", r.Kind)
	}
}

func TestCredTestJiraEmailOverrideSameHost(t *testing.T) {
	s, log := credServer(t, nil, nil, nil)
	doReq(s, "POST", "/api/settings/credentials/jira/test", `{"host":"HTTPS://X.atlassian.net/","email":"f@f"}`)
	if len(log.jira) != 1 {
		t.Fatalf("validator calls = %v", log.jira)
	}
	if got := log.jira[0]; got[1] != "f@f" || got[2] != "JIRA_SECRET2" {
		t.Fatalf("got %v", got)
	}
}

func TestCredTestJiraDifferentHostIsUnsaved(t *testing.T) {
	s, _ := credServer(t, nil, nil, nil)
	s.credCheck.jira = func(h, e, tok string) error {
		t.Fatal("must not send the stored token to an unsaved host")
		return nil
	}
	rec := doReq(s, "POST", "/api/settings/credentials/jira/test", `{"host":"https://evil.example","email":"f@f"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if r := decodeCredResult(t, rec.Body.String()); r.OK || r.Kind != "unsaved" {
		t.Fatalf("result %+v", r)
	}
}

func readAuth(t *testing.T, s *Server) string {
	t.Helper()
	data, err := os.ReadFile(s.WatcherAuthPath)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestReplaceJiraRefusedWritesNothing(t *testing.T) {
	s, _ := credServer(t, nil, wjira.ErrAuth, nil)
	rec := doReq(s, "PUT", "/api/settings/credentials/jira", `{"token":"J_NEW","host":"https://n.atlassian.net","email":"n@n"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status %d", rec.Code)
	}
	if got := readAuth(t, s); got != authYAML {
		t.Fatalf("auth.yaml changed:\n%s", got)
	}
}

func TestReplaceSlackRefusedWritesNothing(t *testing.T) {
	s, _ := credServer(t, nil, nil, errors.New("network down"))
	rec := doReq(s, "PUT", "/api/settings/credentials/slack", `{"token":"xoxc-NEW"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status %d", rec.Code)
	}
	if got := readAuth(t, s); got != authYAML {
		t.Fatalf("auth.yaml changed:\n%s", got)
	}
}

func TestReplaceSlackOneHalfStoredOtherMissing(t *testing.T) {
	s, log := credServer(t, nil, nil, nil)
	if err := os.WriteFile(s.WatcherAuthPath, []byte("services:\n    slack:\n        token: xoxc-ONLY\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := doReq(s, "PUT", "/api/settings/credentials/slack", `{"token":"xoxc-NEW"}`)
	if rec.Code != http.StatusUnprocessableEntity || decodeCredResult(t, rec.Body.String()).Kind != "missing" {
		t.Fatalf("status %d %s", rec.Code, rec.Body)
	}
	if len(log.slack) != 0 {
		t.Fatalf("validator called: %v", log.slack)
	}
}

func TestReplaceSlackDomainFallsBack(t *testing.T) {
	s, _ := credServer(t, nil, nil, nil)
	s.credCheck.slackDomain = func(tok, ck string) string { return "" }
	rec := doReq(s, "PUT", "/api/settings/credentials/slack", `{"cookie":"xoxd-NEW"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d %s", rec.Code, rec.Body)
	}
	if got := readAuth(t, s); !strings.Contains(got, "workspace_domain: x.slack.com") {
		t.Fatalf("auth.yaml:\n%s", got)
	}
}

func TestReplaceSuccessNeverEchoesSecrets(t *testing.T) {
	s, _ := credServer(t, nil, nil, nil)
	for _, c := range []struct{ svc, body, secret string }{
		{"jira", `{"token":"J_NEW_SECRET","host":"https://n.atlassian.net","email":"n@n"}`, "J_NEW_SECRET"},
		{"slack", `{"token":"xoxc-NEW_SECRET","cookie":"xoxd-NEW_SECRET"}`, "NEW_SECRET"},
	} {
		rec := doReq(s, "PUT", "/api/settings/credentials/"+c.svc, c.body)
		if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), c.secret) {
			t.Fatalf("%s: status %d body %s", c.svc, rec.Code, rec.Body)
		}
	}
}

func TestCredTestMissing(t *testing.T) {
	s, _ := settingsServer(t, "")
	s.credCheck = &credValidators{github: func(string) error { t.Fatal("must not validate"); return nil }}
	if r := decodeCredResult(t, doReq(s, "POST", "/api/settings/credentials/github/test", `{}`).Body.String()); r.Kind != "missing" {
		t.Fatalf("kind = %q", r.Kind)
	}
}

func TestReplaceRefusesInvalidAndWritesNothing(t *testing.T) {
	for _, verr := range []error{wgithub.ErrAuth, errors.New("network down")} {
		s, _ := credServer(t, verr, nil, nil)
		rec := doReq(s, "PUT", "/api/settings/credentials/github", `{"token":"ghp_NEW"}`)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d", rec.Code)
		}
		data, _ := os.ReadFile(s.WatcherAuthPath)
		if strings.Contains(string(data), "ghp_NEW") || !strings.Contains(string(data), "ghp_SECRET1") {
			t.Fatalf("auth.yaml changed:\n%s", data)
		}
	}
}

func TestReplaceGitHubWrites(t *testing.T) {
	s, _ := credServer(t, nil, nil, nil)
	rec := doReq(s, "PUT", "/api/settings/credentials/github", `{"token":" ghp_NEW "}`)
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "ghp_NEW") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body)
	}
	data, _ := os.ReadFile(s.WatcherAuthPath)
	if !strings.Contains(string(data), "token: ghp_NEW") || !strings.Contains(string(data), "/tmp/w.db") {
		t.Fatalf("auth.yaml:\n%s", data)
	}
}

func TestReplaceJiraWritesTriple(t *testing.T) {
	s, _ := credServer(t, nil, nil, nil)
	rec := doReq(s, "PUT", "/api/settings/credentials/jira", `{"token":"J2","host":"https://n.atlassian.net/","email":"n@n"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d %s", rec.Code, rec.Body)
	}
	data, _ := os.ReadFile(s.WatcherAuthPath)
	for _, want := range []string{"host: https://n.atlassian.net\n", "email: n@n", "token: J2"} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("missing %q:\n%s", want, data)
		}
	}
}

func TestReplaceSlackCookieOnlyUsesStoredToken(t *testing.T) {
	s, log := credServer(t, nil, nil, nil)
	rec := doReq(s, "PUT", "/api/settings/credentials/slack", `{"cookie":"xoxd-NEW"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d %s", rec.Code, rec.Body)
	}
	if got := log.slack[0]; got[0] != "xoxc-SECRET3" || got[1] != "xoxd-NEW" {
		t.Fatalf("validated %v", got)
	}
	data, _ := os.ReadFile(s.WatcherAuthPath)
	for _, want := range []string{"token: xoxc-SECRET3", "cookie: xoxd-NEW", "workspace_domain: new.slack.com"} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("missing %q:\n%s", want, data)
		}
	}
}

func TestReplaceSlackAuthError(t *testing.T) {
	s, _ := credServer(t, nil, nil, wslack.ErrAuth)
	rec := doReq(s, "PUT", "/api/settings/credentials/slack", `{"token":"xoxc-NEW"}`)
	if rec.Code != http.StatusUnprocessableEntity || decodeCredResult(t, rec.Body.String()).Kind != "auth" {
		t.Fatalf("status %d %s", rec.Code, rec.Body)
	}
}

func TestReplaceRejectsEmpty(t *testing.T) {
	s, _ := credServer(t, nil, nil, nil)
	for _, c := range []struct {
		svc, body string
		want      int
	}{
		{"github", `{"token":""}`, http.StatusBadRequest},
		{"slack", `{}`, http.StatusBadRequest},
		{"jira", `{"token":"t","host":"","email":""}`, http.StatusBadRequest},
		{"nope", `{"token":"t"}`, http.StatusNotFound},
	} {
		if rec := doReq(s, "PUT", "/api/settings/credentials/"+c.svc, c.body); rec.Code != c.want {
			t.Fatalf("%s: status %d, want %d", c.svc, rec.Code, c.want)
		}
	}
}

func TestPasswordReplaceAppliesLive(t *testing.T) {
	s, path := settingsServer(t, "# c\nui:\n    password: old\n")
	s.Security = &Security{Password: "old", Sessions: &uisession.Store{}}
	if rec := doPassword(s, `{"password":"new-pw"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d %s", rec.Code, rec.Body)
	}
	if s.Security.password() != "new-pw" {
		t.Fatal("live password not swapped")
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "password: new-pw") || !strings.Contains(string(data), "# c") {
		t.Fatalf("file:\n%s", data)
	}
	if rec := doPassword(s, `{"password":"  "}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("blank: status %d", rec.Code)
	}
	if rec := doPassword(s, `{"password":" spaced pw "}`); rec.Code != http.StatusNoContent || s.Security.password() != " spaced pw " {
		t.Fatalf("verbatim: status %d, password %q", rec.Code, s.Security.password())
	}
}

// doPassword calls the handler directly: with Security set, Handler() would
// demand a login and an allowed Host.
func doPassword(s *Server, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	s.handlePasswordReplace(rec, httptest.NewRequest("PUT", "/api/settings/password", strings.NewReader(body)))
	return rec
}
