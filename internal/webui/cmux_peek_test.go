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

	"github.com/mturley/worktree/internal/cmux"
)

func getPeek(t *testing.T, s *Server, id, surface string) (int, cmuxPeekResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handleCmuxPeek(rec, httptest.NewRequest(http.MethodGet, "/api/cmux/peek?id="+id+"&surface="+surface, nil))
	var got cmuxPeekResponse
	if rec.Code == http.StatusOK {
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
	}
	return rec.Code, got
}

func TestCmuxPeekTerminal(t *testing.T) {
	s, f := newTabServer(t)
	f.screen = "$ make test\nok"
	code, got := getPeek(t, s, wsID, "surface:1")
	if code != http.StatusOK || got.Type != "terminal" || got.Text != "$ make test\nok" {
		t.Fatalf("code=%d got=%+v", code, got)
	}
	if !f.called("read-screen " + wsID + " surface:1 200") {
		t.Fatalf("calls = %q, want read-screen with 200 lines", f.calls)
	}
}

func TestCmuxPeekBrowser(t *testing.T) {
	s, f := newTabServer(t)
	f.png = []byte("PNG")
	code, got := getPeek(t, s, wsID, "surface:2")
	if code != http.StatusOK || got.Type != "browser" || got.Image != "data:image/png;base64,UE5H" {
		t.Fatalf("code=%d got=%+v", code, got)
	}
}

func TestCmuxPeekMarkdown(t *testing.T) {
	s, f := newTabServer(t)
	f.mdPath = filepath.Join(t.TempDir(), "notes.md")
	if err := os.WriteFile(f.mdPath, []byte("# Hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	code, got := getPeek(t, s, wsID, "surface:3")
	if code != http.StatusOK || got.Type != "markdown" || got.Markdown != "# Hello" || got.Path != f.mdPath || got.Unsupported {
		t.Fatalf("code=%d got=%+v", code, got)
	}
}

func TestCmuxPeekMarkdownWithoutPathIsUnsupported(t *testing.T) {
	s, _ := newTabServer(t)
	code, got := getPeek(t, s, wsID, "surface:3")
	if code != http.StatusOK || !got.Unsupported || got.Markdown != "" {
		t.Fatalf("code=%d got=%+v", code, got)
	}
}

func TestCmuxPeekOtherTypeIsUnsupportedWithoutPeeking(t *testing.T) {
	s, f := newTabServer(t)
	tree := sampleTree()
	tree.Panes[2].Tabs = []cmux.TreeTab{{Ref: "surface:5", Type: "simulator", Title: "sim"}}
	f.trees[wsID] = tree
	code, got := getPeek(t, s, wsID, "surface:5")
	if code != http.StatusOK || got.Type != "simulator" || !got.Unsupported {
		t.Fatalf("code=%d got=%+v", code, got)
	}
	if len(f.calls) != 1 || !strings.HasPrefix(f.calls[0], "tree ") {
		t.Fatalf("calls = %q, want only the tree read", f.calls)
	}
}

func TestCmuxPeekUnknownSurface(t *testing.T) {
	s, f := newTabServer(t)
	if code, _ := getPeek(t, s, wsID, "surface:42"); code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", code)
	}
	if f.called("read-screen") || f.called("screenshot") || f.called("markdown-path") {
		t.Fatalf("peeked a surface not in the workspace: %q", f.calls)
	}
}

func TestCmuxPeekValidation(t *testing.T) {
	s, f := newTabServer(t)
	for _, c := range []struct{ id, surface string }{
		{"", "surface:1"},
		{"--action", "surface:1"},
		{wsID, ""},
		{wsID, "pane:1"},
		{wsID, "surface:1%20--workspace%20X"},
	} {
		if code, _ := getPeek(t, s, c.id, c.surface); code != http.StatusBadRequest {
			t.Errorf("id=%q surface=%q: status = %d, want 400", c.id, c.surface, code)
		}
	}
	if len(f.calls) != 0 {
		t.Fatalf("called cmux on invalid input: %q", f.calls)
	}
}

func TestCmuxPeekUnavailable(t *testing.T) {
	s, f := newTabServer(t)
	t.Setenv("CMUX_SOCKET_PATH", "")
	if code, _ := getPeek(t, s, wsID, "surface:1"); code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", code)
	}
	if len(f.calls) != 0 {
		t.Fatalf("calls = %q, want none", f.calls)
	}
}

func TestCmuxPeekCmuxFailureIs502(t *testing.T) {
	s, f := newTabServer(t)
	f.peekErr = errors.New("taking screenshot: boom")
	if code, _ := getPeek(t, s, wsID, "surface:2"); code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", code)
	}
	if code, _ := getPeek(t, s, goneID, "surface:2"); code != http.StatusBadGateway {
		t.Fatalf("tree failure: status = %d, want 502", code)
	}
}

func TestReadPeekMarkdownGuards(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, size int) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(strings.Repeat("a", size)), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	ok := write("ok.md", 10)
	upper := write("UPPER.MARKDOWN", 10)
	atLimit := write("limit.md", peekMarkdownMaxBytes)
	tooBig := write("big.md", peekMarkdownMaxBytes+1)
	txt := write("notes.txt", 10)
	subdir := filepath.Join(dir, "folder.md")
	if err := os.Mkdir(subdir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		path string
		want bool
	}{
		{ok, true},
		{upper, true},
		{atLimit, true},
		{tooBig, false},
		{txt, false},
		{subdir, false},
		{"relative/notes.md", false},
		{filepath.Join(dir, "missing.md"), false},
		{"", false},
	} {
		if _, got := readPeekMarkdown(c.path); got != c.want {
			t.Errorf("readPeekMarkdown(%q) ok = %v, want %v", c.path, got, c.want)
		}
	}
}
