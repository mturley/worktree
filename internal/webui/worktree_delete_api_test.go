package webui

import (
	"net/http"
	"testing"
)

// A delete is a job now, so what this route still rejects by itself is the
// only thing left to check here: everything after the validation is covered
// by the delete kind (jobs_kinds_test.go) and the job routes
// (jobs_api_test.go).
func TestDeleteWorktreeRequiresPath(t *testing.T) {
	t.Parallel()
	srv, _ := jobDeleteFixture(t)
	ts := jobsServer(t, srv)

	if code, _ := postJob(t, ts, "/api/worktrees/delete", map[string]any{}); code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", code)
	}
}
