package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/kubeconfig"
	"github.com/mturley/worktree/internal/registry"
)

const testKubeconfig = `current-context: ns/api-c:6443/me
clusters:
- name: api-c:6443
  cluster: {server: "https://api.c:6443"}
contexts:
- name: ns/api-c:6443/me
  context: {cluster: "api-c:6443", user: "me/api-c:6443", namespace: ns}
users:
- name: me/api-c:6443
  user: {token: secret-token}
`

// kubeTestServer registers one worktree under a repo name unique to the
// test (the kubeconfig path is derived from it under the isolated HOME)
// and returns the server and that worktree's kubeconfig path.
func kubeTestServer(t *testing.T) (*Server, string, string) {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	wtPath := t.TempDir()
	repo := strings.NewReplacer("/", "-").Replace(t.Name())
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: repo, RepoRoot: "/r", Branch: "b", CreatedAt: "2026-10-30T00:00:00Z"})
	kube := env.KubeconfigPath(repo, filepath.Base(wtPath))
	if err := os.MkdirAll(filepath.Dir(kube), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(kube) })
	return &Server{DB: conn}, wtPath, kube
}

func TestWorktreeInfoReportsCurrentKubeContext(t *testing.T) {
	t.Parallel()
	s, wtPath, kube := kubeTestServer(t)
	if err := os.WriteFile(kube, []byte(testKubeconfig), 0o600); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktree-info?path=" + url.QueryEscape(wtPath))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var raw map[string]json.RawMessage
	json.NewDecoder(resp.Body).Decode(&raw)
	if strings.Contains(string(raw["kubeconfig"]), "secret-token") {
		t.Fatalf("kubeconfig leaked a credential: %s", raw["kubeconfig"])
	}
	var got kubeconfig.Info
	json.Unmarshal(raw["kubeconfig"], &got)
	if got.State != kubeconfig.StateOK || got.Cluster == nil || *got.Cluster != "https://api.c:6443" ||
		got.User == nil || *got.User != "me" || got.Namespace != "ns" {
		t.Fatalf("kubeconfig = %s", raw["kubeconfig"])
	}
}

func TestWorktreeInfoKubeconfigMissing(t *testing.T) {
	t.Parallel()
	s, wtPath, _ := kubeTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktree-info?path=" + url.QueryEscape(wtPath))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got worktreeInfoDTO
	json.NewDecoder(resp.Body).Decode(&got)
	if got.Kubeconfig.State != kubeconfig.StateMissing {
		t.Fatalf("state = %q, want missing", got.Kubeconfig.State)
	}
}

func TestKubeconfigFingerprintChangesWithTheFile(t *testing.T) {
	t.Parallel()
	s, _, kube := kubeTestServer(t)
	missing := s.kubeconfigFingerprint()
	os.WriteFile(kube, []byte(testKubeconfig), 0o600)
	written := s.kubeconfigFingerprint()
	if written == missing {
		t.Fatal("creating the kubeconfig didn't change the fingerprint")
	}
	if again := s.kubeconfigFingerprint(); again != written {
		t.Fatal("fingerprint changed with nothing touched")
	}
	later := time.Now().Add(time.Minute)
	os.Chtimes(kube, later, later)
	if s.kubeconfigFingerprint() == written {
		t.Fatal("rewriting the kubeconfig didn't change the fingerprint")
	}
}

// Port scanning has its own Settings switch; turning it off must not stop
// the Kubeconfig section's live updates, which ride the stream's own tick.
func TestStreamSendsKubeconfigChangedWithPortScanningOff(t *testing.T) {
	t.Parallel()
	s, _, kube := kubeTestServer(t)
	s.listenersScan = (&fakeScan{}).scan
	s.SetPortScanDisabled(true)
	ts := httptest.NewServer(http.HandlerFunc(s.handleStream))
	t.Cleanup(ts.Close)
	lines := streamLines(t, ts, "")
	os.WriteFile(kube, []byte(testKubeconfig), 0o600)
	timeout := time.After(8 * time.Second) // the stream ticks every 5s
	for {
		select {
		case l, ok := <-lines:
			if !ok {
				t.Fatal("stream ended")
			}
			if l == "event: kubeconfig_changed" {
				return
			}
		case <-timeout:
			t.Fatal("no kubeconfig_changed event")
		}
	}
}
