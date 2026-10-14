package setup

import (
	"testing"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/watcher/credsetup"
)

type slackFlowCalls struct{ tested, replaced, asked bool }

// stubSlackFlow swaps the three decision points of runSlackSetup.
func stubSlackFlow(t *testing.T, testChanged bool, testErr error, confirm bool, calls *slackFlowCalls) {
	t.Helper()
	origTest, origReplace, origConfirm := slackTestAndRepair, slackReplace, slackConfirmRecapture
	t.Cleanup(func() { slackTestAndRepair, slackReplace, slackConfirmRecapture = origTest, origReplace, origConfirm })
	slackTestAndRepair = func(*wconfig.Config, credsetup.Service, credsetup.Prompter) (bool, error) {
		calls.tested = true
		return testChanged, testErr
	}
	slackReplace = func(*wconfig.Config, credsetup.Service, credsetup.Prompter) (bool, error) {
		calls.replaced = true
		return true, nil
	}
	slackConfirmRecapture = func() bool { calls.asked = true; return confirm }
}

func TestSlackSetupForceSkipsTest(t *testing.T) {
	var c slackFlowCalls
	stubSlackFlow(t, false, nil, false, &c)
	changed, err := runSlackSetup(&wconfig.Config{}, true)
	if err != nil || !changed || c.tested || c.asked || !c.replaced {
		t.Fatalf("changed=%v err=%v calls=%+v", changed, err, c)
	}
}

func TestSlackSetupRepairedByTestDoesNotAsk(t *testing.T) {
	var c slackFlowCalls
	stubSlackFlow(t, true, nil, false, &c)
	changed, err := runSlackSetup(&wconfig.Config{}, false)
	if err != nil || !changed || c.asked || c.replaced {
		t.Fatalf("changed=%v err=%v calls=%+v", changed, err, c)
	}
}

func TestSlackSetupValidAsksAndHonoursNo(t *testing.T) {
	var c slackFlowCalls
	stubSlackFlow(t, false, nil, false, &c)
	cfg := &wconfig.Config{Services: wconfig.Services{Slack: &wconfig.SlackConfig{Token: "t", Cookie: "c"}}}
	changed, err := runSlackSetup(cfg, false)
	if err != nil || changed || !c.asked || c.replaced {
		t.Fatalf("changed=%v err=%v calls=%+v", changed, err, c)
	}
}

func TestSlackSetupValidAsksAndRecaptures(t *testing.T) {
	var c slackFlowCalls
	stubSlackFlow(t, false, nil, true, &c)
	cfg := &wconfig.Config{Services: wconfig.Services{Slack: &wconfig.SlackConfig{Token: "t", Cookie: "c"}}}
	changed, err := runSlackSetup(cfg, false)
	if err != nil || !changed || !c.replaced {
		t.Fatalf("changed=%v err=%v calls=%+v", changed, err, c)
	}
}

func TestSlackSetupUnconfiguredDeclinedDoesNotAsk(t *testing.T) {
	// TestAndRepair already asked "Configure Slack?" and the user said no;
	// asking "capture anyway?" on top would be a second prompt for one answer.
	var c slackFlowCalls
	stubSlackFlow(t, false, nil, true, &c)
	changed, err := runSlackSetup(&wconfig.Config{}, false)
	if err != nil || changed || c.asked || c.replaced {
		t.Fatalf("changed=%v err=%v calls=%+v", changed, err, c)
	}
}
