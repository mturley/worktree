package listeners

import (
	"context"
	"errors"
	"os/exec"
	"sort"
	"strconv"
	"strings"
)

// Runner runs a command and returns its stdout.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

// ExecRunner is the production Runner.
func ExecRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).Output()
}

// lsofRun runs lsof, treating exit status 1 (nothing found, or some PIDs
// gone) as success: the output is whatever lsof did find.
func lsofRun(ctx context.Context, run Runner, args ...string) ([]byte, error) {
	out, err := run(ctx, "lsof", args...)
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 1 {
			return out, nil
		}
		return nil, err
	}
	return out, nil
}

func cwds(ctx context.Context, run Runner, pids []int) (map[int]string, error) {
	strs := make([]string, len(pids))
	for i, p := range pids {
		strs[i] = strconv.Itoa(p)
	}
	out, err := lsofRun(ctx, run, "-a", "-p", strings.Join(strs, ","), "-d", "cwd", "-F", "pn")
	if err != nil {
		return nil, err
	}
	return ParseCwd(out), nil
}

// Scan lists TCP listeners and attributes them to worktrees: by the
// listener's own cwd, else by the nearest ancestor whose cwd is in one.
// It spawns at most four processes regardless of listener count.
func Scan(ctx context.Context, run Runner, wts []Worktree) (Snapshot, error) {
	out, err := lsofRun(ctx, run, "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn")
	if err != nil {
		return Snapshot{}, err
	}
	ls := ParseListen(out)
	if len(ls) == 0 {
		return Attribute(nil, nil, wts), nil
	}
	seen := map[int]bool{}
	var pids []int
	for _, l := range ls {
		if !seen[l.PID] {
			seen[l.PID] = true
			pids = append(pids, l.PID)
		}
	}
	sort.Ints(pids)
	cwd, err := cwds(ctx, run, pids)
	if err != nil {
		return Snapshot{}, err
	}
	owners := map[int]string{}
	var rest []int
	for _, p := range pids {
		if o, ok := Owner(cwd[p], wts); ok && cwd[p] != "" {
			owners[p] = o
		} else {
			rest = append(rest, p)
		}
	}
	if len(rest) > 0 {
		psOut, err := run(ctx, "ps", "-axo", "pid=,ppid=")
		if err != nil {
			return Snapshot{}, err
		}
		ppid := ParsePPID(psOut)
		chains := map[int][]int{}
		need := map[int]bool{}
		for _, p := range rest {
			visited := map[int]bool{p: true}
			cur := p
			for {
				par, ok := ppid[cur]
				if !ok || par <= 1 || visited[par] {
					break
				}
				visited[par] = true
				chains[p] = append(chains[p], par)
				if _, known := cwd[par]; !known {
					need[par] = true
				}
				cur = par
			}
		}
		if len(need) > 0 {
			var anc []int
			for a := range need {
				anc = append(anc, a)
			}
			sort.Ints(anc)
			m, err := cwds(ctx, run, anc)
			if err != nil {
				return Snapshot{}, err
			}
			for k, v := range m {
				cwd[k] = v
			}
		}
		for _, p := range rest {
			for _, a := range chains[p] {
				if c := cwd[a]; c != "" {
					if o, ok := Owner(c, wts); ok {
						owners[p] = o
						break
					}
				}
			}
		}
	}
	return Attribute(ls, owners, wts), nil
}
