package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCmuxUnavailableReturnsAvailableFalse(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "")
	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleCmux(rec, httptest.NewRequest(http.MethodGet, "/api/cmux", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (a cmux failure must never 5xx)", rec.Code)
	}
	var got struct {
		Available bool `json:"available"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Available {
		t.Fatal("available = true with no cmux socket")
	}
}

func TestCmuxSelectRequiresRef(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/cmux/select", strings.NewReader(`{}`))
	s.handleCmuxSelect(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a missing ref", rec.Code)
	}
}
