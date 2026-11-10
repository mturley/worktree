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
	t.Parallel()
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
	t.Parallel()
	s, wtPath, _ := notesServer(t, nil, nil)
	rec := httptest.NewRecorder()
	s.handleGetWorktreeNotes(rec, httptest.NewRequest(http.MethodGet, "/api/worktree-notes?path="+url.QueryEscape(wtPath), nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"notes":""`) {
		t.Fatalf("GET = %d %s", rec.Code, rec.Body)
	}
}

func TestWorktreeNotesRejectsBadRequests(t *testing.T) {
	t.Parallel()
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

func TestWorktreeNotesShowOnHome(t *testing.T) {
	t.Parallel()
	s, wtPath, _ := notesServer(t, nil, nil)
	homeNotes := func() string {
		t.Helper()
		rec := httptest.NewRecorder()
		s.handleWorktrees(rec, httptest.NewRequest(http.MethodGet, "/api/worktrees", nil))
		var list []worktreeSummary
		if err := json.NewDecoder(rec.Body).Decode(&list); err != nil || len(list) != 1 {
			t.Fatalf("GET /api/worktrees = %d %v %v", rec.Code, list, err)
		}
		return list[0].Notes
	}

	// Defaults on: saved notes show on the home page.
	if _, got := postNotes(t, s, map[string]any{"path": wtPath, "notes": "- [ ] ship it"}); !got.ShowOnHome {
		t.Fatalf("show_on_home should default on, got %+v", got)
	}
	if n := homeNotes(); n != "- [ ] ship it" {
		t.Fatalf("home notes = %q", n)
	}

	// Turned off: hidden, and a later save that omits the field keeps it off.
	postNotes(t, s, map[string]any{"path": wtPath, "notes": "- [ ] ship it", "show_on_home": false})
	if _, got := postNotes(t, s, map[string]any{"path": wtPath, "notes": "edited"}); got.ShowOnHome {
		t.Fatalf("omitted show_on_home must keep the stored setting, got %+v", got)
	}
	if n := homeNotes(); n != "" {
		t.Fatalf("hidden notes leaked to home: %q", n)
	}

	// Back on, but blank notes still show nothing.
	postNotes(t, s, map[string]any{"path": wtPath, "notes": "  ", "show_on_home": true})
	if n := homeNotes(); n != "" {
		t.Fatalf("blank notes shown on home: %q", n)
	}
}

func TestWorktreeNotesSaveMergesConcurrentEdit(t *testing.T) {
	t.Parallel()
	s, wtPath, _ := notesServer(t, nil, nil)
	// Another writer inserted b after this client loaded "a\n\nz" and
	// appended c elsewhere. (Two edits at the same spot would conflict.)
	if _, err := notes.Set(s.DB, wtPath, "a\nb\n\nz", false, true); err != nil {
		t.Fatal(err)
	}
	rec, got := postNotes(t, s, map[string]any{"path": wtPath, "notes": "a\n\nz\nc", "base_notes": "a\n\nz"})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST = %d", rec.Code)
	}
	stored, _ := notes.Get(s.DB, wtPath)
	if stored.Text != got.Notes || strings.Contains(stored.Text, "<<<<<<<") ||
		!strings.Contains(stored.Text, "b") || !strings.Contains(stored.Text, "c") {
		t.Fatalf("stored = %q, response = %q; want a clean merge of b and c", stored.Text, got.Notes)
	}
}

func TestWorktreeNotesSaveMergesSameSpotInsertions(t *testing.T) {
	t.Parallel()
	s, wtPath, _ := notesServer(t, nil, nil)
	if _, err := notes.Set(s.DB, wtPath, "a\nb", false, true); err != nil {
		t.Fatal(err)
	}
	postNotes(t, s, map[string]any{"path": wtPath, "notes": "a\nc", "base_notes": "a"})
	stored, _ := notes.Get(s.DB, wtPath)
	if strings.Contains(stored.Text, "<<<<<<<") || !strings.Contains(stored.Text, "b") || !strings.Contains(stored.Text, "c") {
		t.Fatalf("stored = %q, want b and c with no markers", stored.Text)
	}
}

func TestWorktreeNotesSaveWithoutBaseOverwrites(t *testing.T) {
	t.Parallel()
	s, wtPath, _ := notesServer(t, nil, nil)
	if _, err := notes.Set(s.DB, wtPath, "x", false, true); err != nil {
		t.Fatal(err)
	}
	postNotes(t, s, map[string]any{"path": wtPath, "notes": "y"})
	if stored, _ := notes.Get(s.DB, wtPath); stored.Text != "y" {
		t.Fatalf("stored = %q, want y", stored.Text)
	}
}

func TestWorktreeNotesSyncOffClearsBase(t *testing.T) {
	t.Parallel()
	s, wtPath, calls := notesServer(t, nil, nil)
	base := "old"
	if _, ok, err := notes.CompareAndSet(s.DB, wtPath, 0, "old", true, true, &base, "UUID-A"); err != nil || !ok {
		t.Fatalf("seed: %v %v", ok, err)
	}
	_, got := postNotes(t, s, map[string]any{"path": wtPath, "notes": "old", "sync_cmux": false})
	if got.CmuxSync != cmuxSyncOff {
		t.Fatalf("response = %+v", got)
	}
	if stored, _ := notes.Get(s.DB, wtPath); stored.CmuxBase != nil {
		t.Fatalf("CmuxBase = %q, want nil", *stored.CmuxBase)
	}
	if len(*calls) != 0 {
		t.Fatalf("calls = %v, want none", *calls)
	}
}

func TestWorktreeNotesResyncKeepsBoth(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "/stub")
	desc := "c"
	s, wtPath, calls := notesServer(t, []cmux.Workspace{{ID: "UUID-A", Description: &desc}}, nil)
	if _, err := notes.Set(s.DB, wtPath, "n", false, true); err != nil {
		t.Fatal(err)
	}
	_, got := postNotes(t, s, map[string]any{"path": wtPath, "notes": "n", "sync_cmux": true})
	if got.CmuxSync != cmuxSyncOK {
		t.Fatalf("response = %+v", got)
	}
	stored, _ := notes.Get(s.DB, wtPath)
	if !strings.Contains(stored.Text, "<<<<<<<") || !strings.Contains(stored.Text, "n") || !strings.Contains(stored.Text, "c") {
		t.Fatalf("stored = %q, want a conflict block holding both", stored.Text)
	}
	if len(*calls) != 1 || (*calls)[0][1] != stored.Text {
		t.Fatalf("calls = %v, want the merged text pushed", *calls)
	}
}

func TestWorktreeNotesSaveLargeNotesWithBase(t *testing.T) {
	t.Parallel()
	s, wtPath, _ := notesServer(t, nil, nil)
	// Just under the cap, and dense in characters JSON escapes.
	big := strings.Repeat("\"q\"\n", (maxNotesBytes-1)/5)
	if len(big) >= maxNotesBytes {
		t.Fatalf("fixture too large: %d", len(big))
	}
	if _, err := notes.Set(s.DB, wtPath, big, false, true); err != nil {
		t.Fatal(err)
	}
	rec, got := postNotes(t, s, map[string]any{"path": wtPath, "notes": big, "base_notes": big})
	if rec.Code != http.StatusOK || got.Notes != big {
		t.Fatalf("POST = %d, notes len %d", rec.Code, len(got.Notes))
	}
	if rec, _ := postNotes(t, s, map[string]any{"path": wtPath, "notes": "x", "base_notes": strings.Repeat("x", maxNotesBytes+1)}); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized base_notes = %d, want 413", rec.Code)
	}
}
