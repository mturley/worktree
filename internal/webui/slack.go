package webui

import (
	"context"
	"errors"
	"net/http"
	"regexp"

	"github.com/mturley/watcher/slack"
)

// ThreadResponse is the enriched, normalized JSON shape returned by
// GET /api/thread.
type ThreadResponse struct {
	Channel       string                `json:"channel"`
	ChannelName   string                `json:"channelName"`
	ThreadTS      string                `json:"threadTs"`
	LastRead      string                `json:"lastRead"`
	LatestReply   string                `json:"latestReply"`
	RootTS        string                `json:"rootTs"`
	UnreadIndex   int                   `json:"unreadIndex"`
	CurrentUserID string                `json:"currentUserId"`
	Messages      []MessageView         `json:"messages"`
	Users         map[string]slack.User `json:"users"`
	Emoji         map[string]string     `json:"emoji"`
	// Groups is the workspace's user groups keyed by subteam id, so the
	// frontend can render "<!subteam^S123>" as the group's name instead of a
	// placeholder. Unlike Users this is not filtered to the ids referenced by
	// the thread — the directory is small and fetched once, and filtering it
	// per thread would cost a lookup pass for no meaningful payload saving.
	Groups map[string]slack.UserGroup `json:"groups"`
}

// MessageView wraps slack.Message; extended later with view-specific
// fields.
type MessageView struct {
	slack.Message
}

// slackUnavailable writes the standard 503 response used when the Slack
// integration is not configured (no credentials in the shared watcher
// auth.yaml). Every Slack-backed handler guards on s.SlackClient == nil and
// returns this rather than nil-panicking.
func (s *Server) slackUnavailable(w http.ResponseWriter) {
	writeError(w, http.StatusServiceUnavailable, "slack not configured; run worktree setup")
}

func (s *Server) handleThread(w http.ResponseWriter, r *http.Request) {
	if s.SlackClient == nil {
		s.slackUnavailable(w)
		return
	}
	ch := r.URL.Query().Get("channel")
	ts := r.URL.Query().Get("thread_ts")
	if ch == "" || ts == "" {
		http.Error(w, "channel and thread_ts required", http.StatusBadRequest)
		return
	}

	th, err := s.SlackClient.Replies(r.Context(), ch, ts)
	if errors.Is(err, slack.ErrAuth) {
		http.Error(w, "auth", http.StatusUnauthorized)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	resp, err := s.buildThreadResponse(r.Context(), ch, ts, th)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// buildThreadResponse enriches a raw slack.Thread into the ThreadResponse
// shape shared by GET /api/thread and the SSE /api/thread-events stream, so
// both stay consistent: it resolves referenced user IDs and filters the
// workspace emoji map down to only the names actually referenced by th. ch
// and ts are the (channel, threadTS) the caller requested, echoed back on
// the response.
func (s *Server) buildThreadResponse(ctx context.Context, ch, ts string, th slack.Thread) (ThreadResponse, error) {
	ids := collectUserIDs(th)
	names := collectEmojiNames(th)

	users, err := s.SlackClient.Users(ctx, ids)
	if err != nil {
		return ThreadResponse{}, err
	}

	// A failed group lookup must not fail the whole thread render: groups are
	// a nicety (nicer mention labels), whereas the thread is the point. Degrade
	// to an empty directory and let mentions fall back to their ids.
	groups, groupsErr := s.userGroupsFor(ctx, collectUserGroupIDs(th))
	if groupsErr != nil {
		if s.Logger != nil {
			s.Logger.Printf("slack usergroups: %v", groupsErr)
		}
		groups = map[string]slack.UserGroup{}
	}

	allEmoji, err := s.emoji(ctx)
	if err != nil {
		return ThreadResponse{}, err
	}
	emoji := map[string]string{}
	for _, n := range names {
		if u, ok := allEmoji[n]; ok {
			emoji[n] = u
		}
	}

	// channelName and currentUserID are best-effort enrichments: a lookup
	// failure shouldn't fail the whole thread response, so fall back to "".
	// Log failures so a persistent problem (e.g. a permissions error) is
	// visible rather than silently dropping the enrichment.
	channelName, err := s.channelName(ctx, ch)
	if err != nil && s.Logger != nil {
		s.Logger.Printf("thread enrichment: resolving channel name for %s: %v", ch, err)
	}
	currentUserID, err := s.whoAmI(ctx)
	if err != nil && s.Logger != nil {
		s.Logger.Printf("thread enrichment: resolving current user: %v", err)
	}

	rootTS := ts
	latestReply := th.LatestReply
	if len(th.Messages) > 0 {
		rootTS = th.Messages[0].TS
		if latestReply == "" {
			latestReply = th.Messages[len(th.Messages)-1].TS
		}
	}

	resp := ThreadResponse{
		Channel:       ch,
		ChannelName:   channelName,
		ThreadTS:      ts,
		LastRead:      th.LastRead,
		LatestReply:   latestReply,
		RootTS:        rootTS,
		UnreadIndex:   slack.UnreadDividerIndex(th),
		CurrentUserID: currentUserID,
		Users:         users,
		Emoji:         emoji,
		Groups:        groups,
	}
	for _, m := range th.Messages {
		resp.Messages = append(resp.Messages, MessageView{m})
	}
	return resp, nil
}

// emoji returns the workspace emoji map, fetching it once via
// SlackClient.Emoji and caching the result on the Server for subsequent
// requests.
func (s *Server) emoji(ctx context.Context) (map[string]string, error) {
	s.emojiMu.Lock()
	defer s.emojiMu.Unlock()
	if s.emojiCache != nil {
		return s.emojiCache, nil
	}
	e, err := s.SlackClient.Emoji(ctx)
	if err != nil {
		return nil, err
	}
	s.emojiCache = e
	return e, nil
}

// channelName returns the display name for channel id, fetching it once via
// SlackClient.Channel and caching the result on the Server for subsequent
// requests.
func (s *Server) channelName(ctx context.Context, id string) (string, error) {
	s.channelMu.Lock()
	if name, ok := s.channelCache[id]; ok {
		s.channelMu.Unlock()
		return name, nil
	}
	s.channelMu.Unlock()

	name, err := s.SlackClient.Channel(ctx, id)
	if err != nil {
		return "", err
	}

	s.channelMu.Lock()
	if s.channelCache == nil {
		s.channelCache = map[string]string{}
	}
	s.channelCache[id] = name
	s.channelMu.Unlock()
	return name, nil
}

// whoAmI returns the ID of the currently authenticated user, fetching it
// once via SlackClient.WhoAmI and caching the result on the Server for
// subsequent requests.
func (s *Server) whoAmI(ctx context.Context) (string, error) {
	s.currentUserMu.Lock()
	if s.currentUserKnown {
		id := s.currentUserID
		s.currentUserMu.Unlock()
		return id, nil
	}
	s.currentUserMu.Unlock()

	id, err := s.SlackClient.WhoAmI(ctx)
	if err != nil {
		return "", err
	}

	s.currentUserMu.Lock()
	s.currentUserID = id
	s.currentUserKnown = true
	s.currentUserMu.Unlock()
	return id, nil
}

type slackConfigResponse struct {
	WorkspaceDomain string `json:"workspaceDomain"`
}

func (s *Server) handleSlackConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, slackConfigResponse{
		WorkspaceDomain: s.SlackDomain,
	})
}

// collectUserIDs gathers every user ID referenced by a thread: message
// authors, "user" mention elements, and reaction user IDs.
func collectUserIDs(t slack.Thread) []string {
	seen := map[string]struct{}{}
	var ids []string
	add := func(id string) {
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	for _, m := range t.Messages {
		add(m.UserID)
		for _, b := range m.Blocks {
			for _, e := range b.Elements {
				if e.Type == "user" {
					add(e.UserID)
				}
			}
			for _, item := range b.Items {
				for _, e := range item {
					if e.Type == "user" {
						add(e.UserID)
					}
				}
			}
		}
		for _, r := range m.Reactions {
			for _, id := range r.UserIDs {
				add(id)
			}
		}
	}
	return ids
}

// mrkdwnEmojiRe matches `:emoji_name:` tokens inside mrkdwn strings. The name
// class mirrors the frontend's mrkdwn/emoji parsing (letters, digits, _, +, -)
// so the server collects exactly the names the client will try to resolve.
var mrkdwnEmojiRe = regexp.MustCompile(`:([a-zA-Z0-9_+-]+):`)

// collectEmojiNames gathers every custom emoji name referenced by a thread —
// via reactions, rich_text `emoji` elements, AND `:name:` tokens embedded in
// mrkdwn strings (the message `text` fallback, attachment `text`, and Block
// Kit section/context/header text). The last group matters because those
// mrkdwn tokens are resolved client-side against the server-filtered emoji map;
// if a name isn't collected here it renders as literal `:name:` text.
func collectEmojiNames(t slack.Thread) []string {
	seen := map[string]struct{}{}
	var names []string
	add := func(name string) {
		if name == "" {
			return
		}
		if _, ok := seen[name]; ok {
			return
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	addFromMrkdwn := func(s string) {
		for _, mm := range mrkdwnEmojiRe.FindAllStringSubmatch(s, -1) {
			add(mm[1])
		}
	}
	for _, m := range t.Messages {
		addFromMrkdwn(m.Text)
		for _, b := range m.Blocks {
			for _, e := range b.Elements {
				if e.Type == "emoji" {
					add(e.Name)
				}
			}
			for _, item := range b.Items {
				for _, e := range item {
					if e.Type == "emoji" {
						add(e.Name)
					}
				}
			}
		}
		for _, r := range m.Reactions {
			add(r.Name)
		}
		for _, a := range m.Attachments {
			addFromMrkdwn(a.Text)
			for _, bk := range a.Blocks {
				if bk.Text != nil {
					addFromMrkdwn(bk.Text.Text)
				}
				for _, e := range bk.Elements {
					addFromMrkdwn(e.Text)
				}
			}
		}
	}
	return names
}

// mrkdwnSubteamRe matches a "<!subteam^S123>" mention in raw mrkdwn text, for
// messages that arrive without typed blocks.
var mrkdwnSubteamRe = regexp.MustCompile(`<!subteam\^([A-Z0-9]+)`)

// collectUserGroupIDs returns the subteam ids referenced anywhere in the
// thread, from both typed usergroup elements and raw mrkdwn text.
func collectUserGroupIDs(t slack.Thread) []string {
	seen := map[string]struct{}{}
	var ids []string
	add := func(id string) {
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	for _, m := range t.Messages {
		for _, mm := range mrkdwnSubteamRe.FindAllStringSubmatch(m.Text, -1) {
			add(mm[1])
		}
		for _, b := range m.Blocks {
			for _, e := range b.Elements {
				if e.Type == "usergroup" {
					add(e.UserGroupID)
				}
			}
			for _, item := range b.Items {
				for _, e := range item {
					if e.Type == "usergroup" {
						add(e.UserGroupID)
					}
				}
			}
		}
	}
	return ids
}

// userGroupsFor resolves the given subteam ids to groups, serving what it can
// from the per-Server cache and fetching only the remainder.
//
// It resolves specific ids rather than fetching a directory because the only
// endpoint that works on an Enterprise Grid org is an id lookup —
// usergroups.list comes back empty there. Resolved groups are cached across
// requests since a group's name effectively never changes.
func (s *Server) userGroupsFor(ctx context.Context, ids []string) (map[string]slack.UserGroup, error) {
	out := make(map[string]slack.UserGroup, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	var missing []string
	s.groupsMu.Lock()
	for _, id := range ids {
		if g, ok := s.groupsCache[id]; ok {
			out[id] = g
		} else {
			missing = append(missing, id)
		}
	}
	s.groupsMu.Unlock()

	if len(missing) == 0 {
		return out, nil
	}
	fetched, err := s.SlackClient.UserGroupsInfo(ctx, missing)
	if err != nil {
		return out, err // return what the cache already had
	}
	s.groupsMu.Lock()
	if s.groupsCache == nil {
		s.groupsCache = map[string]slack.UserGroup{}
	}
	for id, g := range fetched {
		s.groupsCache[id] = g
		out[id] = g
	}
	s.groupsMu.Unlock()
	return out, nil
}
