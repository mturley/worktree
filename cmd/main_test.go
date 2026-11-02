package cmd

import (
	"os"
	"testing"

	"github.com/mturley/worktree/internal/testgit"
)

func TestMain(m *testing.M) {
	code := m.Run()
	testgit.RemoveTemplates()
	os.Exit(code)
}
