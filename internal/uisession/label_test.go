package uisession

import (
	"strings"
	"testing"
)

func TestLabel(t *testing.T) {
	cases := map[string]string{
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36": "Mac — Chrome",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15": "Mac — Safari",
		"Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36": "Android — Chrome",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1": "iPhone — Safari",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0": "Windows — Edge",
		"Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0": "Linux — Firefox",
		"":            "Unknown device",
		"curl/8.7.1":  "curl/8.7.1",
	}
	for ua, want := range cases {
		if got := Label(ua); got != want {
			t.Errorf("Label(%q) = %q, want %q", ua, got, want)
		}
	}
}

func TestLabelTruncatesUnrecognisedAgents(t *testing.T) {
	got := Label(strings.Repeat("x", 500))
	if len([]rune(got)) != maxLabelLen {
		t.Fatalf("label length %d, want %d", len([]rune(got)), maxLabelLen)
	}
}
