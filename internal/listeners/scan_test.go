package listeners

import (
	"context"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
)

type fakeRunner struct {
	mu     sync.Mutex
	calls  [][]string
	listen func() ([]byte, error)
	ps     string
	cwd    map[int]string
}

func (f *fakeRunner) run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, append([]string{name}, args...))
	switch {
	case name == "ps":
		return []byte(f.ps), nil
	case name == "lsof" && strings.Contains(strings.Join(args, " "), "-iTCP"):
		return f.listen()
	case name == "lsof":
		var out strings.Builder
		pids := args[2] // -a -p <pids>
		for _, s := range strings.Split(pids, ",") {
			for pid, cwd := range f.cwd {
				if s == strconv.Itoa(pid) {
					out.WriteString("p" + s + "\nn" + cwd + "\n")
				}
			}
		}
		return []byte(out.String()), nil
	}
	return nil, errors.New("unexpected call")
}

func testWts() []Worktree {
	return []Worktree{{Path: "/wt/a", Canon: "/wt/a", Start: 3000, End: 3009, HasRange: true}}
}

const listen10 = "p10\ncnode\nn*:3001\n"

func okListen(s string) func() ([]byte, error) {
	return func() ([]byte, error) { return []byte(s), nil }
}

func TestScanAttributesByCwd(t *testing.T) {
	f := &fakeRunner{listen: okListen(listen10), cwd: map[int]string{10: "/wt/a/sub"}}
	snap, err := Scan(context.Background(), f.run, testWts())
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Ports["/wt/a"]) != 1 || snap.Ports["/wt/a"][0].Port != 3001 {
		t.Fatalf("snap = %+v", snap)
	}
	if len(f.calls) != 2 {
		t.Fatalf("calls = %v", f.calls)
	}
}

func TestScanFallsBackToAncestor(t *testing.T) {
	f := &fakeRunner{
		listen: okListen(listen10),
		ps:     "10 5\n5 1\n1 0\n",
		cwd:    map[int]string{10: "/elsewhere", 5: "/wt/a"},
	}
	snap, err := Scan(context.Background(), f.run, testWts())
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Ports["/wt/a"]) != 1 {
		t.Fatalf("snap = %+v", snap)
	}
	if len(f.calls) != 4 {
		t.Fatalf("calls = %v", f.calls)
	}
}

func TestScanEmptyLsofIsNotError(t *testing.T) {
	exitErr := exec.Command("sh", "-c", "exit 1").Run()
	var ee *exec.ExitError
	if !errors.As(exitErr, &ee) {
		t.Fatalf("setup: %v", exitErr)
	}
	f := &fakeRunner{listen: func() ([]byte, error) { return nil, exitErr }}
	snap, err := Scan(context.Background(), f.run, testWts())
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Ports) != 0 || snap.Ranges["/wt/a"] != "3000-3009" {
		t.Fatalf("snap = %+v", snap)
	}
}

func TestScanPropagatesOtherErrors(t *testing.T) {
	f := &fakeRunner{listen: func() ([]byte, error) { return nil, errors.New("boom") }}
	if _, err := Scan(context.Background(), f.run, testWts()); err == nil {
		t.Fatal("want error")
	}
}

func TestAttributeSkipsVanishedAndCycles(t *testing.T) {
	// pid 5 has no cwd line (vanished) and sits in a 5<->6 cycle; pid 7's
	// parent 99 is missing from ps.
	f := &fakeRunner{
		listen: okListen("p5\ncnode\nn*:3001\np7\ncnode\nn*:3002\n"),
		ps:     "5 6\n6 5\n7 99\n",
		cwd:    map[int]string{},
	}
	snap, err := Scan(context.Background(), f.run, testWts())
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Ports) != 0 {
		t.Fatalf("snap = %+v", snap)
	}
}
