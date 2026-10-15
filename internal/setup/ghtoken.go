package setup

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// ghCLIToken returns the GitHub CLI's token when gh is installed and logged
// in, for setup to offer instead of having the user paste one. gh is
// optional: worktree never needs it otherwise. A package var for tests.
var ghCLIToken = func() (string, bool) {
	if _, err := exec.LookPath("gh"); err != nil {
		return "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "gh", "auth", "token").Output()
	if err != nil {
		return "", false // not logged in (or gh misbehaving): just don't offer
	}
	tok := strings.TrimSpace(string(out))
	return tok, tok != ""
}
