package cmd

import (
	"os"
	"testing"

	"github.com/mturley/worktree/internal/testgit"
)

// cliChildEnv makes the test binary act as the worktree binary, so a test can
// run a command in a process of its own (see runCLIProcess).
const cliChildEnv = "WORKTREE_TEST_RUN_CLI"

func TestMain(m *testing.M) {
	if os.Getenv(cliChildEnv) == "1" {
		os.Exit(Execute())
	}
	// Never read the user's real config.yaml or watcher-auth.yaml: a test's
	// result must not depend on how this machine is configured (e.g. a
	// watcher toggled off). Tests that need a config set XDG_CONFIG_HOME
	// themselves; the CLI child processes inherit this one.
	cfgHome, err := os.MkdirTemp("", "worktree-cmd-test-config-")
	if err != nil {
		panic(err)
	}
	os.Setenv("XDG_CONFIG_HOME", cfgHome)
	code := m.Run()
	testgit.RemoveTemplates()
	os.RemoveAll(cfgHome)
	os.Exit(code)
}
