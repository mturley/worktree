package webui

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func rcPost(t *testing.T, ts *httptest.Server, route string, body any) (int, []byte) {
	t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(ts.URL+"/api/review-comments"+route, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	buf.ReadFrom(resp.Body)
	return resp.StatusCode, buf.Bytes()
}

func rcList(t *testing.T, ts *httptest.Server, path string) []reviewCommentItem {
	t.Helper()
	resp, err := http.Get(ts.URL + "/api/review-comments?path=" + url.QueryEscape(path))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Comments []reviewCommentItem `json:"comments"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out.Comments
}

func rcCreateReq(path, file, side string, line int, body string, p patchResp) map[string]any {
	return map[string]any{
		"path": path, "file": file, "side": side, "start_line": line, "end_line": line,
		"body": body, "base": "merge-base", "old_rev": p.OldRev, "new_rev": p.NewRev,
	}
}

func rcCreate(t *testing.T, ts *httptest.Server, req map[string]any) reviewCommentDTO {
	t.Helper()
	code, body := rcPost(t, ts, "", req)
	if code != 201 {
		t.Fatalf("create status %d: %s", code, body)
	}
	var c reviewCommentDTO
	if err := json.Unmarshal(body, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestReviewCommentsCreateCapturesSnippet(t *testing.T) {
	t.Parallel()
	wt := forkRepo(t)
	commitFile(t, wt, "multi", "one\ntwo\nthree\n")
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	c := rcCreate(t, ts, rcCreateReq(wt, "multi", "new", 2, "why two?", p))
	if len(c.Snippet) != 1 || c.Snippet[0] != "two" {
		t.Fatalf("snippet = %q", c.Snippet)
	}
	if c.StartLine != 2 || c.EndLine != 2 || c.Source != "draft" || !c.Editable || c.Version != 1 || c.Rev != strings.TrimSpace(gitIn(t, wt, "rev-parse", "HEAD")) {
		t.Fatalf("unexpected comment %+v", c)
	}
	if c.BaseRef != "origin/main" {
		t.Fatalf("base_ref = %q", c.BaseRef)
	}
	got := rcList(t, ts, wt)
	if len(got) != 1 || got[0].ID != c.ID {
		t.Fatalf("list = %+v", got)
	}
}

func TestReviewCommentsCreateUncommitted(t *testing.T) {
	t.Parallel()
	wt := forkRepo(t)
	if err := os.WriteFile(filepath.Join(wt, "f1"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	n := rcCreate(t, ts, rcCreateReq(wt, "f1", "new", 1, "n", p))
	if n.Rev != "uncommitted" {
		t.Fatalf("new-side rev = %q", n.Rev)
	}
	o := rcCreate(t, ts, rcCreateReq(wt, "base", "old", 1, "o", p))
	if o.Rev != p.OldRev {
		t.Fatalf("old-side rev = %q, want %q", o.Rev, p.OldRev)
	}
}

func TestReviewCommentsCreateRejects(t *testing.T) {
	t.Parallel()
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	cases := []struct {
		name string
		mod  func(m map[string]any)
		want int
	}{
		{"empty body", func(m map[string]any) { m["body"] = "  " }, 400},
		{"bad file", func(m map[string]any) { m["file"] = "../x" }, 400},
		{"absolute file", func(m map[string]any) { m["file"] = "/etc/passwd" }, 400},
		{"zero line", func(m map[string]any) { m["start_line"] = 0 }, 400},
		{"unknown rev", func(m map[string]any) { m["new_rev"] = "deadbeef" }, 404},
		{"unregistered", func(m map[string]any) { m["path"] = "/not/registered" }, 404},
		{"bad side", func(m map[string]any) { m["side"] = "left" }, 400},
		{"bad base", func(m map[string]any) { m["base"] = "x" }, 400},
		{"missing file", func(m map[string]any) { m["file"] = "nope" }, 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := rcCreateReq(wt, "f1", "new", 1, "b", p)
			tc.mod(req)
			if code, body := rcPost(t, ts, "", req); code != tc.want {
				t.Fatalf("status %d, want %d: %s", code, tc.want, body)
			}
		})
	}
}

func TestReviewCommentsUpdateConflict(t *testing.T) {
	t.Parallel()
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	c := rcCreate(t, ts, rcCreateReq(wt, "f1", "new", 1, "first", p))

	code, body := rcPost(t, ts, "/update", map[string]any{"path": wt, "id": c.ID, "version": 1, "body": "second"})
	var u reviewCommentDTO
	json.Unmarshal(body, &u)
	if code != 200 || u.Version != 2 || u.Body != "second" {
		t.Fatalf("update: %d %s", code, body)
	}
	code, body = rcPost(t, ts, "/update", map[string]any{"path": wt, "id": c.ID, "version": 1, "body": "third"})
	var conflict struct {
		Error   string           `json:"error"`
		Comment reviewCommentDTO `json:"comment"`
	}
	json.Unmarshal(body, &conflict)
	if code != 409 || conflict.Error != "changed elsewhere" || conflict.Comment.Body != "second" {
		t.Fatalf("conflict: %d %s", code, body)
	}
	if code, _ := rcPost(t, ts, "/delete", map[string]any{"path": wt, "id": c.ID}); code != 204 {
		t.Fatalf("delete status %d", code)
	}
	if code, body := rcPost(t, ts, "/update", map[string]any{"path": wt, "id": c.ID, "version": 2, "body": "x"}); code != 404 {
		t.Fatalf("update after delete: %d %s", code, body)
	}
}

func TestReviewCommentsDeleteAndClear(t *testing.T) {
	t.Parallel()
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	a := rcCreate(t, ts, rcCreateReq(wt, "f1", "new", 1, "a", p))
	rcCreate(t, ts, rcCreateReq(wt, "f2", "new", 1, "b", p))

	for i := 0; i < 2; i++ {
		if code, _ := rcPost(t, ts, "/delete", map[string]any{"path": wt, "id": a.ID}); code != 204 {
			t.Fatalf("delete #%d status %d", i, code)
		}
	}
	if got := rcList(t, ts, wt); len(got) != 1 {
		t.Fatalf("after delete: %+v", got)
	}
	if code, _ := rcPost(t, ts, "/clear", map[string]any{"path": wt}); code != 204 {
		t.Fatalf("clear status %d", code)
	}
	if got := rcList(t, ts, wt); len(got) != 0 {
		t.Fatalf("after clear: %+v", got)
	}
}
