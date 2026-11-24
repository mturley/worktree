package webui

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	watcherdb "github.com/mturley/watcher/db"
	"github.com/mturley/worktree/internal/resourceurl"
	"github.com/mturley/worktree/internal/slackurl"
)

// firstMessageMax is the longest FirstMessage excerpt, in runes.
const firstMessageMax = 200

// SlackThreadSummary describes one followed (or archived) Slack thread, from
// the local cache alone: nothing here calls Slack.
type SlackThreadSummary struct {
	ID                string   `json:"id"`
	URL               string   `json:"url"`
	ChannelName       string   `json:"channel_name"`
	CustomName        string   `json:"custom_name"`
	CustomDescription string   `json:"custom_description"`
	Title             string   `json:"title"`
	Author            string   `json:"author"`
	StartedAt         string   `json:"started_at"` // RFC 3339
	UpdatedAt         string   `json:"updated_at"` // RFC 3339
	ReplyCount        int      `json:"reply_count"`
	RepliesCached     int      `json:"replies_cached"`
	Complete          bool     `json:"complete"`
	Unread            bool     `json:"unread"`
	Archived          bool     `json:"archived"`
	Worktrees         []string `json:"worktrees"`
	LastFollowedBy    []string `json:"last_followed_by"`
	FirstMessage      string   `json:"first_message"`
}

// SlackMessage is one message of a cached thread. Text stays Slack mrkdwn,
// minus the leading "<author>: " the poller prepends.
type SlackMessage struct {
	Author      string `json:"author"`
	AuthorID    string `json:"author_id"`
	TS          string `json:"ts"`      // Slack ts
	SentAt      string `json:"sent_at"` // RFC 3339
	Text        string `json:"text"`
	Root        bool   `json:"root"`
	Synthesized bool   `json:"synthesized"`
}

// maxAmbiguousCandidates caps the candidates an ambiguous name lists; Total
// carries the true count.
const maxAmbiguousCandidates = 10

// AmbiguousThreadError: a name matched several threads.
type AmbiguousThreadError struct {
	Name       string
	Total      int // every thread that matched; Candidates holds at most maxAmbiguousCandidates
	Candidates []SlackThreadSummary
}

func (e *AmbiguousThreadError) Error() string {
	return fmt.Sprintf("ambiguous: %d threads match %q", e.Total, e.Name)
}

// ErrThreadNotFound: nothing followed or archived matches the reference.
var ErrThreadNotFound = errors.New("no followed Slack thread matches")

// slackMessageText is a Slack message event's body without its leading
// "Author: ". Go twin of slackMessageText in ui/src/lib/slackEvent.ts.
func slackMessageText(body, author string) string {
	if author == "" {
		return body
	}
	prefix := author + ": "
	return strings.TrimPrefix(body, prefix)
}

// slackTSToRFC3339 renders a Slack ts ("1795041474.372839") as RFC 3339 UTC;
// "" when it is not one.
func slackTSToRFC3339(ts string) string {
	secs, _, _ := strings.Cut(ts, ".")
	n, err := strconv.ParseInt(secs, 10, 64)
	if err != nil || n <= 0 {
		return ""
	}
	return time.Unix(n, 0).UTC().Format(time.RFC3339)
}

// slackThreadCandidates lists every Slack thread: followed ones, then
// archived ones not already listed.
func (s *Server) slackThreadCandidates() ([]AllResource, error) {
	all, err := s.AllResources()
	if err != nil {
		return nil, err
	}
	archived, err := s.ArchivedResources()
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []AllResource
	for _, r := range append(all, archived...) {
		if r.Type != "slack" || seen[r.ID] {
			continue
		}
		seen[r.ID] = true
		out = append(out, r)
	}
	return out, nil
}

// baseSlackSummary is the part of a summary that needs no event query.
func baseSlackSummary(r AllResource) SlackThreadSummary {
	sum := SlackThreadSummary{
		ID: r.ID, URL: r.URL, ChannelName: r.ChannelName,
		CustomName: r.CustomName, CustomDescription: r.CustomDescription,
		Title: r.Title, Author: r.Author,
		StartedAt: slackTSToRFC3339(r.CreatedTS), UpdatedAt: slackTSToRFC3339(r.UpdatedTS),
		Unread: r.HasUnread, Archived: r.Archived,
		Worktrees: []string{}, LastFollowedBy: []string{},
	}
	for _, w := range r.Worktrees {
		sum.Worktrees = append(sum.Worktrees, w.Path)
	}
	for _, w := range r.LastFollowedBy {
		sum.LastFollowedBy = append(sum.LastFollowedBy, w.Path)
	}
	return sum
}

// ResolveSlackThread turns a URL, "slack:<id>" or a name into a thread's
// resource id. Read-only.
func (s *Server) ResolveSlackThread(ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	cands, err := s.slackThreadCandidates()
	if err != nil {
		return "", err
	}
	hasID := func(id string) bool {
		for _, c := range cands {
			if c.ID == id {
				return true
			}
		}
		return false
	}
	if strings.Contains(ref, "://") {
		id := ""
		if ch, ts, ok := slackurl.Parse(ref); ok {
			id = slackurl.ResourceID(ch, ts)
		} else if typ, rid, ok := resourceurl.Infer(ref); ok && typ == "slack" {
			id = rid
		}
		if id != "" && hasID(id) {
			return id, nil
		}
		return "", ErrThreadNotFound
	}
	if id, ok := strings.CutPrefix(ref, "slack:"); ok {
		if hasID(id) {
			return id, nil
		}
		return "", ErrThreadNotFound
	}
	if ref == "" {
		return "", ErrThreadNotFound
	}
	needle := strings.ToLower(ref)
	var exact, partial []AllResource
	for _, c := range cands {
		names := []string{strings.ToLower(c.CustomName), strings.ToLower(c.Title)}
		isExact, isPartial := false, false
		for _, n := range names {
			if n == "" {
				continue
			}
			if n == needle {
				isExact = true
			}
			if strings.Contains(n, needle) {
				isPartial = true
			}
		}
		if isExact {
			exact = append(exact, c)
		} else if isPartial {
			partial = append(partial, c)
		}
	}
	pick := exact
	if len(pick) == 0 {
		pick = partial
	}
	switch len(pick) {
	case 0:
		return "", ErrThreadNotFound
	case 1:
		return pick[0].ID, nil
	}
	amb := &AmbiguousThreadError{Name: ref, Total: len(pick)}
	for _, c := range pick {
		if len(amb.Candidates) >= maxAmbiguousCandidates {
			break
		}
		amb.Candidates = append(amb.Candidates, baseSlackSummary(c))
	}
	return "", amb
}

func (s *Server) findSlackThread(id string) (AllResource, error) {
	cands, err := s.slackThreadCandidates()
	if err != nil {
		return AllResource{}, err
	}
	for _, c := range cands {
		if c.ID == id {
			return c, nil
		}
	}
	return AllResource{}, ErrThreadNotFound
}

type slackEventRow struct {
	id, typ, ts, extTS, body, author, authorID string
}

// slackThreadEvents reads a thread's message-bearing events, oldest first by
// Slack ts (id breaks ties).
func (s *Server) slackThreadEvents(id string) ([]slackEventRow, error) {
	rows, err := s.DB.Query(`
		SELECT e.id, e.type, e.ts, COALESCE(e.external_ts, ''), COALESCE(e.body, ''),
		       COALESCE(e.author, ''), COALESCE(e.author_id, '')
		  FROM watcher_events e
		  JOIN watcher_event_resources r ON r.event_id = e.id
		 WHERE r.resource_type = 'slack' AND r.resource_id = ? AND e.source = 'slack'
		   AND e.type IN ('slack_thread_root', 'slack_reply', 'watch_started')`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []slackEventRow
	for rows.Next() {
		var e slackEventRow
		if err := rows.Scan(&e.id, &e.typ, &e.ts, &e.extTS, &e.body, &e.author, &e.authorID); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.extTS != b.extTS {
			if slackTSGreater(a.extTS, b.extTS) {
				return false
			}
			if slackTSGreater(b.extTS, a.extTS) {
				return true
			}
		}
		return a.id < b.id
	})
	return out, nil
}

// SlackThread is the summary of one thread. Read-only; never calls Slack.
func (s *Server) SlackThread(id string) (SlackThreadSummary, error) {
	r, err := s.findSlackThread(id)
	if err != nil {
		return SlackThreadSummary{}, err
	}
	sum := baseSlackSummary(r)
	evs, err := s.slackThreadEvents(id)
	if err != nil {
		return SlackThreadSummary{}, err
	}
	var root *slackEventRow
	for i := range evs {
		switch evs[i].typ {
		case "slack_reply":
			sum.RepliesCached++
		case "slack_thread_root":
			if root == nil {
				root = &evs[i]
			}
		}
	}
	// reply_count lives only in the cached state, which the DTO does not carry.
	sum.ReplyCount = s.cachedReplyCount(id)
	sum.Complete = sum.RepliesCached >= sum.ReplyCount
	if root != nil {
		if root.author != "" {
			sum.Author = root.author
		}
		if root.ts != "" {
			sum.StartedAt = root.ts
		}
		sum.FirstMessage = firstMessageExcerpt(slackMessageText(root.body, root.author))
	} else if msgs := s.synthesizedRoot(r, evs); msgs != nil {
		sum.FirstMessage = firstMessageExcerpt(msgs.Text)
	}
	return sum, nil
}

// SlackThreadMessages is every cached message of a thread, oldest first.
// Read-only; never calls Slack; text stays mrkdwn.
func (s *Server) SlackThreadMessages(id string) ([]SlackMessage, error) {
	r, err := s.findSlackThread(id)
	if err != nil {
		return nil, err
	}
	evs, err := s.slackThreadEvents(id)
	if err != nil {
		return nil, err
	}
	out := []SlackMessage{}
	hasRoot := false
	for _, e := range evs {
		if e.typ == "watch_started" {
			continue
		}
		m := SlackMessage{
			Author: e.author, AuthorID: e.authorID, TS: e.extTS,
			SentAt: e.ts, Text: slackMessageText(e.body, e.author),
			Root: e.typ == "slack_thread_root",
		}
		if m.Root {
			hasRoot = true
		}
		out = append(out, m)
	}
	if !hasRoot {
		if m := s.synthesizedRoot(r, evs); m != nil {
			out = append([]SlackMessage{*m}, out...)
		}
	}
	// A real root is the thread's first message whatever its clock says.
	sort.SliceStable(out, func(i, j int) bool { return out[i].Root && !out[j].Root })
	return out, nil
}

// synthesizedRoot builds the root of a thread followed before
// slack_thread_root existed, from watch_started's body and cached state.
func (s *Server) synthesizedRoot(r AllResource, evs []slackEventRow) *SlackMessage {
	for _, e := range evs {
		if e.typ != "watch_started" {
			continue
		}
		return &SlackMessage{
			Author: r.Author, TS: r.CreatedTS, SentAt: slackTSToRFC3339(r.CreatedTS),
			Text: e.body, Root: true, Synthesized: true,
		}
	}
	return nil
}

// firstMessageExcerpt is text with whitespace collapsed, cut to at most
// firstMessageMax runes including the closing "…", at a word boundary. A first
// word too long to fit is cut mid-word rather than reduced to nothing.
func firstMessageExcerpt(text string) string {
	flat := []rune(strings.Join(strings.Fields(text), " "))
	if len(flat) <= firstMessageMax {
		return string(flat)
	}
	keep := firstMessageMax - 1 // room for "…"
	end := keep
	if flat[keep] != ' ' {
		for end > 0 && flat[end-1] != ' ' {
			end--
		}
		if end == 0 {
			end = keep
		}
	}
	return strings.TrimSpace(string(flat[:end])) + "…"
}

// cachedReplyCount is the thread's reply_count from its cached state: 0 when
// the thread was never polled or the blob is malformed.
func (s *Server) cachedReplyCount(id string) int {
	st, err := watcherdb.GetResourceState(s.DB, "slack", id)
	if err != nil || st == nil {
		return 0
	}
	var m struct {
		ReplyCount float64 `json:"reply_count"`
	}
	if json.Unmarshal([]byte(st.StateJSON), &m) != nil {
		return 0
	}
	return int(m.ReplyCount)
}
