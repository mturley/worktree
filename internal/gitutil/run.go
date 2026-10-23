package gitutil

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// git runs `git -C dir args...` and returns trimmed stdout. On failure the
// error carries stderr, which is where git explains itself.
func git(dir string, args ...string) (string, error) {
	return gitEnv(dir, nil, args...)
}

// gitEnv is git with extra environment entries (KEY=value) appended to the
// process environment, e.g. GIT_INDEX_FILE to work against a scratch index.
func gitEnv(dir string, env []string, args ...string) (string, error) {
	out, err := gitRaw(dir, env, args...)
	return strings.TrimSpace(out), err
}

// gitRaw is gitEnv without trimming stdout, for NUL-delimited output whose
// leading spaces are significant (e.g. `status --porcelain -z`).
func gitRaw(dir string, env []string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}
