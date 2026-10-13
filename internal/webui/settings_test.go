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
)

func doSettings(s *Server, method, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/api/settings", strings.NewReader(body))
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

func TestSettingsGetReportsCmuxAndToggle(t *testing.T) {
	s := &Server{cmuxAvailable: func() bool { return true }}
	if got := decodeSettings(t, doSettings(s, "GET", "")); got != (settingsDTO{InCmux: true, CmuxFeaturesEnabled: true}) {
		t.Fatalf("got %+v", got)
	}
	s.SetCmuxFeaturesDisabled(true)
	if got := decodeSettings(t, doSettings(s, "GET", "")); got != (settingsDTO{InCmux: true, CmuxFeaturesEnabled: false}) {
		t.Fatalf("got %+v", got)
	}
}

func TestSettingsUpdateRefusedOutsideCmux(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	s := &Server{cmuxAvailable: func() bool { return false }, ConfigPath: path}
	if rec := doSettings(s, "PUT", `{"cmux_features_enabled":false}`); rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("a refused update must not write the config")
	}
}

func TestSettingsUpdateRejectsMissingField(t *testing.T) {
	s := &Server{cmuxAvailable: func() bool { return true }}
	if rec := doSettings(s, "PUT", `{}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestSettingsUpdatePersistsAndGatesCmux(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("ui:\n  password: pw\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := &Server{
		DB:            unreadTestDB(t),
		cmuxAvailable: func() bool { return true },
		cmuxList:      func() ([]cmux.Workspace, error) { return nil, nil },
		ConfigPath:    path,
	}
	if s.notifyMode() != notifyModeCmux {
		t.Fatal("expected cmux notifications before disabling")
	}

	got := decodeSettings(t, doSettings(s, "PUT", `{"cmux_features_enabled":false}`))
	if got.CmuxFeaturesEnabled || !got.InCmux {
		t.Fatalf("got %+v", got)
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "cmux_features_disabled: true") || !strings.Contains(string(data), "password: pw") {
		t.Fatalf("config = %s", data)
	}
	if s.cmuxEnabled() {
		t.Fatal("gate still open")
	}
	if s.notifyMode() != notifyModeBrowser {
		t.Fatal("notifications should fall back to the browser")
	}
	// /api/cmux is one of the endpoints the UI's checks read.
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/cmux", nil))
	if !strings.Contains(rec.Body.String(), `"available":false`) {
		t.Fatalf("/api/cmux = %s", rec.Body)
	}

	got = decodeSettings(t, doSettings(s, "PUT", `{"cmux_features_enabled":true}`))
	if !got.CmuxFeaturesEnabled || !s.cmuxEnabled() {
		t.Fatalf("re-enable: got %+v", got)
	}
	data, _ = os.ReadFile(path)
	if strings.Contains(string(data), "cmux_features_disabled") {
		t.Fatalf("config still disables cmux: %s", data)
	}
}

func TestDisablingCmuxStripsUnreadPrefixes(t *testing.T) {
	s, f, unreadWT, readWT := unreadSyncFixture(t)
	s.ConfigPath = filepath.Join(t.TempDir(), "config.yaml")
	f.workspaces = []cmux.Workspace{
		{ID: "W1", CustomTitle: "📬 Unread", CurrentDirectory: unreadWT},
		{ID: "W2", CustomTitle: "📬 Read", CurrentDirectory: readWT},
		{ID: "W3", CustomTitle: "Plain", CurrentDirectory: readWT},
		{ID: "W4", CustomTitle: "📬 Elsewhere", CurrentDirectory: t.TempDir()},
	}

	decodeSettings(t, doSettings(s, "PUT", `{"cmux_features_enabled":false}`))

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
