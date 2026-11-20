package webui

import "testing"

func TestSlackEventTitle(t *testing.T) {
	t.Parallel()
	const raw = "Message in hey <@U1> can you look"
	cases := []struct {
		name, source, typ, title string
		d                        *resourceDTO
		want                     string
	}{
		{"custom name wins", "slack", "slack_reply", raw,
			&resourceDTO{CustomName: "Rollout", Title: "hey @ana can you look"}, "Message in Rollout"},
		{"falls back to the resolved cached title", "slack", "slack_reply", raw,
			&resourceDTO{Title: "hey @ana can you look"}, "Message in hey @ana can you look"},
		{"thread root", "slack", "slack_thread_root", "Thread started: hey <@U1>",
			&resourceDTO{CustomName: "Rollout"}, "Thread started: Rollout"},
		{"watch started", "slack", "watch_started", "Started watching thread: hey <@U1>",
			&resourceDTO{CustomName: "Rollout"}, "Started watching thread: Rollout"},
		{"no name keeps the stored title", "slack", "slack_reply", raw, &resourceDTO{}, raw},
		{"no resource keeps the stored title", "slack", "slack_reply", raw, nil, raw},
		{"other slack types untouched", "slack", "watcher_error", "boom",
			&resourceDTO{CustomName: "Rollout"}, "boom"},
		{"other sources untouched", "github", "pr_comment", "Comment on PR",
			&resourceDTO{CustomName: "Mine"}, "Comment on PR"},
	}
	for _, c := range cases {
		if got := slackEventTitle(c.source, c.typ, c.title, c.d); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
