package gitutil

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestWorkingStateWith_NeedsContext documents the blocked state: as the
// brief specifies it, WorkingStateWith(dir, bs, refSHAs) is given only the
// branch/upstream/ahead-behind header facts (BranchStatus), never the
// per-path status entries a StatusV2 call also produces. Building
// WorkingSummary/the working fingerprint requires those entries (XY + path
// per changed/untracked file) plus an Lstat per entry — there is no way to
// derive them from BranchStatus and refSHAs alone without running `git
// status` again, which would defeat the "ref tier valid => 1 git process"
// budget this function exists to meet. See the NEEDS_CONTEXT note on
// WorkingStateWith in statusv2.go and task-3-report.md.
func TestWorkingStateWith_NeedsContext(t *testing.T) {
	before := SpawnCount()
	_, _, err := WorkingStateWith("", BranchStatus{HeadSHA: "abc"}, map[string]string{"main": "abc"})
	if delta := SpawnCount() - before; delta != 0 {
		t.Errorf("SpawnCount delta = %d, want 0 (no git process should start)", delta)
	}
	if err == nil {
		t.Fatal("expected error: signature lacks the status entries needed to build WorkingSummary/Fingerprint")
	}
}

func TestParseStatusV2(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want BranchStatus
	}{
		{
			name: "clean on branch with upstream",
			out:  "# branch.oid abc123\x00# branch.head main\x00# branch.upstream origin/main\x00# branch.ab +2 -1\x00",
			want: BranchStatus{HeadSHA: "abc123", Branch: "main", Upstream: "origin/main", Ahead: 2, Behind: 1, HasAB: true},
		},
		{
			name: "detached",
			out:  "# branch.oid abc123\x00# branch.head (detached)\x00",
			want: BranchStatus{HeadSHA: "abc123", Branch: ""},
		},
		{
			name: "unborn",
			out:  "# branch.oid (initial)\x00# branch.head main\x00",
			want: BranchStatus{HeadSHA: "", Branch: "main"},
		},
		{
			name: "no upstream",
			out:  "# branch.oid abc123\x00# branch.head main\x00",
			want: BranchStatus{HeadSHA: "abc123", Branch: "main", Upstream: "", HasAB: false},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			bs, _, _ := parseStatusV2(tc.out)
			if bs != tc.want {
				t.Errorf("parseStatusV2(%q) = %+v, want %+v", tc.out, bs, tc.want)
			}
		})
	}
}

func TestParseStatusV2DirtyMix(t *testing.T) {
	out := "# branch.oid abc123\x00# branch.head main\x00" +
		"1 .M N... 100644 100644 100644 h h path1\x00" +
		"1 A. N... 100644 100644 100644 h h path2\x00" +
		"1 MM N... 100644 100644 100644 h h path3\x00" +
		"2 R. N... 100644 100644 100644 h h R100 path4\x00orig4\x00" +
		"? new\x00"
	_, ws, entries := parseStatusV2(out)
	if ws.Staged != 3 {
		t.Errorf("Staged = %d, want 3", ws.Staged)
	}
	if ws.Modified != 2 {
		t.Errorf("Modified = %d, want 2", ws.Modified)
	}
	if ws.Untracked != 1 {
		t.Errorf("Untracked = %d, want 1", ws.Untracked)
	}
	if ws.Files != 5 {
		t.Errorf("Files = %d, want 5", ws.Files)
	}
	if len(entries) != 5 {
		t.Fatalf("entries = %d, want 5", len(entries))
	}
	if entries[3].XY != "R " || entries[3].Path != "path4" {
		t.Errorf("rename entry = %+v, want {R , path4}", entries[3])
	}
	if entries[4].XY != "??" || entries[4].Path != "new" {
		t.Errorf("untracked entry = %+v, want {??, new}", entries[4])
	}
}

func TestStatusV2_MatchesLegacyHelpers(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T) (dir string)
	}{
		{"clean", func(t *testing.T) string {
			repo, _ := newRemoteRepo(t)
			return repo
		}},
		{"dirty", func(t *testing.T) string {
			repo, _ := newRemoteRepo(t)
			if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte("changed\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(repo, "new.txt"), []byte("new\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			return repo
		}},
		{"detached", func(t *testing.T) string {
			repo, run := newRemoteRepo(t)
			run("checkout", "--detach", "HEAD")
			return repo
		}},
		{"no-upstream", func(t *testing.T) string {
			base := t.TempDir()
			repo := filepath.Join(base, "repo")
			if err := os.MkdirAll(repo, 0o755); err != nil {
				t.Fatal(err)
			}
			runIn(t, repo, "init", "-b", "main")
			commitFile(t, repo, "f.txt", "x\n")
			return repo
		}},
		{"linked worktree with upstream set", func(t *testing.T) string {
			_, run := newRemoteRepo(t)
			wt := filepath.Join(t.TempDir(), "wt")
			run("worktree", "add", "-b", "feat", wt)
			runIn(t, wt, "branch", "-u", "origin/main", "feat")
			return wt
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := tc.setup(t)

			wantBranch, branchOK := CurrentBranch(dir)
			wantUpstream, upstreamOK := TrackingBranch(dir)
			var wantAhead, wantBehind int
			var wantHasAB bool
			if upstreamOK {
				a, b, ok := AheadBehind(dir, wantUpstream)
				wantAhead, wantBehind, wantHasAB = a, b, ok
			}
			_, wantWS, wantFP, err := legacyWorkingState(dir)
			if err != nil {
				t.Fatal(err)
			}

			before := SpawnCount()
			bs, ws, fp, err := StatusV2(dir)
			if err != nil {
				t.Fatal(err)
			}
			if delta := SpawnCount() - before; delta != 1 {
				t.Errorf("SpawnCount delta = %d, want 1", delta)
			}

			if branchOK && bs.Branch != wantBranch {
				t.Errorf("Branch = %q, want %q", bs.Branch, wantBranch)
			}
			if !branchOK && bs.Branch != "" {
				t.Errorf("Branch = %q, want \"\" (detached)", bs.Branch)
			}
			if bs.Upstream != wantUpstream {
				t.Errorf("Upstream = %q, want %q", bs.Upstream, wantUpstream)
			}
			if wantHasAB != bs.HasAB {
				t.Errorf("HasAB = %v, want %v", bs.HasAB, wantHasAB)
			}
			if wantHasAB {
				if bs.Ahead != wantAhead || bs.Behind != wantBehind {
					t.Errorf("Ahead/Behind = %d/%d, want %d/%d", bs.Ahead, bs.Behind, wantAhead, wantBehind)
				}
			}
			if ws != wantWS {
				t.Errorf("WorkingSummary = %+v, want %+v", ws, wantWS)
			}
			if fp.Working != wantFP.Working {
				t.Errorf("Working fingerprint = %q, want %q", fp.Working, wantFP.Working)
			}
		})
	}
}

// legacyWorkingState is the pre-change `git status --porcelain=v1 -uall -z`
// based computation, kept here only so TestStatusV2_MatchesLegacyHelpers can
// assert the new porcelain-v2 path produces identical WorkingSummary/Working
// fingerprint values.
func legacyWorkingState(dir string) (WorkingSummary, WorkingSummary, Fingerprint, error) {
	out, err := gitRaw(dir, nil, "status", "--porcelain=v1", "-uall", "-z")
	if err != nil {
		return WorkingSummary{}, WorkingSummary{}, Fingerprint{}, err
	}
	var ws WorkingSummary
	h := sha256.New()
	fields := strings.Split(out, "\x00")
	for i := 0; i < len(fields); i++ {
		entry := fields[i]
		if len(entry) < 4 {
			continue
		}
		xy, path := entry[:2], entry[3:]
		if xy[0] == 'R' || xy[0] == 'C' || xy[1] == 'R' || xy[1] == 'C' {
			i++
		}
		ws.Files++
		if xy == "??" {
			ws.Untracked++
		} else {
			if xy[0] != ' ' {
				ws.Staged++
			}
			if xy[1] != ' ' {
				ws.Modified++
			}
		}
		fmt.Fprintf(h, "%s %s\x00", xy, path)
		info, err := os.Lstat(filepath.Join(dir, path))
		if err != nil {
			io.WriteString(h, "missing\x00")
			continue
		}
		fmt.Fprintf(h, "%d %d\x00", info.Size(), info.ModTime().UnixNano())
	}
	return ws, ws, Fingerprint{Working: hex.EncodeToString(h.Sum(nil))}, nil
}
