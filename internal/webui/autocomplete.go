package webui

import (
	"strings"

	"github.com/mturley/watcher/slack"
)

// AutocompleteItem is one candidate returned by GET /api/slack-autocomplete.
//
// Token is the load-bearing field: it is the EXACT mrkdwn the composer should
// insert. Mention encoding therefore lives in one Go place with table tests,
// and the pill the user sees cannot disagree with the text that gets posted.
type AutocompleteItem struct {
	// Kind is one of "user", "group", "special", "channel", "emoji".
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	Label    string `json:"label"`
	Detail   string `json:"detail,omitempty"`
	Avatar   string `json:"avatar,omitempty"`
	ImageURL string `json:"imageUrl,omitempty"`
	Token    string `json:"token"`
}

func userToken(id string) string      { return "<@" + id + ">" }
func groupToken(id string) string     { return "<!subteam^" + id + ">" }
func specialToken(name string) string { return "<!" + name + ">" }
func emojiToken(name string) string   { return ":" + name + ":" }

func channelToken(id, name string) string { return "<#" + id + "|" + name + ">" }

// userLabel picks what Slack itself shows, in Slack's own precedence order.
// It never returns "" — a row with no label is a row the user cannot identify.
func userLabel(u slack.User) string {
	switch {
	case u.DisplayName != "":
		return u.DisplayName
	case u.RealName != "":
		return u.RealName
	case u.Name != "":
		return u.Name
	default:
		return u.ID
	}
}

// specials are injected locally, exactly as Slack's own client does — no
// endpoint returns them.
var specials = []struct{ id, detail string }{
	{"here", "Notify everyone online in this channel"},
	{"channel", "Notify everyone in this channel"},
	{"everyone", "Notify everyone in the workspace"},
}

func specialItems(query string) []AutocompleteItem {
	q := strings.ToLower(query)
	out := []AutocompleteItem{}
	for _, s := range specials {
		if q != "" && !strings.Contains(s.id, q) {
			continue
		}
		out = append(out, AutocompleteItem{
			Kind:   "special",
			ID:     s.id,
			Label:  "@" + s.id,
			Detail: s.detail,
			Token:  specialToken(s.id),
		})
	}
	return out
}
