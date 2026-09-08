package webui

import (
	"reflect"
	"testing"

	"github.com/mturley/watcher/slack"
)

func TestTokenBuilders(t *testing.T) {
	tests := []struct {
		name string
		got  string
		want string
	}{
		{"user", userToken("U123"), "<@U123>"},
		{"group", groupToken("S123"), "<!subteam^S123>"},
		{"special here", specialToken("here"), "<!here>"},
		{"special channel", specialToken("channel"), "<!channel>"},
		{"channel", channelToken("C123", "odh-dashboard"), "<#C123|odh-dashboard>"},
		{"emoji", emojiToken("tada"), ":tada:"},
	}
	for _, tt := range tests {
		if tt.got != tt.want {
			t.Errorf("%s: got %q, want %q", tt.name, tt.got, tt.want)
		}
	}
}

func TestUserLabelPrefersDisplayNameThenRealNameThenHandle(t *testing.T) {
	tests := []struct {
		user slack.User
		want string
	}{
		{slack.User{ID: "U1", DisplayName: "ada", RealName: "Ada Roberts", Name: "aroberts"}, "ada"},
		{slack.User{ID: "U1", DisplayName: "", RealName: "Ada Roberts", Name: "aroberts"}, "Ada Roberts"},
		{slack.User{ID: "U1", DisplayName: "", RealName: "", Name: "aroberts"}, "aroberts"},
		{slack.User{ID: "U1"}, "U1"}, // never blank: an unlabelled row is unpickable
	}
	for _, tt := range tests {
		if got := userLabel(tt.user); got != tt.want {
			t.Errorf("userLabel(%+v) = %q, want %q", tt.user, got, tt.want)
		}
	}
}

func TestSpecialItemsFilterByQuery(t *testing.T) {
	all := specialItems("")
	if len(all) != 3 {
		t.Fatalf("got %d specials, want 3 (@here, @channel, @everyone)", len(all))
	}
	got := specialItems("her")
	want := []AutocompleteItem{{
		Kind:   "special",
		ID:     "here",
		Label:  "@here",
		Detail: "Notify everyone online in this channel",
		Token:  "<!here>",
	}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("specialItems(\"her\") = %+v, want %+v", got, want)
	}
}
