package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateWorktreeRequiresInputAndRepo(t *testing.T) {
	s := &Server{}
	for _, body := range []string{`{}`, `{"input":"x"}`, `{"repo_root":"/r"}`} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/worktrees/create", strings.NewReader(body))
		s.handleCreateWorktree(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400", body, rec.Code)
		}
	}
}

func TestCreateWorktreeRejectsSlackURL(t *testing.T) {
	// The same rejection the CLI makes: never create a branch named after a
	// URL that was only ever meant to be a resource.
	s := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/worktrees/create", strings.NewReader(
		`{"input":"https://x.slack.com/archives/C123/p1700000000000200","repo_root":"/r"}`))
	s.handleCreateWorktree(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a Slack URL", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "resource") {
		t.Fatalf("error should explain it is a resource, got %s", rec.Body.String())
	}
}

func TestCreateWorktreeRejectsExistingWorktreeDir(t *testing.T) {
	// Pairs with TestCreateWorktreeRejectsSlackURL: a pasted path to an
	// existing worktree must never fall through and get created as a branch
	// named after the path, mirroring cmd/add.go's isExistingWorktreeDir check.
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}

	s := &Server{}
	body, err := json.Marshal(map[string]string{"input": dir, "repo_root": "/r"})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/worktrees/create", strings.NewReader(string(body)))
	s.handleCreateWorktree(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for an existing worktree path", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "worktree list") {
		t.Fatalf("error should point at the worktree list, got %s", rec.Body.String())
	}
}

func TestCreateWorktreeFailureIs200WithOKFalse(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/worktrees/create", strings.NewReader(
		`{"input":"my-branch","repo_root":"/definitely/not/a/repo"}`))
	s.handleCreateWorktree(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 so the modal can show partial steps", rec.Code)
	}
	var got createWorktreeResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.OK {
		t.Fatal("ok = true for a nonexistent repo root")
	}
}

func TestCreateWorktreeRequestDecodesAllFields(t *testing.T) {
	var req createWorktreeRequest
	body := `{"input":"x","repo_root":"/r","decline_reset":true,"reuse_branch":true,"reset_to_pr":true,"pull":true,"copy_dotfiles":true}`
	if err := json.NewDecoder(strings.NewReader(body)).Decode(&req); err != nil {
		t.Fatal(err)
	}
	if req.Input != "x" {
		t.Errorf("Input = %q, want %q", req.Input, "x")
	}
	if req.RepoRoot != "/r" {
		t.Errorf("RepoRoot = %q, want %q", req.RepoRoot, "/r")
	}
	if !req.Pull {
		t.Error("Pull = false, want true")
	}
	if !req.CopyDotfiles {
		t.Error("CopyDotfiles = false, want true")
	}
	if !req.ReuseBranch {
		t.Error("ReuseBranch = false, want true")
	}
	if !req.ResetToPR {
		t.Error("ResetToPR = false, want true")
	}
	if !req.DeclineReset {
		t.Error("DeclineReset = false, want true")
	}
}

func TestCreateWorktreeRequestOptionsCarriesAllFields(t *testing.T) {
	req := createWorktreeRequest{
		Input:        "x",
		RepoRoot:     "/r",
		Pull:         true,
		CopyDotfiles: true,
		ReuseBranch:  true,
		ResetToPR:    true,
		DeclineReset: true,
	}
	opts := req.options()
	if opts.Input != "x" {
		t.Errorf("Input = %q, want %q", opts.Input, "x")
	}
	if opts.RepoRoot != "/r" {
		t.Errorf("RepoRoot = %q, want %q", opts.RepoRoot, "/r")
	}
	if !opts.Pull {
		t.Error("Pull = false, want true")
	}
	if !opts.CopyDotfiles {
		t.Error("CopyDotfiles = false, want true")
	}
	if !opts.ReuseBranch {
		t.Error("ReuseBranch = false, want true")
	}
	if !opts.ResetToPR {
		t.Error("ResetToPR = false, want true")
	}
	if !opts.DeclineReset {
		t.Error("DeclineReset = false, want true")
	}
}
