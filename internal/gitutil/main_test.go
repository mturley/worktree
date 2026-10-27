package gitutil

import (
	"testing"

	"github.com/mturley/worktree/internal/testgit"
)

func TestMain(m *testing.M) {
	defer testgit.RemoveTemplates()
	m.Run()
}
