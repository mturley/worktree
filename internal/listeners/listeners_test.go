package listeners

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestParseListen(t *testing.T) {
	t.Parallel()
	out := []byte("p27670\ncnode\nn[::1]:4091\nn127.0.0.1:4091\np6933\ncadb\nn127.0.0.1:5037\n")
	got := ParseListen(out)
	if len(got) != 3 {
		t.Fatalf("got %d listeners, want 3: %+v", len(got), got)
	}
	want := Listener{PID: 27670, Command: "node", Addr: "[::1]", Port: 4091}
	if got[0] != want {
		t.Errorf("got[0] = %+v, want %+v", got[0], want)
	}
	if got[2].PID != 6933 || got[2].Command != "adb" || got[2].Port != 5037 {
		t.Errorf("got[2] = %+v", got[2])
	}
	star := ParseListen([]byte("p1\ncx\nn*:8476\n"))
	if len(star) != 1 || star[0].Addr != "*" || star[0].Port != 8476 {
		t.Errorf("star = %+v", star)
	}
}

func TestParseCwd(t *testing.T) {
	t.Parallel()
	got := ParseCwd([]byte("p1\nn/a\np2\nn/b c\n"))
	want := map[int]string{1: "/a", 2: "/b c"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestParsePPID(t *testing.T) {
	t.Parallel()
	got := ParsePPID([]byte("  1     0\n 42     1\n"))
	want := map[int]int{1: 0, 42: 1}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestOwnerDeepestWins(t *testing.T) {
	t.Parallel()
	wts := []Worktree{{Path: "/w/a", Canon: "/w/a"}, {Path: "/w/a/sub", Canon: "/w/a/sub"}}
	if p, ok := Owner("/w/a/sub/x", wts); !ok || p != "/w/a/sub" {
		t.Errorf("got %q %v", p, ok)
	}
	if p, ok := Owner("/w/a", wts); !ok || p != "/w/a" {
		t.Errorf("got %q %v", p, ok)
	}
}

func TestAttributeIgnoresSiblingPrefix(t *testing.T) {
	t.Parallel()
	if p, ok := Owner("/w/foo-bar/frontend", []Worktree{{Path: "/w/foo", Canon: "/w/foo"}}); ok {
		t.Errorf("unexpected owner %q", p)
	}
}

func TestAttributeMergesAndRanges(t *testing.T) {
	t.Parallel()
	wts := []Worktree{
		{Path: "/w/a", Canon: "/w/a", Start: 4090, End: 4099, HasRange: true},
		{Path: "/w/b", Canon: "/w/b"},
	}
	ls := []Listener{
		{PID: 10, Command: "node", Addr: "[::1]", Port: 4091},
		{PID: 10, Command: "node", Addr: "127.0.0.1", Port: 4091},
		{PID: 10, Command: "node", Addr: "*", Port: 9000},
		{PID: 20, Command: "vite", Addr: "*", Port: 3000},
	}
	s := Attribute(ls, map[int]string{10: "/w/a", 20: "/w/b"}, wts)
	if !s.Enabled {
		t.Error("not enabled")
	}
	want := []Port{
		{Port: 4091, Addresses: []string{"127.0.0.1", "[::1]"}, PID: 10, Process: "node", InRange: true},
		{Port: 9000, Addresses: []string{"*"}, PID: 10, Process: "node", InRange: false},
	}
	if !reflect.DeepEqual(s.Ports["/w/a"], want) {
		t.Errorf("a ports = %+v", s.Ports["/w/a"])
	}
	if len(s.Ports["/w/b"]) != 1 || !s.Ports["/w/b"][0].InRange {
		t.Errorf("b ports = %+v", s.Ports["/w/b"])
	}
	if s.Ranges["/w/a"] != "4090-4099" {
		t.Errorf("ranges = %v", s.Ranges)
	}
	if _, ok := s.Ranges["/w/b"]; ok {
		t.Error("b should be absent from Ranges")
	}
	e := Attribute(nil, nil, nil)
	if e.Ports == nil || e.Ranges == nil {
		t.Error("maps must not be nil")
	}
}

func TestAttributeLowestPID(t *testing.T) {
	t.Parallel()
	wts := []Worktree{{Path: "/w/a", Canon: "/w/a"}}
	ls := []Listener{
		{PID: 50, Command: "b", Addr: "*", Port: 80},
		{PID: 5, Command: "a", Addr: "*", Port: 80},
	}
	s := Attribute(ls, map[int]string{50: "/w/a", 5: "/w/a"}, wts)
	p := s.Ports["/w/a"]
	if len(p) != 1 || p[0].PID != 5 || p[0].Process != "a" {
		t.Errorf("got %+v", p)
	}
}

func TestCanonicalResolvesSymlink(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	real := filepath.Join(dir, "real")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if Canonical(link) != Canonical(real) {
		t.Errorf("%q != %q", Canonical(link), Canonical(real))
	}
	missing := filepath.Join(dir, "nope", "..", "gone")
	abs, _ := filepath.Abs(missing)
	if got := Canonical(missing); got != filepath.Clean(abs) {
		t.Errorf("got %q want %q", got, filepath.Clean(abs))
	}
}
