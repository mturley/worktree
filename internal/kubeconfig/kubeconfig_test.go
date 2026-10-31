package kubeconfig

import (
	"os"
	"path/filepath"
	"testing"
)

const ocLogin = `apiVersion: v1
kind: Config
current-context: default/api-onyx-example-com:6443/admin-user
clusters:
- name: api-onyx-example-com:6443
  cluster:
    server: https://api.onyx.example.com:6443
- name: api-other-example-com:6443
  cluster:
    server: https://api.other.example.com:6443
contexts:
- name: default/api-onyx-example-com:6443/admin-user
  context:
    cluster: api-onyx-example-com:6443
    namespace: default
    user: admin-user/api-onyx-example-com:6443
- name: /api-other-example-com:6443/someone
  context:
    cluster: api-other-example-com:6443
    user: someone/api-other-example-com:6443
users:
- name: admin-user/api-onyx-example-com:6443
  user:
    token: sha256~secret
`

func write(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func ptr(s string) *string { return &s }

func TestReadCurrentContext(t *testing.T) {
	t.Parallel()
	got := Read(write(t, ocLogin))
	want := Info{State: StateOK, Cluster: ptr("https://api.onyx.example.com:6443"), User: ptr("admin-user"), Namespace: "default"}
	if got.State != want.State || *got.Cluster != *want.Cluster || *got.User != *want.User || got.Namespace != want.Namespace {
		t.Fatalf("Read = %+v, want %+v", got, want)
	}
}

func TestReadMissingFile(t *testing.T) {
	t.Parallel()
	if got := Read(filepath.Join(t.TempDir(), "nope")); got.State != StateMissing {
		t.Fatalf("State = %q, want missing", got.State)
	}
	if got := Read(""); got.State != StateMissing {
		t.Fatalf("empty path: State = %q, want missing", got.State)
	}
}

func TestReadNoUsableContext(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"empty current-context": "current-context: \"\"\ncontexts: []\n",
		"unknown context":       "current-context: gone\ncontexts:\n- name: other\n  context: {cluster: c}\n",
		"malformed yaml":        "current-context: [unclosed\n",
		"wrong field types":     "current-context: x\ncontexts: 5\n",
	}
	for name, body := range cases {
		if got := Read(write(t, body)); got.State != StateNoContext {
			t.Errorf("%s: State = %q, want no_context", name, got.State)
		}
	}
}

func TestReadMissingClusterOrUser(t *testing.T) {
	t.Parallel()
	got := Read(write(t, "current-context: c\ncontexts:\n- name: c\n  context: {cluster: nowhere, user: nobody}\n"))
	if got.State != StateOK || got.Cluster != nil || got.User != nil || got.Namespace != "" {
		t.Fatalf("Read = %+v, want ok with nil cluster and user", got)
	}
}

func TestUserNameKeepsNamesWithoutTheClusterSuffix(t *testing.T) {
	t.Parallel()
	got := Read(write(t, "current-context: c\ncontexts:\n- name: c\n  context: {cluster: k, user: plain-user}\nusers:\n- name: plain-user\n  user: {}\n"))
	if got.User == nil || *got.User != "plain-user" {
		t.Fatalf("User = %v, want plain-user", got.User)
	}
}
