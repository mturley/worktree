package webui

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func fakeCompare(t *testing.T, status int, aheadBy int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/mturley/worktree/compare/abc123...main" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"ahead_by": aheadBy})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func getUpdateStatus(t *testing.T, s *Server) updateStatus {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/update-status", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	var st updateStatus
	if err := json.NewDecoder(rec.Body).Decode(&st); err != nil {
		t.Fatal(err)
	}
	return st
}

func TestUpdateCheck_BehindMain(t *testing.T) {
	gh := fakeCompare(t, http.StatusOK, 3)
	s := &Server{BuildCommit: "abc123", updateAPIBase: gh.URL}
	s.checkForUpdate(context.Background())
	st := getUpdateStatus(t, s)
	if !st.Available || st.BehindBy != 3 {
		t.Fatalf("got %+v, want available behind 3", st)
	}
	if st.DetailsURL != "https://github.com/mturley/worktree/commits/main" {
		t.Fatalf("details url %q", st.DetailsURL)
	}
}

func TestUpdateCheck_UpToDate(t *testing.T) {
	gh := fakeCompare(t, http.StatusOK, 0)
	s := &Server{BuildCommit: "abc123", updateAPIBase: gh.URL}
	s.checkForUpdate(context.Background())
	if st := getUpdateStatus(t, s); st.Available {
		t.Fatalf("got %+v, want not available", st)
	}
}

func TestUpdateCheck_UnknownCommitShowsNothing(t *testing.T) {
	gh := fakeCompare(t, http.StatusNotFound, 0)
	s := &Server{BuildCommit: "abc123", updateAPIBase: gh.URL}
	s.checkForUpdate(context.Background())
	if st := getUpdateStatus(t, s); st.Available {
		t.Fatalf("got %+v, want not available", st)
	}
}

func TestUpdateCheck_FailureKeepsLastAnswer(t *testing.T) {
	ok := fakeCompare(t, http.StatusOK, 2)
	s := &Server{BuildCommit: "abc123", updateAPIBase: ok.URL}
	s.checkForUpdate(context.Background())
	s.updateAPIBase = fakeCompare(t, http.StatusInternalServerError, 0).URL
	s.checkForUpdate(context.Background())
	if st := getUpdateStatus(t, s); !st.Available || st.BehindBy != 2 {
		t.Fatalf("got %+v, want the earlier answer kept", st)
	}
}
