package webui

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// rcListView lists with a view's revs, returning the status, raw body and
// decoded items.
func rcListView(t *testing.T, ts *httptest.Server, path, oldRev, newRev string) (int, []byte, []reviewCommentItem) {
	t.Helper()
	q := "?path=" + url.QueryEscape(path) + "&old_rev=" + url.QueryEscape(oldRev) + "&new_rev=" + url.QueryEscape(newRev)
	resp, err := http.Get(ts.URL + "/api/review-comments" + q)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var out struct {
		Comments []reviewCommentItem `json:"comments"`
	}
	if resp.StatusCode == 200 {
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode, body, out.Comments
}

// rcOne lists with p's revs and returns the single comment.
func rcOne(t *testing.T, ts *httptest.Server, path string, p patchResp) reviewCommentItem {
	t.Helper()
	code, body, items := rcListView(t, ts, path, p.OldRev, p.NewRev)
	if code != 200 || len(items) != 1 {
		t.Fatalf("list: %d %s", code, body)
	}
	return items[0]
}

func writeWT(t *testing.T, wt, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(wt, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

const rcMulti = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n"

func TestReviewCommentsViewShown(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	rcCreate(t, ts, rcCreateReq(wt, "multi", "new", 4, "c", p))

	got := rcOne(t, ts, wt, p)
	if got.View == nil || got.View.Status != "shown" || got.View.StartLine != 4 || got.View.EndLine != 4 || got.View.Moved {
		t.Fatalf("view = %+v", got.View)
	}
	if got.Prompt.Status != "current" || got.Prompt.StartLine != 4 || got.Prompt.EndLine != 4 {
		t.Fatalf("prompt = %+v", got.Prompt)
	}
	// Without revs there is no view, but there is a prompt.
	plain := rcList(t, ts, wt)
	if len(plain) != 1 || plain[0].View != nil || plain[0].Prompt.Status != "current" {
		t.Fatalf("plain list = %+v", plain)
	}
}

func TestReviewCommentsPromptMoved(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	rcCreate(t, ts, rcCreateReq(wt, "multi", "new", 4, "c", p))
	writeWT(t, wt, "multi", "new1\nnew2\n"+rcMulti)

	got := rcOne(t, ts, wt, p)
	if got.Prompt.Status != "moved" || got.Prompt.StartLine != 6 || got.Prompt.EndLine != 6 {
		t.Fatalf("prompt = %+v", got.Prompt)
	}
	if got.View == nil || got.View.Status != "shown" || got.View.StartLine != 4 || got.View.Moved {
		t.Fatalf("view = %+v (should stay frozen at the patch's content)", got.View)
	}
}

func TestReviewCommentsViewMovedAfterRefresh(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	rcCreate(t, ts, rcCreateReq(wt, "multi", "new", 4, "c", p))
	writeWT(t, wt, "multi", "new1\nnew2\n"+rcMulti)
	p2 := getPatch(t, ts, wt, "")

	got := rcOne(t, ts, wt, p2)
	if got.View == nil || got.View.Status != "shown" || !got.View.Moved || got.View.StartLine != 6 || got.View.EndLine != 6 {
		t.Fatalf("view = %+v", got.View)
	}
}

func TestReviewCommentsOutdated(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	rcCreate(t, ts, rcCreateReq(wt, "multi", "new", 4, "c", p))
	writeWT(t, wt, "multi", strings.Replace(rcMulti, "delta", "DELTA", 1))
	p2 := getPatch(t, ts, wt, "")

	got := rcOne(t, ts, wt, p2)
	if got.View == nil || got.View.Status != "outdated" {
		t.Fatalf("view = %+v", got.View)
	}
	if got.Prompt.Status != "outdated" || got.Prompt.StartLine != 4 || got.Prompt.EndLine != 4 {
		t.Fatalf("prompt = %+v", got.Prompt)
	}
}

func TestReviewCommentsNotInView(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	rcCreate(t, ts, rcCreateReq(wt, "multi", "new", 4, "c", p))

	f2 := strings.TrimSpace(gitIn(t, wt, "rev-parse", "HEAD~1")) // "add f2"
	single := getPatch(t, ts, wt, "&from="+f2+"&to="+f2)
	got := rcOne(t, ts, wt, single)
	if got.View == nil || got.View.Status != "not_in_view" || got.View.StartLine != 0 {
		t.Fatalf("view = %+v", got.View)
	}
}

func TestReviewCommentsOutsideChanges(t *testing.T) {
	wt := forkRepo(t)
	writeWT(t, wt, "base", "1\nextra line\n")
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	rcCreate(t, ts, rcCreateReq(wt, "base", "new", 2, "c", p))
	writeWT(t, wt, "base", "1")
	p2 := getPatch(t, ts, wt, "")

	got := rcOne(t, ts, wt, p2)
	if got.View == nil || got.View.Status != "outside_changes" {
		t.Fatalf("view = %+v", got.View)
	}
}

func TestReviewCommentsRemovedSide(t *testing.T) {
	wt := forkRepo(t)
	writeWT(t, wt, "base", "2")
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	rcCreate(t, ts, rcCreateReq(wt, "base", "old", 1, "o", p))

	got := rcOne(t, ts, wt, p)
	if got.Prompt.Status != "removed" || got.Prompt.StartLine != 1 || got.Prompt.EndLine != 1 {
		t.Fatalf("prompt = %+v", got.Prompt)
	}
	if got.View == nil || got.View.Status != "shown" || got.View.StartLine != 1 {
		t.Fatalf("view = %+v", got.View)
	}
}

func TestReviewCommentsPromptFileGone(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	rcCreate(t, ts, rcCreateReq(wt, "multi", "new", 4, "c", p))
	gitIn(t, wt, "mv", "multi", "renamed")

	got := rcOne(t, ts, wt, p)
	if got.Prompt.Status != "outdated" || got.Prompt.StartLine != 4 || got.Prompt.EndLine != 4 {
		t.Fatalf("prompt = %+v", got.Prompt)
	}
}

func TestReviewCommentsListUnknownRev(t *testing.T) {
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	if code, body, _ := rcListView(t, ts, wt, p.OldRev, "deadbeef"); code != 404 {
		t.Fatalf("status %d: %s", code, body)
	}
	if code, body, _ := rcListView(t, ts, wt, "deadbeef", p.NewRev); code != 404 {
		t.Fatalf("status %d: %s", code, body)
	}
}

func TestReviewCommentsListSorted(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	c6 := rcCreate(t, ts, rcCreateReq(wt, "multi", "new", 6, "six", p))
	c2 := rcCreate(t, ts, rcCreateReq(wt, "multi", "new", 2, "two", p))
	f1 := rcCreate(t, ts, rcCreateReq(wt, "f1", "new", 1, "f1", p))
	_, body, items := rcListView(t, ts, wt, p.OldRev, p.NewRev)
	if len(items) != 3 || items[0].ID != f1.ID || items[1].ID != c2.ID || items[2].ID != c6.ID {
		t.Fatalf("order: %s", body)
	}
}

func TestReviewResolverConcurrentLists(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	rcCreate(t, ts, rcCreateReq(wt, "multi", "new", 4, "c", p))
	rcCreate(t, ts, rcCreateReq(wt, "f1", "new", 1, "c", p))
	f2 := strings.TrimSpace(gitIn(t, wt, "rev-parse", "HEAD~1"))
	single := getPatch(t, ts, wt, "&from="+f2+"&to="+f2)

	bodies := make([]string, 8)
	var wg sync.WaitGroup
	for i := range bodies {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			resp, err := http.Get(ts.URL + "/api/review-comments?path=" + url.QueryEscape(wt) +
				"&old_rev=" + single.OldRev + "&new_rev=" + single.NewRev)
			if err != nil {
				return
			}
			defer resp.Body.Close()
			b, _ := io.ReadAll(resp.Body)
			bodies[i] = string(b)
		}(i)
	}
	wg.Wait()
	for i, b := range bodies {
		if b == "" || b != bodies[0] {
			t.Fatalf("body %d differs:\n%s\nvs\n%s", i, b, bodies[0])
		}
	}
	if !strings.Contains(bodies[0], `"not_in_view"`) {
		t.Fatalf("expected a not_in_view comment: %s", bodies[0])
	}
}
