package webui

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/gitutil"
)

func diffGet(t *testing.T, ts *httptest.Server, endpoint, path, query string) (int, []byte) {
	t.Helper()
	resp, err := http.Get(ts.URL + "/api/worktree-diff/" + endpoint + "?path=" + url.QueryEscape(path) + query)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, body
}

type patchResp struct {
	ListID             string `json:"list_id"`
	WorkingFingerprint string `json:"working_fingerprint"`
	OldRev             string `json:"old_rev"`
	NewRev             string `json:"new_rev"`
	Patch              string `json:"patch"`
}

func getPatch(t *testing.T, ts *httptest.Server, path, query string) patchResp {
	t.Helper()
	code, body := diffGet(t, ts, "patch", path, "&base=merge-base"+query)
	if code != 200 {
		t.Fatalf("patch status %d: %s", code, body)
	}
	var p patchResp
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestDiffCommitsListsBranchCommits(t *testing.T) {
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	code, body := diffGet(t, ts, "commits", wt, "&base=merge-base")
	if code != 200 {
		t.Fatalf("status %d: %s", code, body)
	}
	var got struct {
		ListID    string           `json:"list_id"`
		BaseRef   string           `json:"base_ref"`
		MergeBase string           `json:"merge_base"`
		Commits   []gitutil.Commit `json:"commits"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.BaseRef != "origin/main" || len(got.MergeBase) != 40 || got.ListID == "" {
		t.Fatalf("got %+v", got)
	}
	if len(got.Commits) != 2 || got.Commits[0].Subject != "add f2" || got.Commits[1].Subject != "add f1" {
		t.Fatalf("commits = %+v", got.Commits)
	}

	// Against the tracking branch only the unpushed commit remains.
	code, body = diffGet(t, ts, "commits", wt, "&base=tracking")
	if code != 200 {
		t.Fatalf("tracking status %d: %s", code, body)
	}
	got.Commits = nil
	json.Unmarshal(body, &got)
	if got.BaseRef != "origin/feature" || len(got.Commits) != 1 {
		t.Fatalf("tracking: %+v", got)
	}
}

func TestDiffCommitsTrackingUnavailable409(t *testing.T) {
	wt := forkRepo(t)
	gitIn(t, wt, "checkout", "-b", "local-only")
	_, ts := gitTestServer(t, wt, nil)
	code, body := diffGet(t, ts, "commits", wt, "&base=tracking")
	if code != http.StatusConflict {
		t.Fatalf("status %d: %s", code, body)
	}
	var e struct{ Error string }
	json.Unmarshal(body, &e)
	if e.Error == "" {
		t.Fatalf("no error message: %s", body)
	}
}

func TestDiffUnknownBase400(t *testing.T) {
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	if code, _ := diffGet(t, ts, "commits", wt, "&base=bogus"); code != 400 {
		t.Fatalf("status %d", code)
	}
}

func TestDiffFilesAllChangesIncludesUntracked(t *testing.T) {
	wt := forkRepo(t)
	os.WriteFile(filepath.Join(wt, "untracked.txt"), []byte("u\n"), 0o644)
	_, ts := gitTestServer(t, wt, nil)
	code, body := diffGet(t, ts, "files", wt, "&base=merge-base")
	if code != 200 {
		t.Fatalf("status %d: %s", code, body)
	}
	var got struct {
		Fingerprint string               `json:"fingerprint"`
		ListID      string               `json:"list_id"`
		Files       []gitutil.FileChange `json:"files"`
	}
	json.Unmarshal(body, &got)
	paths := map[string]bool{}
	for _, f := range got.Files {
		paths[f.Path] = true
	}
	if !paths["f1"] || !paths["f2"] || !paths["untracked.txt"] || paths["upstream-change"] {
		t.Fatalf("files = %+v", got.Files)
	}
	if got.Fingerprint == "" || got.ListID == "" {
		t.Fatalf("missing fingerprint/list_id: %s", body)
	}
}

func TestDiffPatchReturnsResolvedRevs(t *testing.T) {
	wt := forkRepo(t)
	os.WriteFile(filepath.Join(wt, "untracked.txt"), []byte("u\n"), 0o644)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	if len(p.OldRev) != 40 || len(p.NewRev) != 40 || p.OldRev == p.NewRev {
		t.Fatalf("revs: %+v", p)
	}
	if !strings.Contains(p.Patch, "untracked.txt") || p.WorkingFingerprint == "" || p.ListID == "" {
		t.Fatalf("patch resp: %+v", p)
	}
}

func TestDiffFileServesHandedOutRev(t *testing.T) {
	wt := forkRepo(t)
	os.WriteFile(filepath.Join(wt, "untracked.txt"), []byte("u\nbytes\n"), 0o644)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")

	for rev, want := range map[string]struct {
		file, content string
	}{
		p.NewRev: {"untracked.txt", "u\nbytes\n"},
		p.OldRev: {"base", "1"},
	} {
		resp, err := http.Get(ts.URL + "/api/worktree-diff/file?path=" + url.QueryEscape(wt) +
			"&rev=" + rev + "&file=" + want.file)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || string(body) != want.content {
			t.Fatalf("%s: %d %q", want.file, resp.StatusCode, body)
		}
		if ct := resp.Header.Get("Content-Type"); ct != "text/plain; charset=utf-8" {
			t.Fatalf("content-type %q", ct)
		}
	}

	// A missing path at a handed-out rev is a 404.
	code, _ := diffGet(t, ts, "file", wt, "&rev="+p.NewRev+"&file=nope")
	if code != 404 {
		t.Fatalf("missing file status %d", code)
	}
}

func TestDiffFileRejectsUnknownRev(t *testing.T) {
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	head := strings.TrimSpace(gitIn(t, wt, "rev-parse", "HEAD"))
	if code, body := diffGet(t, ts, "file", wt, "&rev="+head+"&file=f1"); code != 404 {
		t.Fatalf("status %d: %s", code, body)
	}
	// Even a perfectly real ref name is refused unless handed out.
	if code, _ := diffGet(t, ts, "file", wt, "&rev=HEAD&file=f1"); code != 404 {
		t.Fatalf("HEAD status %d", code)
	}
}

func TestDiffFileCannotReadIgnoredFile(t *testing.T) {
	wt := forkRepo(t)
	os.WriteFile(filepath.Join(wt, ".gitignore"), []byte(".env.local\n"), 0o644)
	os.WriteFile(filepath.Join(wt, ".env.local"), []byte("SECRET=1\n"), 0o644)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")
	if strings.Contains(p.Patch, "SECRET") {
		t.Fatal("ignored file leaked into the patch")
	}
	for _, rev := range []string{p.NewRev, p.OldRev} {
		code, body := diffGet(t, ts, "file", wt, "&rev="+rev+"&file=.env.local")
		if code != 404 || strings.Contains(string(body), "SECRET") {
			t.Fatalf("rev %s: status %d body %q", rev, code, body)
		}
	}
}

func TestDiffRejectsInvalidRange(t *testing.T) {
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	head := strings.TrimSpace(gitIn(t, wt, "rev-parse", "HEAD"))
	for _, q := range []string{
		"&from=" + strings.Repeat("a", 40) + "&to=" + head, // not in the list
		"&from=" + head, // only one end
		"&to=" + head,
	} {
		for _, ep := range []string{"files", "patch"} {
			if code, body := diffGet(t, ts, ep, wt, "&base=merge-base"+q); code != 400 {
				t.Fatalf("%s %s: status %d: %s", ep, q, code, body)
			}
		}
	}
}

func TestDiffExplicitRange(t *testing.T) {
	wt := forkRepo(t)
	head := strings.TrimSpace(gitIn(t, wt, "rev-parse", "HEAD"))
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "&from="+head+"&to="+head)
	if p.NewRev != head || !strings.Contains(p.Patch, "f2") || strings.Contains(p.Patch, "f1") {
		t.Fatalf("range patch: %+v", p)
	}
}

func TestDiffUnregisteredPath404(t *testing.T) {
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	other := t.TempDir()
	for _, ep := range []string{"commits", "files", "patch", "file"} {
		if code, _ := diffGet(t, ts, ep, other, "&base=merge-base&rev=x&file=y"); code != 404 {
			t.Fatalf("%s: status %d", ep, code)
		}
	}
}

func TestDiffPatchTooLarge413(t *testing.T) {
	old := gitutil.MaxPatchBytes
	gitutil.MaxPatchBytes = 10
	defer func() { gitutil.MaxPatchBytes = old }()
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	if code, _ := diffGet(t, ts, "patch", wt, "&base=merge-base"); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status %d", code)
	}
}

func TestRevSetExpiresAndEvicts(t *testing.T) {
	now := time.Unix(1000, 0)
	rs := newRevSet()
	rs.now = func() time.Time { return now }

	rs.add("/a", "r1")
	if !rs.has("/a", "r1") || rs.has("/b", "r1") {
		t.Fatal("scoping by worktree path failed")
	}
	now = now.Add(revSetTTL + time.Second)
	if rs.has("/a", "r1") {
		t.Fatal("entry should have expired")
	}

	for i := 0; i < revSetMax+5; i++ {
		rs.add("/a", fmt.Sprintf("rev%d", i))
	}
	if rs.has("/a", "rev0") || !rs.has("/a", fmt.Sprintf("rev%d", revSetMax+4)) {
		t.Fatal("oldest should be evicted, newest kept")
	}
	if len(rs.entries) != revSetMax {
		t.Fatalf("len = %d", len(rs.entries))
	}
}
