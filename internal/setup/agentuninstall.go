package setup

import (
	"fmt"

	"github.com/mturley/worktree/internal/ui"
)

// agentUninstall names everything uninstall touches for agents: the skills.
type agentUninstall struct {
	Skill skillDeps
}

func defaultAgentUninstall() agentUninstall {
	return agentUninstall{Skill: defaultSkillDeps()}
}

func previewAgentUninstall(u agentUninstall) {
	planSkillsUninstall(u.Skill).Preview()
}

// runAgentUninstall removes the skills. A failure is a warning.
func runAgentUninstall(u agentUninstall) {
	if err := applySkills(u.Skill, planSkillsUninstall(u.Skill)); err != nil {
		fmt.Printf("  %s Removing worktree's skills: %v\n", ui.Yellow("!"), err)
	}
}
