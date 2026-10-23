package reviewcomments

import (
	"errors"
	"fmt"
	"reflect"
	"testing"
)

// numbered returns n lines "l1".."ln".
func numbered(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("l%d", i+1)
	}
	return out
}

func TestSplitLines(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"a\nb\n", []string{"a", "b"}},
		{"a\nb", []string{"a", "b"}},
		{"", []string{}},
		{"a\r\n", []string{"a\r"}},
	}
	for _, c := range cases {
		got := SplitLines([]byte(c.in))
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("SplitLines(%q) = %#v, want %#v", c.in, got, c.want)
		}
	}
}

func TestCapture(t *testing.T) {
	lines := numbered(10)
	for _, r := range [][2]int{{0, 1}, {2, 1}, {9, 11}, {11, 11}} {
		if _, err := Capture(lines, r[0], r[1]); !errors.Is(err, ErrOutOfRange) {
			t.Errorf("Capture(%d,%d) err = %v, want ErrOutOfRange", r[0], r[1], err)
		}
	}
	a, err := Capture(lines, 2, 3)
	if err != nil {
		t.Fatal(err)
	}
	if a.Start != 2 || a.End != 3 {
		t.Errorf("range = %d..%d", a.Start, a.End)
	}
	if !reflect.DeepEqual(a.Snippet, []string{"l2", "l3"}) {
		t.Errorf("snippet = %v", a.Snippet)
	}
	if !reflect.DeepEqual(a.Before, []string{"l1"}) {
		t.Errorf("before = %v", a.Before)
	}
	if !reflect.DeepEqual(a.After, []string{"l4", "l5", "l6"}) {
		t.Errorf("after = %v", a.After)
	}
	// Slices are copies, not views into the caller's lines.
	lines[1] = "changed"
	if a.Snippet[0] != "l2" {
		t.Errorf("snippet aliases input: %v", a.Snippet)
	}
}

func TestResolve(t *testing.T) {
	base := numbered(12)
	anchor, err := Capture(base, 5, 6)
	if err != nil {
		t.Fatal(err)
	}

	with := func(f func([]string) []string) []string { return f(append([]string(nil), base...)) }

	// Brace fixtures: a file where line 4 is "}" with distinct context.
	braceBase := []string{"a1", "a2", "a3", "}", "b1", "b2", "b3", "c1", "c2"}
	braceAnchor, err := Capture(braceBase, 4, 4)
	if err != nil {
		t.Fatal(err)
	}

	// Anchor at line 1.
	firstAnchor, err := Capture(base, 1, 2)
	if err != nil {
		t.Fatal(err)
	}

	// Informative single-line anchor at 5.
	infoAnchor, err := Capture(base, 5, 5)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name   string
		anchor Anchor
		lines  []string
		want   Position
	}{
		{"unchanged", anchor, base, Position{MatchCurrent, 5, 6}},
		{"two lines inserted above", anchor, with(func(l []string) []string {
			return append([]string{"x1", "x2"}, l...)
		}), Position{MatchMoved, 7, 8}},
		{"snippet edited", anchor, with(func(l []string) []string {
			l[4] = "edited"
			return l
		}), Position{MatchOutdated, 0, 0}},
		{"snippet+context duplicated twice, original position changed", anchor, func() []string {
			block := append([]string(nil), base[1:9]...) // l2..l9
			out := []string{"top1", "top2"}
			out = append(out, block...)
			out = append(out, "mid")
			out = append(out, block...)
			return out
		}(), Position{MatchOutdated, 0, 0}},
		{"brace snippet shifted, context intact", braceAnchor, append([]string{"new1", "new2"}, braceBase...), Position{MatchMoved, 6, 6}},
		{"brace snippet with context changed, another brace elsewhere", braceAnchor,
			[]string{"a1", "a2", "zz", "}", "b1", "b2", "b3", "c1", "}", "q"},
			Position{MatchOutdated, 0, 0}},
		{"brace snippet unique but context changed", braceAnchor,
			[]string{"a1", "a2", "zz", "}", "yy", "b2", "b3", "c1", "c2"},
			Position{MatchOutdated, 0, 0}},
		{"informative snippet unique, context changed, same lines", infoAnchor, with(func(l []string) []string {
			l[2] = "other"
			return l
		}), Position{MatchMoved, 5, 5}},
		{"informative snippet unique, context changed, different lines", infoAnchor, append([]string{"n1", "n2"}, with(func(l []string) []string {
			l[2] = "other"
			return l
		})...), Position{MatchMoved, 7, 7}},
		{"file now shorter than the anchor", anchor, []string{"l1", "l2"}, Position{MatchOutdated, 0, 0}},
		{"empty file", anchor, []string{}, Position{MatchOutdated, 0, 0}},
		{"anchor at line 1 unchanged", firstAnchor, base, Position{MatchCurrent, 1, 2}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Resolve(c.anchor, c.lines)
			if got != c.want {
				t.Errorf("Resolve = %+v, want %+v", got, c.want)
			}
		})
	}
}
