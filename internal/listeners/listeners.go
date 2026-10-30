// Package listeners parses lsof/ps output and attributes TCP listeners to
// git worktrees. It is pure: it runs no processes.
package listeners

import (
	"bufio"
	"bytes"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Listener is one listening TCP socket.
type Listener struct {
	PID     int
	Command string
	Addr    string
	Port    int
}

// Port is one listening port attributed to a worktree.
type Port struct {
	Port      int      `json:"port"`
	Addresses []string `json:"addresses"`
	PID       int      `json:"pid"`
	Process   string   `json:"process"`
	InRange   bool     `json:"in_range"`
}

// Worktree is a worktree as seen by attribution. Canon is Canonical(Path).
type Worktree struct {
	Path, Canon string
	Start, End  int
	HasRange    bool
}

// Snapshot is the result of one scan.
type Snapshot struct {
	Enabled bool              `json:"enabled"`
	Ports   map[string][]Port `json:"ports"`
	Ranges  map[string]string `json:"ranges"`
}

func lines(out []byte) []string {
	var ls []string
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		ls = append(ls, sc.Text())
	}
	return ls
}

// ParseListen parses `lsof -F pcn` output: p<pid>, c<cmd>, n<addr:port>.
func ParseListen(out []byte) []Listener {
	var res []Listener
	var pid int
	var cmd string
	havePID := false
	for _, l := range lines(out) {
		if l == "" {
			continue
		}
		switch l[0] {
		case 'p':
			n, err := strconv.Atoi(l[1:])
			if err != nil {
				havePID = false
				continue
			}
			pid, cmd, havePID = n, "", true
		case 'c':
			cmd = l[1:]
		case 'n':
			if !havePID {
				continue
			}
			name := l[1:]
			i := strings.LastIndex(name, ":")
			if i < 0 {
				continue
			}
			port, err := strconv.Atoi(name[i+1:])
			if err != nil {
				continue
			}
			res = append(res, Listener{PID: pid, Command: cmd, Addr: name[:i], Port: port})
		}
	}
	return res
}

// ParseCwd parses `lsof -F pn` output of cwd file descriptors into pid → cwd.
func ParseCwd(out []byte) map[int]string {
	res := map[int]string{}
	var pid int
	havePID := false
	for _, l := range lines(out) {
		if l == "" {
			continue
		}
		switch l[0] {
		case 'p':
			n, err := strconv.Atoi(l[1:])
			if err != nil {
				havePID = false
				continue
			}
			pid, havePID = n, true
		case 'n':
			if havePID {
				res[pid] = l[1:]
			}
		}
	}
	return res
}

// ParsePPID parses `ps -axo pid=,ppid=` output into pid → parent pid.
func ParsePPID(out []byte) map[int]int {
	res := map[int]int{}
	for _, l := range lines(out) {
		var pid, ppid int
		if _, err := fmt.Sscanf(strings.TrimSpace(l), "%d %d", &pid, &ppid); err != nil {
			continue
		}
		res[pid] = ppid
	}
	return res
}

// Canonical resolves path via Abs, EvalSymlinks and Clean, falling back to
// Clean(Abs) when symlinks cannot be resolved (for example, a missing path).
func Canonical(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	if r, err := filepath.EvalSymlinks(abs); err == nil {
		return filepath.Clean(r)
	}
	return filepath.Clean(abs)
}

// Owner returns the Path of the worktree whose Canon contains cwd, preferring
// the deepest match.
func Owner(cwd string, wts []Worktree) (string, bool) {
	best := -1
	for i, w := range wts {
		if w.Canon == "" {
			continue
		}
		if cwd != w.Canon && !strings.HasPrefix(cwd, strings.TrimSuffix(w.Canon, "/")+"/") {
			continue
		}
		if best < 0 || len(w.Canon) > len(wts[best].Canon) {
			best = i
		}
	}
	if best < 0 {
		return "", false
	}
	return wts[best].Path, true
}

// Attribute groups listeners by (worktree, port). owners maps listener PID to
// the owning worktree Path; listeners without an owner are dropped.
func Attribute(ls []Listener, owners map[int]string, wts []Worktree) Snapshot {
	snap := Snapshot{Enabled: true, Ports: map[string][]Port{}, Ranges: map[string]string{}}
	byPath := map[string]Worktree{}
	for _, w := range wts {
		byPath[w.Path] = w
		if w.HasRange {
			snap.Ranges[w.Path] = fmt.Sprintf("%d-%d", w.Start, w.End)
		}
	}
	type key struct {
		path string
		port int
	}
	groups := map[key]*Port{}
	addrs := map[key]map[string]bool{}
	for _, l := range ls {
		path, ok := owners[l.PID]
		if !ok {
			continue
		}
		k := key{path, l.Port}
		p := groups[k]
		if p == nil {
			w := byPath[path]
			p = &Port{
				Port: l.Port, PID: l.PID, Process: l.Command,
				InRange: !w.HasRange || (l.Port >= w.Start && l.Port <= w.End),
			}
			groups[k] = p
			addrs[k] = map[string]bool{}
		} else if l.PID < p.PID {
			p.PID, p.Process = l.PID, l.Command
		}
		addrs[k][l.Addr] = true
	}
	for k, p := range groups {
		for a := range addrs[k] {
			p.Addresses = append(p.Addresses, a)
		}
		sort.Strings(p.Addresses)
		snap.Ports[k.path] = append(snap.Ports[k.path], *p)
	}
	for _, ps := range snap.Ports {
		sort.Slice(ps, func(i, j int) bool { return ps[i].Port < ps[j].Port })
	}
	return snap
}
