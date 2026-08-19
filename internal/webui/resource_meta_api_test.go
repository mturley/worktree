package webui

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
)

func TestSetResourceMetaThenLoad(t *testing.T) {
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

	body := `{"type":"slack","id":"C1:1700000000.000100","name":"Release blocker","description":"e2e"}`
	resp, err := http.Post(ts.URL+"/api/resource-meta", "application/json", bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatalf("POST resource-meta: %v", err)
	}
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", resp.StatusCode)
	}

	// The GET resources endpoint should now include custom_name.
	resp2, err := http.Get(ts.URL + "/api/worktree-resources?path=" + url.QueryEscape(wtPath))
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	buf := new(bytes.Buffer)
	buf.ReadFrom(resp2.Body)
	got := buf.String()
	if !strings.Contains(got, `"custom_name":"Release blocker"`) {
		t.Fatalf("resources JSON missing custom_name: %s", got)
	}

	var dtos []resourceDTO
	if err := json.Unmarshal([]byte(got), &dtos); err != nil {
		t.Fatal(err)
	}
	if len(dtos) != 1 || dtos[0].CustomDescription != "e2e" {
		t.Fatalf("unexpected dtos: %+v", dtos)
	}
}

func TestSetResourceMetaMissingFields(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/resource-meta", "application/json",
		bytes.NewReader([]byte(`{"name":"x"}`)))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing type/id, got %d", resp.StatusCode)
	}
}
