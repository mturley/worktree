package cmd

import (
	"context"
	"strings"
	"testing"

	wgithub "github.com/mturley/watcher/github"

	"github.com/mturley/worktree/internal/linked"
	"github.com/mturley/worktree/internal/setup"
	"github.com/mturley/worktree/internal/webui"
)

type fakePR struct{}

func (fakePR) Summaries(_ context.Context, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
	out := map[wgithub.PRRef]wgithub.PRSummary{}
	for _, r := range refs {
		out[r] = wgithub.PRSummary{Title: "A PR", State: "OPEN"}
	}
	return out, nil
}

func TestLinkedRefusedWhenJiraOff(t *testing.T) {
	isolateLive(t, "watchers:\n  jira: false\n", "")
	seedReadFixture(t)
	touched := false
	stubServer(t, func(s *webui.Server) {
		s.LinkedSources = func() linked.Sources { touched = true; return linked.Sources{} }
	})
	_, err := runCLI(t, "linked", "jira:PROJ-1")
	if err == nil || !strings.Contains(err.Error(), setup.WatcherOffMessage("jira")) {
		t.Fatalf("err = %v", err)
	}
	if exitCode(err, &strings.Builder{}) != 2 {
		t.Fatal("want exit 2")
	}
	if touched {
		t.Fatal("sources were built while Jira is off")
	}
}

func TestLinkedRefusedWhenSlackOffNeverReadsCredentials(t *testing.T) {
	isolateLive(t, "watchers:\n  slack: false\n", "")
	seedReadFixture(t)
	stubServer(t, func(*webui.Server) {})
	_, err := runCLI(t, "linked", "slack:C1:1700000000.000100")
	if err == nil || !strings.Contains(err.Error(), setup.WatcherOffMessage("slack")) {
		t.Fatalf("err = %v", err)
	}
}

func TestLinkedUnsupportedType(t *testing.T) {
	isolateLive(t, "", "")
	seedReadFixture(t)
	stubServer(t, func(*webui.Server) {})
	_, err := runCLI(t, "linked", "link:https://example.com/x")
	if err == nil || err.Error() != linked.ErrUnsupportedType.Error() || exitCode(err, &strings.Builder{}) != 2 {
		t.Fatalf("err = %v", err)
	}
}

func TestLinkedJSON(t *testing.T) {
	isolateLive(t, "", "")
	seedReadFixture(t)
	stubServer(t, func(s *webui.Server) {
		s.LinkedSources = func() linked.Sources { return linked.Sources{PR: fakePR{}} }
	})
	out, err := runCLI(t, "linked", "https://github.com/o/r/pull/1", "--json")
	if err != nil {
		t.Fatalf("err = %v\n%s", err, out)
	}
	var res map[string]any
	decodeEnvelope(t, out, "linked", &res)
	if _, ok := res["sections"]; !ok {
		t.Fatalf("linked = %v", res)
	}
	out, err = runCLI(t, "linked", "pr:o/r#1")
	if err != nil || !strings.Contains(out, "No linked resources.") {
		t.Fatalf("text = %q, err = %v", out, err)
	}
}
