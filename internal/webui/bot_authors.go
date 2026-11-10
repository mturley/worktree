package webui

import (
	wconfig "github.com/mturley/watcher/config"
	watcherdb "github.com/mturley/watcher/db"
)

// markBotAuthors re-marks stored GitHub and Jira events whose author matches
// the watcher config's bot patterns (github.bot_usernames,
// jira.bot_usernames) as bots, so the feeds' bot mark, Humans only, unread
// and notifications treat past activity as they treat new. The pollers
// classify new events themselves. It only ever marks (see
// watcherdb.MarkBotAuthors): removing a pattern leaves what it marked.
//
// Run once as polling starts and after a Settings save changes either list.
// Errors are logged: the next run tries again.
func (s *Server) markBotAuthors() {
	if s.DB == nil {
		return // a Server built only for settings has no events to mark
	}
	cfg, err := wconfig.LoadConfig(s.watcherConfigPath())
	if err != nil {
		s.logger().Printf("bot authors: read watcher config: %v", err)
		return
	}
	for _, src := range []struct {
		source   string
		patterns []string
	}{{"github", cfg.GitHubBotUsernames()}, {"jira", cfg.JiraBotUsernames()}} {
		n, err := watcherdb.MarkBotAuthors(s.DB, src.source, src.patterns)
		if err != nil {
			s.logger().Printf("bot authors (%s): %v", src.source, err)
			continue
		}
		if n > 0 {
			s.logger().Printf("bot authors: marked %d %s events as bots", n, src.source)
		}
	}
}
