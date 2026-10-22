package tasks

import (
	"slices"
	"strings"
)

// unreadActors is THE unread actor rule: the actor kinds whose task events
// count as unread and notify, i.e. every actor but the user. The user's own
// events never do. Every reader of the rule goes through CountsAsUnread (Go)
// or UnreadActorSQL (SQL): internal/unread's counts, the feeds' unread flag
// and unread_only filter, and the notifier.
var unreadActors = []string{ActorAgent, ActorSystem}

// UnreadActors returns a copy of the actor kinds whose events count as unread.
func UnreadActors() []string { return slices.Clone(unreadActors) }

// CountsAsUnread reports whether an event by actor can be unread (and
// notify). Whether it IS unread also depends on its task's read cursor.
func CountsAsUnread(actor string) bool { return slices.Contains(unreadActors, actor) }

// UnreadActorSQL is CountsAsUnread as a SQL condition over the actor column
// col (e.g. "e.actor"), with its args: "col IN (?,…)". col is interpolated,
// so pass only a fixed column name, never input.
func UnreadActorSQL(col string) (string, []any) {
	args := make([]any, len(unreadActors))
	for i, a := range unreadActors {
		args[i] = a
	}
	return col + " IN (" + strings.TrimSuffix(strings.Repeat("?,", len(unreadActors)), ",") + ")", args
}
