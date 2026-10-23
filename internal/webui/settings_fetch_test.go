package webui

import (
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestSettingsPutRejectsShortInterval(t *testing.T) {
	s, path := settingsServer(t, "ui:\n    password: pw\n")
	put := func(interval string) int {
		body := `{"cmux_features_enabled":true,"jira":{"projects":[],"alias_hosts":[]},
		  "ui":{"https_port":8476,"allowed_hosts":[],"tls":{"cert_file":"","key_file":""}},
		  "git":{"background_fetch":true,"fetch_interval":"` + interval + `"}}`
		return doReq(s, "PUT", "/api/settings/worktree", body).Code
	}
	for _, bad := range []string{"30s", "soon", "0s", ""} {
		if c := put(bad); c != http.StatusBadRequest {
			t.Errorf("interval %q: status %d, want 400", bad, c)
		}
	}
	if c := put("5m"); c != http.StatusOK {
		t.Fatalf("5m: status %d", c)
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "fetch_interval: 5m") {
		t.Fatalf("file:\n%s", data)
	}
	// A PUT that omits the git section keeps the current values.
	body := `{"cmux_features_enabled":true,"jira":{"projects":[],"alias_hosts":[]},
	  "ui":{"https_port":8476,"allowed_hosts":[],"tls":{"cert_file":"","key_file":""}}}`
	got := decodeSettings(t, doReq(s, "PUT", "/api/settings/worktree", body))
	if got.Worktree.Git == nil || got.Worktree.Git.FetchInterval != "5m" || !got.Worktree.Git.BackgroundFetch {
		t.Fatalf("omitted git section not preserved: %+v", got.Worktree.Git)
	}
}
