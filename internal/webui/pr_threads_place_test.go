package webui

import (
	"strings"
	"testing"

	wgithub "github.com/mturley/watcher/github"
)

// placeOne places a single thread against the view p and returns it.
func placeOne(t *testing.T, wt string, th wgithub.ReviewThread, p patchResp) prThreadView {
	t.Helper()
	baseOid := strings.TrimSpace(gitIn(t, wt, "rev-parse", "origin/main"))
	got, err := newReviewResolver().placeThreads(wt, &wgithub.PRReviewThreads{
		HeadRefName: "feature", BaseRefOid: baseOid, Threads: []wgithub.ReviewThread{th},
	}, &reviewView{oldRev: p.OldRev, newRev: p.NewRev})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d threads", len(got))
	}
	return got[0]
}

func headSHA(t *testing.T, wt string) string {
	t.Helper()
	return strings.TrimSpace(gitIn(t, wt, "rev-parse", "HEAD"))
}

func rightThread(commit string, start, line int) wgithub.ReviewThread {
	return wgithub.ReviewThread{
		ID: "T1", Path: "multi", DiffSide: "RIGHT",
		OriginalLine: line, OriginalStartLine: start,
		Comments: []wgithub.ThreadComment{{DatabaseID: 1, Body: "c", OriginalCommit: commit}},
	}
}

func TestPlaceThreadsRight(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	c1 := headSHA(t, wt)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")

	got := placeOne(t, wt, rightThread(c1, 3, 4), p)
	if got.view == nil || got.view.Status != "shown" || got.view.StartLine != 3 || got.view.EndLine != 4 || got.view.Moved {
		t.Fatalf("view = %+v", got.view)
	}
	if got.anchor == nil || got.anchor.File != "multi" || got.anchor.Base != "merge-base" ||
		got.anchor.Anchor.Start != 3 || got.anchor.Anchor.End != 4 || len(got.anchor.Anchor.Snippet) != 2 {
		t.Fatalf("anchor = %+v", got.anchor)
	}
}

func TestPlaceThreadsSingleLine(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	c1 := headSHA(t, wt)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")

	got := placeOne(t, wt, rightThread(c1, 0, 4), p)
	if got.view == nil || got.view.Status != "shown" || got.view.StartLine != 4 || got.view.EndLine != 4 {
		t.Fatalf("view = %+v", got.view)
	}
}

func TestPlaceThreadsMoved(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	c1 := headSHA(t, wt)
	writeWT(t, wt, "multi", "new1\nnew2\n"+rcMulti)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")

	got := placeOne(t, wt, rightThread(c1, 0, 4), p)
	if got.view == nil || got.view.Status != "shown" || !got.view.Moved || got.view.StartLine != 6 || got.view.EndLine != 6 {
		t.Fatalf("view = %+v", got.view)
	}
}

func TestPlaceThreadsLeft(t *testing.T) {
	wt := forkRepo(t)
	// "base" is "1" at the merge-base; the PR replaces that line.
	commitFile(t, wt, "base", "2")
	c1 := headSHA(t, wt)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")

	th := wgithub.ReviewThread{
		ID: "T1", Path: "base", DiffSide: "LEFT", OriginalLine: 1,
		Comments: []wgithub.ThreadComment{{DatabaseID: 1, OriginalCommit: c1}},
	}
	got := placeOne(t, wt, th, p)
	if got.view == nil || got.view.Status != "shown" || got.view.StartLine != 1 {
		t.Fatalf("view = %+v", got.view)
	}
	if got.anchor == nil || got.anchor.Side != "old" || got.anchor.Anchor.Snippet[0] != "1" {
		t.Fatalf("anchor = %+v", got.anchor)
	}
}

func TestPlaceThreadsMissingCommit(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")

	got := placeOne(t, wt, rightThread("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", 0, 4), p)
	if got.view == nil || got.view.Status != "unavailable" || got.anchor != nil {
		t.Fatalf("got anchor=%+v view=%+v", got.anchor, got.view)
	}
}

func TestPlaceThreadsLineOutOfRange(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	c1 := headSHA(t, wt)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")

	got := placeOne(t, wt, rightThread(c1, 0, 99), p)
	if got.view == nil || got.view.Status != "unavailable" {
		t.Fatalf("view = %+v", got.view)
	}
}

func TestPlaceThreadsGitHubOutdated(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	c1 := headSHA(t, wt)
	_, ts := gitTestServer(t, wt, nil)
	p := getPatch(t, ts, wt, "")

	th := rightThread(c1, 0, 4)
	th.IsOutdated = true
	got := placeOne(t, wt, th, p)
	if got.view == nil || got.view.Status != "outdated" {
		t.Fatalf("view = %+v", got.view)
	}
}

func TestPlaceThreadsGitHubOutdatedKeepsNotInView(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	c1 := headSHA(t, wt)
	_, ts := gitTestServer(t, wt, nil)
	f2 := strings.TrimSpace(gitIn(t, wt, "rev-parse", "HEAD~1")) // "add f2"
	single := getPatch(t, ts, wt, "&from="+f2+"&to="+f2)

	th := rightThread(c1, 0, 4)
	th.IsOutdated = true
	got := placeOne(t, wt, th, single)
	if got.view == nil || got.view.Status != "not_in_view" {
		t.Fatalf("view = %+v", got.view)
	}
}
