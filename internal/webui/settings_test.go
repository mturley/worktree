package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/jira"
)

func settingsServer(t *testing.T, worktreeYAML string) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if worktreeYAML != "" {
		if err := os.WriteFile(path, []byte(worktreeYAML), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return &Server{
		cmuxAvailable:     func() bool { return true },
		ConfigPath:        path,
		WatcherAuthPath:   filepath.Join(dir, "auth.yaml"),
		WatcherConfigPath: filepath.Join(dir, "wconfig.yaml"),
	}, path
}

func doReq(s *Server, method, url, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func decodeSettings(t *testing.T, rec *httptest.ResponseRecorder) settingsDTO {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	var got settingsDTO
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestSettingsGetWorktreeSection(t *testing.T) {
	t.Parallel()
	s, _ := settingsServer(t, "worktrees_base: ~/wt\neditor: zed\njira:\n    projects: [ABC]\nui:\n    password: hunter2\n")
	got := decodeSettings(t, doReq(s, "GET", "/api/settings", ""))
	if got.Worktree.WorktreesBase != "~/wt" || got.Worktree.Editor != "zed" || got.Worktree.Jira.Projects[0] != "ABC" {
		t.Fatalf("worktree = %+v", got.Worktree)
	}
	if got.Worktree.UI.HTTPSPort != 8476 || !got.Worktree.CmuxFeaturesEnabled || !got.Secrets.UIPassword {
		t.Fatalf("got %+v", got)
	}
	if got.Worktree.Jira.AliasHosts == nil || got.Worktree.UI.AllowedHosts == nil {
		t.Fatal("lists must be [] not null")
	}
	if !got.Environment.InCmux {
		t.Fatal("in_cmux")
	}
	if strings.Contains(doReq(s, "GET", "/api/settings", "").Body.String(), "hunter2") {
		t.Fatal("password leaked in response body")
	}
}

func TestSettingsGetReportsEnvOverride(t *testing.T) {
	t.Setenv("WORKTREES_BASE", "/x")
	s, _ := settingsServer(t, "")
	if !decodeSettings(t, doReq(s, "GET", "/api/settings", "")).Environment.WorktreesBaseEnv {
		t.Fatal("worktrees_base_env should be true")
	}
}

func TestSettingsWorktreePutWritesAndValidates(t *testing.T) {
	t.Parallel()
	s, path := settingsServer(t, "# keep\nui:\n    password: pw\n")
	body := `{"worktrees_base":"~/wt","editor":"zed","cmux_features_enabled":true,
	  "jira":{"projects":[" ABC ","ABC",""],"alias_hosts":[]},
	  "ui":{"https_port":9443,"allowed_hosts":["h.local"],"tls":{"cert_file":"","key_file":""}}}`
	got := decodeSettings(t, doReq(s, "PUT", "/api/settings/worktree", body))
	if len(got.Worktree.Jira.Projects) != 1 || got.Worktree.Jira.Projects[0] != "ABC" {
		t.Fatalf("projects not trimmed/deduped: %v", got.Worktree.Jira.Projects)
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "# keep") || !strings.Contains(string(data), "https_port: 9443") {
		t.Fatalf("file:\n%s", data)
	}
	bad := strings.Replace(body, "9443", "70000", 1)
	if rec := doReq(s, "PUT", "/api/settings/worktree", bad); rec.Code != http.StatusBadRequest {
		t.Fatalf("port 70000: status %d", rec.Code)
	}
}

func TestSettingsWorktreePutAppliesAliasHosts(t *testing.T) {
	t.Parallel()
	t.Cleanup(func() { jira.SetAliasHosts(nil) })
	s, _ := settingsServer(t, "ui:\n    password: pw\n")
	const u = "https://old.example.com/browse/ABC-1"
	if _, ok := jira.ParseJiraURL(u); ok {
		t.Fatal("precondition: alias should not be known yet")
	}
	body := `{"worktrees_base":"","editor":"","cmux_features_enabled":true,
	  "jira":{"projects":[],"alias_hosts":["old.example.com"]},
	  "ui":{"https_port":8476,"allowed_hosts":[],"tls":{"cert_file":"","key_file":""}}}`
	decodeSettings(t, doReq(s, "PUT", "/api/settings/worktree", body))
	if key, ok := jira.ParseJiraURL(u); !ok || key != "ABC-1" {
		t.Fatalf("alias host not applied live: %q %v", key, ok)
	}
}

func TestSettingsWorktreePutAllowedHostValidation(t *testing.T) {
	t.Parallel()
	s, _ := settingsServer(t, "ui:\n    password: pw\n")
	put := func(host string) int {
		body := `{"cmux_features_enabled":true,"jira":{"projects":[],"alias_hosts":[]},
		  "ui":{"https_port":8476,"allowed_hosts":["` + host + `"],"tls":{"cert_file":"","key_file":""}}}`
		return doReq(s, "PUT", "/api/settings/worktree", body).Code
	}
	if c := put("a b"); c != http.StatusBadRequest {
		t.Fatalf("bad host: status %d", c)
	}
	if c := put("::1"); c != http.StatusOK {
		t.Fatalf("ipv6 host: status %d", c)
	}
}

func TestSettingsWorktreePutCmuxGate(t *testing.T) {
	t.Parallel()
	s, path := settingsServer(t, "ui:\n    password: pw\n")
	s.DB = unreadTestDB(t)
	s.cmuxList = func() ([]cmux.Workspace, error) { return nil, nil }
	cur := decodeSettings(t, doReq(s, "GET", "/api/settings", ""))
	cur.Worktree.CmuxFeaturesEnabled = false
	b, _ := json.Marshal(cur.Worktree)
	got := decodeSettings(t, doReq(s, "PUT", "/api/settings/worktree", string(b)))
	if got.Worktree.CmuxFeaturesEnabled || s.cmuxEnabled() {
		t.Fatal("gate should be shut")
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "cmux_features_disabled: true") {
		t.Fatalf("file:\n%s", data)
	}
}

func TestSettingsWorktreePutRemoteAccessToggle(t *testing.T) {
	t.Parallel()
	s, path := settingsServer(t, "ui:\n    password: pw\n")
	cur := decodeSettings(t, doReq(s, "GET", "/api/settings", ""))
	if on := cur.Worktree.UI.RemoteAccessEnabled; on == nil || !*on {
		t.Fatalf("remote_access_enabled = %v, want true by default", on)
	}
	off := false
	cur.Worktree.UI.RemoteAccessEnabled = &off
	b, _ := json.Marshal(cur.Worktree)
	got := decodeSettings(t, doReq(s, "PUT", "/api/settings/worktree", string(b)))
	if on := got.Worktree.UI.RemoteAccessEnabled; on == nil || *on {
		t.Fatal("remote access should read back disabled")
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "remote_access_disabled: true") {
		t.Fatalf("file:\n%s", data)
	}

	// A PUT that leaves the field out keeps the file's value.
	body := `{"cmux_features_enabled":true,"jira":{"projects":[],"alias_hosts":[]},
	  "ui":{"https_port":8476,"allowed_hosts":[],"tls":{"cert_file":"","key_file":""}}}`
	doReq(s, "PUT", "/api/settings/worktree", body)
	data, _ = os.ReadFile(path)
	if !strings.Contains(string(data), "remote_access_disabled: true") {
		t.Fatalf("omitted field reset the toggle:\n%s", data)
	}
}

func TestSettingsWorktreePutCmuxRefusedOutsideCmux(t *testing.T) {
	t.Parallel()
	s, path := settingsServer(t, "ui:\n    password: pw\n")
	s.cmuxAvailable = func() bool { return false }
	cur := decodeSettings(t, doReq(s, "GET", "/api/settings", ""))
	cur.Worktree.CmuxFeaturesEnabled = false
	b, _ := json.Marshal(cur.Worktree)
	if rec := doReq(s, "PUT", "/api/settings/worktree", string(b)); rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "cmux") {
		t.Fatal("a refused save must write nothing")
	}
}

func TestDisablingCmuxStripsUnreadPrefixes(t *testing.T) {
	s, f, unreadWT, readWT := unreadSyncFixture(t)
	s.ConfigPath = filepath.Join(t.TempDir(), "config.yaml")
	s.WatcherAuthPath = filepath.Join(t.TempDir(), "auth.yaml")
	s.WatcherConfigPath = filepath.Join(t.TempDir(), "wconfig.yaml")
	f.workspaces = []cmux.Workspace{
		{ID: "W1", CustomTitle: "📬 Unread", CurrentDirectory: unreadWT},
		{ID: "W2", CustomTitle: "📬 Read", CurrentDirectory: readWT},
		{ID: "W3", CustomTitle: "Plain", CurrentDirectory: readWT},
		{ID: "W4", CustomTitle: "📬 Elsewhere", CurrentDirectory: t.TempDir()},
	}

	cur := decodeSettings(t, doReq(s, "GET", "/api/settings", ""))
	cur.Worktree.CmuxFeaturesEnabled = false
	b, _ := json.Marshal(cur.Worktree)
	decodeSettings(t, doReq(s, "PUT", "/api/settings/worktree", string(b)))

	got := append([]string(nil), f.calls...)
	sort.Strings(got)
	if strings.Join(got, "|") != "rename W1 Unread|rename W2 Read" {
		t.Fatalf("calls = %q", got)
	}

	// And with the gate shut, the periodic pass puts nothing back.
	f.calls = nil
	f.workspaces[0].CustomTitle = "Unread"
	s.cmuxUnreadPass()
	if len(f.calls) != 0 {
		t.Fatalf("pass ran while disabled: %q", f.calls)
	}
}

func TestCmuxFocusDroppedWhileDisabled(t *testing.T) {
	t.Parallel()
	s := &Server{cmuxAvailable: func() bool { return true }}
	s.SetCmuxFeaturesDisabled(true)
	ch, cancel := s.focusHub().subscribe()
	defer cancel()
	s.onCmuxFocus("WS")
	select {
	case m := <-ch:
		t.Fatalf("published %+v while disabled", m)
	default:
	}
}
