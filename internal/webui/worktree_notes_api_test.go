package webui

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/cmux"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/notes"
	"github.com/mturley/worktree/internal/registry"
)

// notesServer returns a server with one registered worktree, and records the
// cmux description calls it makes.
func notesServer(t *testing.T, workspaces []cmux.Workspace, setErr error) (*Server, string, *[][2]string) {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	wtPath := t.TempDir()
	if err := registry.Register(conn, registry.Entry{Path: wtPath, Repo: "r", RepoRoot: "/r", Branch: "b", CreatedAt: "now"}); err != nil {
		t.Fatal(err)
	}
	for i := range workspaces {
		workspaces[i].CurrentDirectory = wtPath
	}
	var calls [][2]string
	s := &Server{
		DB:       conn,
		cmuxList: func() ([]cmux.Workspace, error) { return workspaces, nil },
		cmuxSetDescription: func(ref, desc string) error {
			calls = append(calls, [2]string{ref, desc})
			return setErr
		},
	}
	return s, wtPath, &calls
}

func postNotes(t *testing.T, s *Server, body any) (*httptest.ResponseRecorder, setWorktreeNotesResponse) {
	t.Helper()
	b, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	s.handleSetWorktreeNotes(rec, httptest.NewRequest(http.MethodPost, "/api/worktree-notes", bytes.NewReader(b)))
	var got setWorktreeNotesResponse
	_ = json.NewDecoder(rec.Body).Decode(&got)
	return rec, got
}

func TestWorktreeNotesRoundTrip(t *testing.T) {
	s, wtPath, calls := notesServer(t, nil, nil)
	rec, got := postNotes(t, s, map[string]any{"path": wtPath, "notes": "waiting on review"})
	if rec.Code != http.StatusOK || got.Notes != "waiting on review" || got.CmuxSync != cmuxSyncOff || got.UpdatedAt == "" {
		t.Fatalf("POST = %d %+v", rec.Code, got)
	}
	if len(*calls) != 0 {
		t.Fatalf("sync off must not touch cmux, got %v", *calls)
	}

	rec = httptest.NewRecorder()
	s.handleGetWorktreeNotes(rec, httptest.NewRequest(http.MethodGet, "/api/worktree-notes?path="+url.QueryEscape(wtPath), nil))
	var dto worktreeNotesDTO
	json.NewDecoder(rec.Body).Decode(&dto)
	if dto.Notes != "waiting on review" || dto.SyncCmux {
		t.Fatalf("GET = %+v", dto)
	}
}

func TestWorktreeNotesGetUnsavedIsEmpty(t *testing.T) {
	s, wtPath, _ := notesServer(t, nil, nil)
	rec := httptest.NewRecorder()
	s.handleGetWorktreeNotes(rec, httptest.NewRequest(http.MethodGet, "/api/worktree-notes?path="+url.QueryEscape(wtPath), nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"notes":""`) {
		t.Fatalf("GET = %d %s", rec.Code, rec.Body)
	}
}

func TestWorktreeNotesRejectsBadRequests(t *testing.T) {
	s, wtPath, _ := notesServer(t, nil, nil)
	for name, tc := range map[string]struct {
		body any
		want int
	}{
		"missing path": {map[string]any{"notes": "x"}, http.StatusBadRequest},
		"unregistered": {map[string]any{"path": "/not/registered", "notes": "x"}, http.StatusNotFound},
		"too large":    {map[string]any{"path": wtPath, "notes": strings.Repeat("x", maxNotesBytes+1)}, http.StatusRequestEntityTooLarge},
	} {
		t.Run(name, func(t *testing.T) {
			if rec, _ := postNotes(t, s, tc.body); rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
		})
	}
	rec := httptest.NewRecorder()
	s.handleGetWorktreeNotes(rec, httptest.NewRequest(http.MethodGet, "/api/worktree-notes", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("GET without path = %d", rec.Code)
	}
}

func TestWorktreeNotesSyncsToTheOneWorkspaceByID(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "/stub")
	s, wtPath, calls := notesServer(t, []cmux.Workspace{{ID: "UUID-A", Ref: "workspace:3"}}, nil)
	_, got := postNotes(t, s, map[string]any{"path": wtPath, "notes": "hello", "sync_cmux": true})
	if got.CmuxSync != cmuxSyncOK || !got.SyncCmux {
		t.Fatalf("response = %+v", got)
	}
	if len(*calls) != 1 || (*calls)[0] != [2]string{"UUID-A", "hello"} {
		t.Fatalf("calls = %v, want one call targeting the UUID", *calls)
	}
}

func TestWorktreeNotesSkipsSyncWithoutExactlyOneWorkspace(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "/stub")
	for name, ws := range map[string][]cmux.Workspace{
		"none": nil,
		"two":  {{ID: "A"}, {ID: "B"}},
	} {
		t.Run(name, func(t *testing.T) {
			s, wtPath, calls := notesServer(t, ws, nil)
			rec, got := postNotes(t, s, map[string]any{"path": wtPath, "notes": "hello", "sync_cmux": true})
			if rec.Code != http.StatusOK || got.CmuxSync != cmuxSyncSkipped || got.CmuxError == "" {
				t.Fatalf("POST = %d %+v", rec.Code, got)
			}
			if len(*calls) != 0 {
				t.Fatalf("calls = %v, want none", *calls)
			}
		})
	}
}

func TestWorktreeNotesSkipsSyncWhenCmuxUnavailable(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "")
	s, wtPath, calls := notesServer(t, []cmux.Workspace{{ID: "A"}}, nil)
	_, got := postNotes(t, s, map[string]any{"path": wtPath, "notes": "hello", "sync_cmux": true})
	if got.CmuxSync != cmuxSyncSkipped || len(*calls) != 0 {
		t.Fatalf("response = %+v, calls %v", got, *calls)
	}
}

func TestWorktreeNotesSavedEvenWhenCmuxFails(t *testing.T) {
	// The notes are committed before cmux is touched: a cmux failure is a
	// sync problem, not a lost save.
	t.Setenv("CMUX_SOCKET_PATH", "/stub")
	s, wtPath, _ := notesServer(t, []cmux.Workspace{{ID: "A"}}, errors.New("cmux said no"))
	rec, got := postNotes(t, s, map[string]any{"path": wtPath, "notes": "precious", "sync_cmux": true})
	if rec.Code != http.StatusOK || got.CmuxSync != cmuxSyncFailed || !strings.Contains(got.CmuxError, "cmux said no") {
		t.Fatalf("POST = %d %+v", rec.Code, got)
	}
	if n, _ := notes.Get(s.DB, wtPath); n.Text != "precious" {
		t.Fatalf("stored notes = %q", n.Text)
	}
}
