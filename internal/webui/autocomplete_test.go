package webui

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mturley/watcher/slack"
)

func TestAutocompleteRejectsUnknownTrigger(t *testing.T) {
	s := &Server{SlackClient: &fakeSlack{}}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/slack-autocomplete?trigger=%21&q=x", nil)
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", rec.Code)
	}
}

func TestAutocompleteMentionsMergesUsersGroupsAndSpecials(t *testing.T) {
	fs := &fakeSlack{
		searchUsers:      []slack.User{{ID: "U1", Name: "aroberts", DisplayName: "ada", Avatar72: "https://a/72.png"}},
		searchUserGroups: []slack.UserGroup{{ID: "S1", Handle: "platform", Name: "Platform Team"}},
	}
	s := &Server{SlackClient: fs}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/slack-autocomplete?trigger=%40&q=her&channel=C1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d: %s", rec.Code, rec.Body)
	}
	var got struct{ Results []AutocompleteItem }
	json.NewDecoder(rec.Body).Decode(&got)

	kinds := map[string]AutocompleteItem{}
	for _, it := range got.Results {
		kinds[it.Kind] = it
	}
	if kinds["user"].Token != "<@U1>" || kinds["user"].Label != "ada" || kinds["user"].Detail != "aroberts" {
		t.Errorf("user item wrong: %+v", kinds["user"])
	}
	if kinds["group"].Token != "<!subteam^S1>" || kinds["group"].Label != "@platform" {
		t.Errorf("group item wrong: %+v", kinds["group"])
	}
	if kinds["special"].Token != "<!here>" {
		t.Errorf("special item wrong: %+v", kinds["special"])
	}
	// Ranking: users before groups before specials.
	if got.Results[0].Kind != "user" || got.Results[len(got.Results)-1].Kind != "special" {
		t.Errorf("ranking wrong: %+v", got.Results)
	}
}

func TestAutocompleteBareTriggerMakesNoSlackCall(t *testing.T) {
	fs := &fakeSlack{}
	s := &Server{SlackClient: fs}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/slack-autocomplete?trigger=%40&q=", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d", rec.Code)
	}
	if len(fs.queries()) != 0 {
		t.Errorf("bare trigger hit Slack: %v", fs.queries())
	}
	var got struct{ Results []AutocompleteItem }
	json.NewDecoder(rec.Body).Decode(&got)
	if len(got.Results) != 3 {
		t.Errorf("want the 3 specials, got %+v", got.Results)
	}
}

func TestAutocompleteEmojiFiltersCachedMapWithoutSlackSearch(t *testing.T) {
	fs := &fakeSlack{emoji: map[string]string{
		"tada":     "https://e/tada.png",
		"tadpole":  "https://e/tadpole.png",
		"thumbsup": "https://e/thumbsup.png",
	}}
	s := &Server{SlackClient: fs}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/slack-autocomplete?trigger=%3A&q=tad", nil))
	var got struct{ Results []AutocompleteItem }
	json.NewDecoder(rec.Body).Decode(&got)
	if len(got.Results) != 2 {
		t.Fatalf("got %+v, want tada and tadpole", got.Results)
	}
	if got.Results[0].Token != ":tada:" || got.Results[0].ImageURL != "https://e/tada.png" {
		t.Errorf("emoji item wrong: %+v", got.Results[0])
	}
}

func TestAutocompleteChannels(t *testing.T) {
	fs := &fakeSlack{searchChannels: []slack.Channel{{ID: "C1", Name: "odh-dashboard"}}}
	s := &Server{SlackClient: fs}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/slack-autocomplete?trigger=%23&q=odh", nil))
	var got struct{ Results []AutocompleteItem }
	json.NewDecoder(rec.Body).Decode(&got)
	if len(got.Results) != 1 || got.Results[0].Token != "<#C1|odh-dashboard>" || got.Results[0].Label != "#odh-dashboard" {
		t.Fatalf("channel item wrong: %+v", got.Results)
	}
}

// TestAutocompleteMentionCacheKeyDoesNotCollideAcrossFieldBoundaries pins the
// fix for a cache-key collision: q="a|b", channel="c" and q="a",
// channel="b|c" both joined to "@|a|b|c" under a plain "|" separator, so the
// second request would wrongly get served the first request's (differently
// scoped) cached results. It must not.
func TestAutocompleteMentionCacheKeyDoesNotCollideAcrossFieldBoundaries(t *testing.T) {
	fs := &fakeSlack{
		searchUsers: []slack.User{{ID: "U1", Name: "u1", DisplayName: "u1"}},
	}
	s := &Server{SlackClient: fs}

	rec1 := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec1, httptest.NewRequest("GET", "/api/slack-autocomplete?trigger=%40&q=a%7Cb&channel=c", nil))
	if rec1.Code != http.StatusOK {
		t.Fatalf("first request: got %d", rec1.Code)
	}

	// Change what the fake returns so the second request's response would
	// differ from the first's if it actually hit Slack instead of a
	// colliding cache entry.
	fs.searchUsers = []slack.User{{ID: "U2", Name: "u2", DisplayName: "u2"}}

	rec2 := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec2, httptest.NewRequest("GET", "/api/slack-autocomplete?trigger=%40&q=a&channel=b%7Cc", nil))
	if rec2.Code != http.StatusOK {
		t.Fatalf("second request: got %d", rec2.Code)
	}

	var got2 struct{ Results []AutocompleteItem }
	json.NewDecoder(rec2.Body).Decode(&got2)
	found := false
	for _, it := range got2.Results {
		if it.Kind == "user" && it.ID == "U2" {
			found = true
		}
		if it.Kind == "user" && it.ID == "U1" {
			t.Errorf("second request served the first request's cached user U1 — cache key collision: %+v", got2.Results)
		}
	}
	if !found {
		t.Errorf("second request did not hit Slack for its own distinct key: %+v", got2.Results)
	}
}

func TestAutocompleteSurfacesSlackErrors(t *testing.T) {
	fs := &fakeSlack{searchErr: errors.New("boom")}
	s := &Server{SlackClient: fs}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/slack-autocomplete?trigger=%40&q=ada", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("got %d, want 502 — the UI degrades to local results on error", rec.Code)
	}
}
