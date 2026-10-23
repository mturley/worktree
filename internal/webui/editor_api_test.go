package webui

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/registry"
)

type editorCall struct {
	name string
	args []string
}

func editorTestServer(t *testing.T, editor string) (*Server, *[]editorCall, string) {
	t.Helper()
	conn := unreadTestDB(t)
	wt := "/wt/one"
	if err := registry.Register(conn, registry.Entry{Path: wt, Repo: "r", RepoRoot: "/r", Branch: "b", CreatedAt: "now"}); err != nil {
		t.Fatal(err)
	}
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(cfgPath, []byte("editor: "+editor+"\nui:\n  password: pw\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var calls []editorCall
	s := &Server{DB: conn, ConfigPath: cfgPath, startEditor: func(name string, args ...string) error {
		calls = append(calls, editorCall{name, args})
		return nil
	}}
	return s, &calls, wt
}

func postOpenEditor(s *Server, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/api/worktrees/open-editor", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func TestOpenEditorRunsConfiguredEditorWithPath(t *testing.T) {
	s, calls, wt := editorTestServer(t, "code")
	rec := postOpenEditor(s, `{"path":"`+wt+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	if len(*calls) != 1 || (*calls)[0].name != "code" || strings.Join((*calls)[0].args, " ") != wt {
		t.Fatalf("calls = %+v", *calls)
	}
}

func TestOpenEditorRefusals(t *testing.T) {
	cases := []struct {
		name, editor, body string
		want               int
	}{
		{"no editor configured", "", `{"path":"/wt/one"}`, http.StatusConflict},
		{"unregistered path", "code", `{"path":"--evil"}`, http.StatusNotFound},
		{"missing path", "code", `{}`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, calls, _ := editorTestServer(t, tc.editor)
			if rec := postOpenEditor(s, tc.body); rec.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", rec.Code, tc.want, rec.Body)
			}
			if len(*calls) != 0 {
				t.Fatalf("editor ran: %+v", *calls)
			}
		})
	}
}

func TestOpenEditorReportsStartFailure(t *testing.T) {
	s, _, wt := editorTestServer(t, "nope")
	s.startEditor = func(string, ...string) error { return errors.New("executable file not found") }
	rec := postOpenEditor(s, `{"path":"`+wt+`"}`)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "not found") {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
}

// fileEditorServer is editorTestServer with a worktree that exists on disk,
// since opening a file checks it there.
func fileEditorServer(t *testing.T) (*Server, *[]editorCall, string) {
	t.Helper()
	s, calls, _ := editorTestServer(t, "code")
	wt, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.Register(s.DB, registry.Entry{Path: wt, Repo: "r", RepoRoot: "/r", Branch: "b2", CreatedAt: "now"}); err != nil {
		t.Fatal(err)
	}
	return s, calls, wt
}

func writeTestFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestOpenEditorWithFilePassesWorktreeAndFile(t *testing.T) {
	s, calls, wt := fileEditorServer(t)
	writeTestFile(t, filepath.Join(wt, "pkg", "a.go"))
	rec := postOpenEditor(s, `{"path":"`+wt+`","file":"pkg/a.go"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	want := []string{wt, filepath.Join(wt, "pkg", "a.go")}
	if len(*calls) != 1 || (*calls)[0].name != "code" || strings.Join((*calls)[0].args, "|") != strings.Join(want, "|") {
		t.Fatalf("calls = %+v, want args %v", *calls, want)
	}
}

func TestOpenEditorFileRejectsEscape(t *testing.T) {
	s, calls, wt := fileEditorServer(t)
	outside := t.TempDir()
	writeTestFile(t, filepath.Join(outside, "secret"))
	if err := os.Symlink(outside, filepath.Join(wt, "link")); err != nil {
		t.Fatal(err)
	}
	// A sibling whose name starts with the worktree's must not count as inside.
	sibling := wt + "2"
	writeTestFile(t, filepath.Join(sibling, "f"))
	t.Cleanup(func() { os.RemoveAll(sibling) })
	if err := os.Symlink(sibling, filepath.Join(wt, "sib")); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{"../x", "a/../../x", "/etc/passwd", "link/secret", "sib/f", "  "} {
		body, _ := json.Marshal(map[string]string{"path": wt, "file": file})
		if rec := postOpenEditor(s, string(body)); rec.Code != http.StatusBadRequest {
			t.Errorf("file %q: status = %d, want 400: %s", file, rec.Code, rec.Body)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("editor ran: %+v", *calls)
	}
}

func TestOpenEditorFileMissing404(t *testing.T) {
	s, calls, wt := fileEditorServer(t)
	rec := postOpenEditor(s, `{"path":"`+wt+`","file":"nope.go"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	if len(*calls) != 0 {
		t.Fatalf("editor ran: %+v", *calls)
	}
}

func TestOpenEditorFileOddName(t *testing.T) {
	s, calls, wt := fileEditorServer(t)
	writeTestFile(t, filepath.Join(wt, "a b", "naïve.go"))
	rec := postOpenEditor(s, `{"path":"`+wt+`","file":"a b/naïve.go"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	if got := (*calls)[0].args[1]; got != filepath.Join(wt, "a b", "naïve.go") {
		t.Fatalf("file arg = %q", got)
	}
}

func TestRunEditorWaitsForTheCommand(t *testing.T) {
	if err := runEditor("sh", "-c", "sleep 0.2"); err != nil {
		t.Fatalf("success: %v", err)
	}
	err := runEditor("sh", "-c", "echo 'no such window' >&2; exit 3")
	if err == nil || !strings.Contains(err.Error(), "exit status 3") || !strings.Contains(err.Error(), "no such window") {
		t.Fatalf("failure: %v", err)
	}
	if err := runEditor("/nonexistent/editor"); err == nil {
		t.Fatal("missing binary: want an error")
	}
}

func TestRunEditorStopsWaitingForAForegroundEditor(t *testing.T) {
	old := editorWaitLimit
	editorWaitLimit = 100 * time.Millisecond
	t.Cleanup(func() { editorWaitLimit = old })

	start := time.Now()
	if err := runEditor("sleep", "5"); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("waited %v for a command that outlives the limit", d)
	}
}
