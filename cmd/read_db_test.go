package cmd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/notes"
	"github.com/mturley/worktree/internal/tasks"
)

// procResult is one command's outcome in its own process.
type procResult struct {
	stdout, stderr string
	code           int
}

// runCLIProcess runs the test binary as the worktree binary (see TestMain), in
// dir, with WORKTREE_DB selecting the test's DB and a sandboxed home. It gives
// a real exit code and real stderr, which only Execute produces.
func runCLIProcess(t *testing.T, dir string, env []string, args ...string) procResult {
	t.Helper()
	cmd := exec.Command(os.Args[0], args...)
	cmd.Dir = dir
	home := t.TempDir()
	cmd.Env = append(os.Environ(),
		cliChildEnv+"=1",
		"HOME="+home,
		"XDG_CONFIG_HOME=", "XDG_DATA_HOME=", "CMUX_SOCKET_PATH=",
		"WORKTREE_DB="+os.Getenv("WORKTREE_DB"),
	)
	cmd.Env = append(cmd.Env, env...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	res := procResult{stdout: stdout.String(), stderr: stderr.String()}
	var exit *exec.ExitError
	switch {
	case errors.As(err, &exit):
		res.code = exit.ExitCode()
	case err != nil:
		t.Fatalf("running %v: %v", args, err)
	}
	return res
}

// readCommand is one read command. wantCode is what it exits with against the
// seeded fixture; the live commands exit 2 because the sandbox has no
// credentials, which still takes them through their DB reads first.
type readCommand struct {
	args     []string
	wantCode int
}

func readCommands(live string) []readCommand {
	return []readCommand{
		{[]string{"list"}, 0},
		{[]string{"list", "--json"}, 0},
		{[]string{"info", live}, 0},
		{[]string{"info", live, "--json"}, 0},
		{[]string{"ports"}, 0},
		{[]string{"ports", "--json"}, 0},
		{[]string{"ports", "--listening", "--json"}, 0},
		{[]string{"jira", live}, 0},
		{[]string{"jira", live, "--json"}, 0},
		{[]string{"status"}, 0},
		{[]string{"status", "--json"}, 0},
		{[]string{"attention"}, 0},
		{[]string{"attention", "--json"}, 0},
		{[]string{"activity", "--json"}, 0},
		{[]string{"activity", "--unread", "--json"}, 0},
		{[]string{"unread"}, 0},
		{[]string{"unread", "--json"}, 0},
		{[]string{"unread", "--json", "--by", "worktree"}, 0},
		{[]string{"unread", "--json", "--by", "resource"}, 0},
		{[]string{"resources", "list"}, 0},
		{[]string{"resources", "list", "--json"}, 0},
		{[]string{"resources", "list", "--all", "--json"}, 0},
		{[]string{"tasks", "list", "--json"}, 0},
		{[]string{"tasks", "list", "--all", "--json"}, 0},
		{[]string{"tasks", "list", "--resource", ".", "--json"}, 0},
		{[]string{"tasks", "show", "T1", "--json"}, 0},
		{[]string{"notes", "show", "--json"}, 0},
		{[]string{"review-comments", "list", "--json"}, 0},
		{[]string{"pr-threads", "list", "--json"}, 2},
		{[]string{"linked", "jira:X-1", "--json"}, 2},
	}
}

// seedReadCommandsFixture adds a task and notes to the unread fixture, so each
// read command has rows to read and every lazy write has something to trigger on.
func seedReadCommandsFixture(t *testing.T) (live, dbPath string) {
	t.Helper()
	live = seedUnreadPRAndSlack(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := tasks.Create(conn, tasks.Actor{Kind: tasks.ActorUser}, tasks.NewTask{Title: "a task"}); err != nil {
		t.Fatal(err)
	}
	if _, err := notes.Set(conn, live, "a note", false, true); err != nil {
		t.Fatal(err)
	}
	dbPath, err = wdb.Path()
	if err != nil {
		t.Fatal(err)
	}
	return live, dbPath
}

func fileHash(t *testing.T, path string) [sha256.Size]byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(b)
}

// Not parallel: t.Setenv through the fixture.
func TestReadCommandsAgainstReadOnlyDB(t *testing.T) {
	live, dbPath := seedReadCommandsFixture(t)
	if err := os.Chmod(dbPath, 0o444); err != nil {
		t.Fatal(err)
	}
	before := fileHash(t, dbPath)
	for _, c := range readCommands(live) {
		t.Run(strings.Join(c.args, " "), func(t *testing.T) {
			r := runCLIProcess(t, live, nil, c.args...)
			if r.code != c.wantCode {
				t.Errorf("exit %d, want %d\nstdout: %s\nstderr: %s", r.code, c.wantCode, r.stdout, r.stderr)
			}
			if strings.Contains(r.stderr, "readonly") {
				t.Errorf("command tried to write: %s", r.stderr)
			}
		})
	}
	if fileHash(t, dbPath) != before {
		t.Error("a read command changed the DB file")
	}
}

// Not parallel: t.Setenv through the fixture.
func TestReadCommandsWhileWriteLockHeld(t *testing.T) {
	live, _ := seedReadCommandsFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx := context.Background()
	held, err := conn.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	if _, err := held.ExecContext(ctx, `BEGIN IMMEDIATE`); err != nil {
		t.Fatal(err)
	}
	defer held.ExecContext(ctx, `ROLLBACK`)

	for _, c := range readCommands(live) {
		t.Run(strings.Join(c.args, " "), func(t *testing.T) {
			r := runCLIProcess(t, live, nil, c.args...)
			if r.code != c.wantCode {
				t.Errorf("exit %d, want %d\nstdout: %s\nstderr: %s", r.code, c.wantCode, r.stdout, r.stderr)
			}
			if strings.Contains(r.stderr, "locked") {
				t.Errorf("command waited on the write lock: %s", r.stderr)
			}
		})
	}
}

// Not parallel: t.Setenv through the fixture.
func TestReadCommandsMissingDBCreateNothing(t *testing.T) {
	live, _ := seedReadCommandsFixture(t)
	dir := filepath.Join(t.TempDir(), "absent")
	dbPath := filepath.Join(dir, "w.db")
	t.Setenv("WORKTREE_DB", dbPath)
	for _, c := range readCommands(live) {
		t.Run(strings.Join(c.args, " "), func(t *testing.T) {
			r := runCLIProcess(t, live, nil, c.args...)
			if r.code != 2 {
				t.Errorf("exit %d, want 2\nstderr: %s", r.code, r.stderr)
			}
			if !strings.Contains(r.stderr, wdb.ErrNoDatabase.Error()) {
				t.Errorf("stderr = %q, want %q", r.stderr, wdb.ErrNoDatabase)
			}
			if _, err := os.Stat(dir); !os.IsNotExist(err) {
				t.Fatalf("%v created the DB directory", c.args)
			}
		})
	}
}

// Not parallel: t.Setenv through the fixture.
func TestReadCommandsBehindSchemaDoNotMigrate(t *testing.T) {
	live, dbPath := seedReadCommandsFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`PRAGMA user_version = 0`); err != nil {
		t.Fatal(err)
	}
	conn.Close()
	before := fileHash(t, dbPath)
	for _, c := range readCommands(live) {
		t.Run(strings.Join(c.args, " "), func(t *testing.T) {
			r := runCLIProcess(t, live, nil, c.args...)
			if r.code != 2 {
				t.Errorf("exit %d, want 2\nstderr: %s", r.code, r.stderr)
			}
			if !strings.Contains(r.stderr, wdb.ErrSchemaBehind.Error()) {
				t.Errorf("stderr = %q, want %q", r.stderr, wdb.ErrSchemaBehind)
			}
		})
	}
	if fileHash(t, dbPath) != before {
		t.Error("a read command migrated the DB")
	}
}

// Not parallel: t.Setenv. The missing-DB error sends the user to setup, so
// setup has to be able to create it.
func TestEnsureDatabaseCreatesAReadableDB(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "sub", "w.db"))
	ensureDatabase()
	conn, err := wdb.OpenRead()
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
}

// Not parallel: t.Setenv.
func TestEnsureDatabaseUpgradesABehindDB(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`PRAGMA user_version = 0`); err != nil {
		t.Fatal(err)
	}
	conn.Close()
	ensureDatabase()
	conn, err = wdb.OpenRead()
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
}
