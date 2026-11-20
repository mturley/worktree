package webui

import "testing"

func TestSlackEventTitle(t *testing.T) {
	t.Parallel()
	const raw = "Message from Bob in hey <@U1> can you look"
	rollout := &resourceDTO{CustomName: "Rollout", Title: "hey @ana can you look"}
	cases := []struct {
		name, source, typ, title, author, authorID string
		d                                          *resourceDTO
		want                                       string
	}{
		{"custom name wins", "slack", "slack_reply", raw, "Bob", "U2", rollout, "Message from Bob in Rollout"},
		{"falls back to the resolved cached title", "slack", "slack_reply", raw, "Bob", "U2",
			&resourceDTO{Title: "hey @ana can you look"}, "Message from Bob in hey @ana can you look"},
		{"an unresolved author is never named", "slack", "slack_reply", "Message in x", "U2", "U2", rollout, "Message in Rollout"},
		{"no author", "slack", "slack_reply", "Message in x", "", "", rollout, "Message in Rollout"},
		{"a userless (bot) author is named", "slack", "slack_reply", "Message from Deploybot in x", "Deploybot", "", rollout,
			"Message from Deploybot in Rollout"},
		{"thread root", "slack", "slack_thread_root", "Thread started by Alice: hey <@U1>", "Alice", "U1", rollout,
			"Thread started by Alice: Rollout"},
		{"thread root, unresolved author", "slack", "slack_thread_root", "Thread started: hey", "U1", "U1", rollout,
			"Thread started: Rollout"},
		{"watch started", "slack", "watch_started", "Started watching thread: hey <@U1>", "", "", rollout,
			"Started watching thread: Rollout"},
		{"no name keeps the stored title", "slack", "slack_reply", raw, "Bob", "U2", &resourceDTO{}, raw},
		{"no resource keeps the stored title", "slack", "slack_reply", raw, "Bob", "U2", nil, raw},
		{"other slack types untouched", "slack", "watcher_error", "boom", "", "", rollout, "boom"},
		{"other sources untouched", "github", "pr_comment", "Comment on PR", "octocat", "1",
			&resourceDTO{CustomName: "Mine"}, "Comment on PR"},
	}
	for _, c := range cases {
		if got := slackEventTitle(c.source, c.typ, c.title, c.author, c.authorID, c.d); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
