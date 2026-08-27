package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
