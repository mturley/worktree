package webui

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
)

func TestAddResource_Jira(t *testing.T) {
	// Isolate watcher config so the add endpoint's inline pollOne finds no
	// creds (fails closed to a no-op) instead of hitting the live network on
	// machines that happen to have real creds configured.
	t.Setenv("WATCHER_HOME", t.TempDir())
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wtPath := t.TempDir()

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := `{"path":"` + wtPath + `","url":"https://redhat.atlassian.net/browse/RHOAIENG-123"}`
	resp, err := http.Post(ts.URL+"/api/worktree-resources/add", "application/json", bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("add: got %d, want 200", resp.StatusCode)
	}
	// It should now appear in the resources list as a jira resource.
	r2, err := http.Get(ts.URL + "/api/worktree-resources?path=" + url.QueryEscape(wtPath))
	if err != nil {
		t.Fatal(err)
	}
	buf := new(bytes.Buffer)
	buf.ReadFrom(r2.Body)
	if !strings.Contains(buf.String(), `"id":"RHOAIENG-123"`) || !strings.Contains(buf.String(), `"type":"jira"`) {
		t.Fatalf("resource not added: %s", buf.String())
	}
}

func TestAddResource_UnrecognizedURL(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wtPath := t.TempDir()

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := `{"path":"` + wtPath + `","url":"https://example.com/nope"}`
	resp, err := http.Post(ts.URL+"/api/worktree-resources/add", "application/json", bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", resp.StatusCode)
	}
}

func TestAddResource_MissingFields(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/worktree-resources/add", "application/json", bytes.NewReader([]byte(`{"url":"x"}`)))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing path: got %d, want 400", resp.StatusCode)
	}
}

func TestRemoveResource(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wtPath := t.TempDir()
	if err := resources.Add(conn, wtPath, resources.Resource{Type: "slack", ID: "C1:1700000000.000100", URL: "https://x"}); err != nil {
		t.Fatal(err)
	}

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := `{"path":"` + wtPath + `","type":"slack","id":"C1:1700000000.000100"}`
	resp, err := http.Post(ts.URL+"/api/worktree-resources/remove", "application/json", bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("remove: got %d, want 204", resp.StatusCode)
	}

	r2, err := http.Get(ts.URL + "/api/worktree-resources?path=" + url.QueryEscape(wtPath))
	if err != nil {
		t.Fatal(err)
	}
	buf := new(bytes.Buffer)
	buf.ReadFrom(r2.Body)
	if strings.Contains(buf.String(), "C1:1700000000.000100") {
		t.Fatalf("resource still present after remove: %s", buf.String())
	}
}

func TestRemoveResource_MissingFields(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/worktree-resources/remove", "application/json", bytes.NewReader([]byte(`{"path":"/x"}`)))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", resp.StatusCode)
	}
}
