package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// decodeEnvelope checks out is a schema_version 1 envelope and decodes its
// key into into.
func decodeEnvelope(t *testing.T, out, key string, into any) {
	t.Helper()
	var env map[string]json.RawMessage
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatalf("not a JSON object: %v\n%s", err, out)
	}
	if string(env["schema_version"]) != "1" {
		t.Fatalf("schema_version = %s, want 1\n%s", env["schema_version"], out)
	}
	raw, ok := env[key]
	if !ok {
		t.Fatalf("envelope has no %q key\n%s", key, out)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatalf("decode %q: %v\n%s", key, err, out)
	}
}

func TestPrintJSONEnvelope(t *testing.T) {
	var b bytes.Buffer
	if err := printJSON(&b, map[string]any{"x": 1, "schema_version": 99}); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(b.String(), "\n") {
		t.Fatalf("no trailing newline: %q", b.String())
	}
	var got map[string]any
	if err := json.Unmarshal(b.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["schema_version"] != float64(1) || got["x"] != float64(1) {
		t.Fatalf("got %v", got)
	}
}

func TestWriteJSONKeysAndMerges(t *testing.T) {
	var b bytes.Buffer
	if err := writeJSON(&b, "tasks", []int{1}); err != nil {
		t.Fatal(err)
	}
	var list []int
	decodeEnvelope(t, b.String(), "tasks", &list)
	if len(list) != 1 {
		t.Fatalf("list = %v", list)
	}
	b.Reset()
	if err := writeJSON(&b, "", map[string]any{"id": 4, "removed": true}); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	_ = json.Unmarshal(b.Bytes(), &got)
	if got["schema_version"] != float64(1) || got["id"] != float64(4) || got["removed"] != true {
		t.Fatalf("merged map = %v", got)
	}
}

func TestExecuteExitCodes(t *testing.T) {
	cases := []struct {
		err        error
		want       int
		wantStderr string
	}{
		{nil, 0, ""},
		{ErrNothingFound, 1, ""},
		{errors.New("boom"), 2, "boom\n"},
	}
	for _, c := range cases {
		var stderr bytes.Buffer
		if got := exitCode(c.err, &stderr); got != c.want || stderr.String() != c.wantStderr {
			t.Errorf("exitCode(%v) = %d, stderr %q; want %d, %q", c.err, got, stderr.String(), c.want, c.wantStderr)
		}
	}
}

// Execute runs rootCmd, so the codes are checked end to end through a
// throwaway subcommand too.
func TestExecuteThroughRootCmd(t *testing.T) {
	for _, c := range []struct {
		err  error
		want int
	}{{nil, 0}, {ErrNothingFound, 1}, {errors.New("boom"), 2}} {
		probe := &cobra.Command{Use: "exit-probe", SilenceUsage: true, SilenceErrors: true,
			RunE: func(*cobra.Command, []string) error { return c.err }}
		rootCmd.AddCommand(probe)
		rootCmd.SetArgs([]string{"exit-probe"})
		got := Execute()
		rootCmd.RemoveCommand(probe)
		rootCmd.SetArgs(nil)
		if got != c.want {
			t.Errorf("Execute with %v = %d, want %d", c.err, got, c.want)
		}
	}
}

func TestAsAgentIsRootFlag(t *testing.T) {
	t.Setenv("WORKTREE_DB", t.TempDir()+"/w.db")
	var out bytes.Buffer
	rootCmd.SetOut(&out)
	rootCmd.SetErr(&out)
	rootCmd.SetArgs([]string{"resources", "list", "--as-agent", "--json"})
	err := rootCmd.Execute()
	rootCmd.SetOut(nil)
	rootCmd.SetErr(nil)
	rootCmd.SetArgs(nil)
	asAgent = false
	if err != nil && strings.Contains(err.Error(), "unknown flag") {
		t.Fatalf("--as-agent not accepted on resources list: %v", err)
	}
}
