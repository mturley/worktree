package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
)

func textChangeServer(t *testing.T) *Server {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return &Server{DB: conn}
}

func TestEventTextChange_OK(t *testing.T) {
	t.Parallel()
	srv := textChangeServer(t)
	insertEvent(t, srv.DB, "e1", time.Now().UTC().Format(time.RFC3339), "github", "pr_description_changed", "x", "pr", "o/r#1", "u1")
	if _, err := srv.DB.Exec(`INSERT INTO watcher_event_text_change (event_id, old_text, new_text) VALUES ('e1', 'old body', 'new body')`); err != nil {
		t.Fatal(err)
	}
	// Sanity: the library reads what the endpoint will serve.
	if tc, err := watcherdb.EventTextChange(srv.DB, "e1"); err != nil || tc == nil || (*tc != watcher.TextChange{Old: "old body", New: "new body"}) {
		t.Fatalf("library read = %+v, %v", tc, err)
	}

	rec := serve(srv.Handler(), httptest.NewRequest("GET", "/api/event-text-change?id=e1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var got map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got["old_text"] != "old body" || got["new_text"] != "new body" {
		t.Fatalf("body = %v", got)
	}
}

func TestEventTextChange_NotFound(t *testing.T) {
	t.Parallel()
	srv := textChangeServer(t)
	rec := serve(srv.Handler(), httptest.NewRequest("GET", "/api/event-text-change?id=nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d, want 404", rec.Code)
	}
}

func TestEventTextChange_MissingID(t *testing.T) {
	t.Parallel()
	srv := textChangeServer(t)
	rec := serve(srv.Handler(), httptest.NewRequest("GET", "/api/event-text-change", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rec.Code)
	}
}

func TestEventTextChange_RequiresSession(t *testing.T) {
	t.Parallel()
	srv, _, _ := securedServer(t)
	h := srv.Handler()
	rec := serve(h, apiRequest("GET", "/api/event-text-change?id=e1", ""))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("without a session: status %d, want 401", rec.Code)
	}
}
