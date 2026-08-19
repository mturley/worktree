package slackurl

import "testing"

func TestParse(t *testing.T) {
	ch, ts, ok := Parse("https://acme.slack.com/archives/C0123ABCD/p1699999999000100")
	if !ok || ch != "C0123ABCD" || ts != "1699999999.000100" {
		t.Fatalf("got %q %q %v", ch, ts, ok)
	}
	if _, _, ok := Parse("https://github.com/x/y/pull/1"); ok {
		t.Fatal("non-slack URL should not parse")
	}
}

func TestResourceID(t *testing.T) {
	if ResourceID("C1", "1699999999.000100") != "C1:1699999999.000100" {
		t.Fatal()
	}
}
