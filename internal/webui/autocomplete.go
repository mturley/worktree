package webui

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

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

// autocompleteCacheOrInit lazily creates the Server's autocomplete cache.
// Server is constructed as a bare struct literal by every caller (cmd/ui.go
// and every test), so there is no constructor hook to initialise acCache
// eagerly.
func (s *Server) autocompleteCacheOrInit() *autocompleteCache {
	s.acCacheOnce.Do(func() { s.acCache = newAutocompleteCache(60 * time.Second) })
	return s.acCache
}

// handleSlackAutocomplete implements GET /api/slack-autocomplete, the single
// endpoint behind all three composer triggers.
//
// Every result carries a ready-to-insert mrkdwn Token, so the frontend never
// constructs mention syntax from ids.
func (s *Server) handleSlackAutocomplete(w http.ResponseWriter, r *http.Request) {
	if s.SlackClient == nil {
		s.slackUnavailable(w)
		return
	}
	trigger := r.URL.Query().Get("trigger")
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	channel := r.URL.Query().Get("channel")

	var (
		items []AutocompleteItem
		err   error
	)
	switch trigger {
	case "@":
		items, err = s.mentionCandidates(r.Context(), q, channel)
	case "#":
		items, err = s.channelCandidates(r.Context(), q)
	case ":":
		items, err = s.emojiCandidates(r.Context(), q)
	default:
		writeError(w, http.StatusBadRequest, "trigger must be one of @ : #")
		return
	}
	if errors.Is(err, slack.ErrAuth) {
		http.Error(w, "auth", http.StatusUnauthorized)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Results []AutocompleteItem `json:"results"`
	}{items})
}

// mentionCandidates queries users and groups CONCURRENTLY (Slack's own client
// fires both on the same keystroke) and appends the locally-injected specials.
// Ranking: users, then groups, then specials.
func (s *Server) mentionCandidates(ctx context.Context, q, channel string) ([]AutocompleteItem, error) {
	out := []AutocompleteItem{}
	if q == "" {
		// A bare "@" must not cost a Slack call — see the request budget in
		// the plan's Global Constraints.
		return append(out, specialItems(q)...), nil
	}

	remote, err := s.autocompleteCacheOrInit().Do("@|"+q+"|"+channel, func() ([]AutocompleteItem, error) {
		var (
			wg        sync.WaitGroup
			users     []slack.User
			groups    []slack.UserGroup
			usersErr  error
			groupsErr error
		)
		wg.Add(2)
		go func() {
			defer wg.Done()
			users, usersErr = s.SlackClient.SearchUsers(ctx, q, channel, 25)
		}()
		go func() {
			defer wg.Done()
			groups, groupsErr = s.SlackClient.SearchUserGroups(ctx, q, 25)
		}()
		wg.Wait()

		if usersErr != nil {
			return nil, usersErr
		}
		// A group-directory failure must not cost the user their people
		// results; groups are the smaller half of the menu.
		if groupsErr != nil && s.Logger != nil {
			s.Logger.Printf("autocomplete: usergroup search failed: %v", groupsErr)
		}

		items := make([]AutocompleteItem, 0, len(users)+len(groups))
		for _, u := range users {
			items = append(items, AutocompleteItem{
				Kind:   "user",
				ID:     u.ID,
				Label:  userLabel(u),
				Detail: u.Name,
				Avatar: u.Avatar72,
				Token:  userToken(u.ID),
			})
		}
		for _, g := range groups {
			label := g.Handle
			if label == "" {
				label = g.Name
			}
			items = append(items, AutocompleteItem{
				Kind:   "group",
				ID:     g.ID,
				Label:  "@" + label,
				Detail: g.Name,
				Token:  groupToken(g.ID),
			})
		}
		return items, nil
	})
	if err != nil {
		return nil, err
	}
	out = append(out, remote...)
	return append(out, specialItems(q)...), nil
}

func (s *Server) channelCandidates(ctx context.Context, q string) ([]AutocompleteItem, error) {
	if q == "" {
		return []AutocompleteItem{}, nil
	}
	return s.autocompleteCacheOrInit().Do("#|"+q, func() ([]AutocompleteItem, error) {
		chans, err := s.SlackClient.SearchChannels(ctx, q, 25)
		if err != nil {
			return nil, err
		}
		items := make([]AutocompleteItem, 0, len(chans))
		for _, ch := range chans {
			detail := ""
			if ch.IsPrivate {
				detail = "private channel"
			}
			items = append(items, AutocompleteItem{
				Kind:   "channel",
				ID:     ch.ID,
				Label:  "#" + ch.Name,
				Detail: detail,
				Token:  channelToken(ch.ID, ch.Name),
			})
		}
		return items, nil
	})
}

// emojiCandidates answers from the custom-emoji map the server already caches
// (slack.go's emoji()), making NO Slack call. The Unicode half is matched
// client-side from node-emoji and merged into the same menu.
func (s *Server) emojiCandidates(ctx context.Context, q string) ([]AutocompleteItem, error) {
	if q == "" {
		return []AutocompleteItem{}, nil
	}
	all, err := s.emoji(ctx)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, 25)
	for name := range all {
		if strings.Contains(name, strings.ToLower(q)) {
			names = append(names, name)
		}
	}
	// Map iteration is random; sort so the same query always yields the same
	// menu, with shorter (closer) matches first.
	sort.Slice(names, func(i, j int) bool {
		if len(names[i]) != len(names[j]) {
			return len(names[i]) < len(names[j])
		}
		return names[i] < names[j]
	})
	if len(names) > 25 {
		names = names[:25]
	}
	items := make([]AutocompleteItem, 0, len(names))
	for _, name := range names {
		items = append(items, AutocompleteItem{
			Kind:     "emoji",
			ID:       name,
			Label:    ":" + name + ":",
			ImageURL: all[name],
			Token:    emojiToken(name),
		})
	}
	return items, nil
}
