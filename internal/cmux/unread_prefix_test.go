package cmux

import "testing"

func TestStripUnreadPrefix(t *testing.T) {
	cases := []struct{ in, want string }{
		{"📬 My work", "My work"},
		{"My work", "My work"},
		{"📬My work", "📬My work"}, // only the exact prefix, space included
		{"📬 ", ""},
		{"", ""},
		{"📬 📬 x", "📬 x"}, // one layer at a time
	}
	for _, c := range cases {
		if got := StripUnreadPrefix(c.in); got != c.want {
			t.Errorf("StripUnreadPrefix(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestWithUnreadPrefix(t *testing.T) {
	cases := []struct {
		title string
		on    bool
		want  string
	}{
		{"My work", true, "📬 My work"},
		{"📬 My work", true, "📬 My work"},
		{"📬 My work", false, "My work"},
		{"My work", false, "My work"},
	}
	for _, c := range cases {
		if got := WithUnreadPrefix(c.title, c.on); got != c.want {
			t.Errorf("WithUnreadPrefix(%q, %v) = %q, want %q", c.title, c.on, got, c.want)
		}
	}
}

func TestDisplayTitleHidesUnreadPrefix(t *testing.T) {
	ws := Workspace{Ref: "workspace:1", Title: "📬 My work", CustomTitle: "📬 My work"}
	if got := ws.DisplayTitle(); got != "My work" {
		t.Fatalf("DisplayTitle = %q, want %q", got, "My work")
	}
	ws = Workspace{Ref: "workspace:1", CustomTitle: "📬 Other"}
	if got := ws.DisplayTitle(); got != "Other" {
		t.Fatalf("DisplayTitle (custom only) = %q, want %q", got, "Other")
	}
}

func TestHasUnreadPrefix(t *testing.T) {
	if !(Workspace{CustomTitle: "📬 x"}).HasUnreadPrefix() {
		t.Error("custom title with prefix: want true")
	}
	if (Workspace{CustomTitle: "x"}).HasUnreadPrefix() {
		t.Error("custom title without prefix: want false")
	}
	// An auto-titled workspace is never ours to prefix, whatever cmux calls it.
	if (Workspace{Title: "📬 x"}).HasUnreadPrefix() {
		t.Error("auto title: want false")
	}
}
