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
	code := m.Run()
	testgit.RemoveTemplates()
	os.Exit(code)
}
