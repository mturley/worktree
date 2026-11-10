package notes

import "testing"

func TestNormalize(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{"trims ends, strips trailing space and CR", "  a  \r\nb\t\n\n\n", "a\nb"},
		{"keeps interior blank lines and indentation", "a\n\n  b", "a\n\n  b"},
		{"empty", "", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Normalize(tc.in); got != tc.want {
				t.Fatalf("Normalize(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestMerge(t *testing.T) {
	conflict := "a\n<<<<<<< notes\nB1\n=======\nB2\n>>>>>>> cmux\nc"
	tests := []struct {
		name         string
		base         *string
		ours, theirs string
		want         string
	}{
		{"disjoint edits merge cleanly", ptr("a\nb\nc"), "a\nX\nb\nc", "a\nb\nc\nY", "a\nX\nb\nc\nY"},
		{"same-line edits conflict", ptr("a\nb\nc"), "a\nB1\nc", "a\nB2\nc", conflict},
		{"identical change on both sides", ptr("a\nb\nc"), "a\nS\nc", "a\nS\nc", "a\nS\nc"},
		{"only ours changed", ptr("a\nb"), "a\nX", "a\nb", "a\nX"},
		{"only theirs changed", ptr("a\nb"), "a\nb", "a\nX", "a\nX"},
		{"conflict with one side deleted", ptr("a\nb\nc"), "a\nc", "a\nB2\nc", "a\n<<<<<<< notes\n=======\nB2\n>>>>>>> cmux\nc"},
		{"no base, containment takes the longer", nil, "a\nb", "a\nx\nb", "a\nx\nb"},
		{"no base, containment the other way", nil, "a\nx\nb", "a\nb", "a\nx\nb"},
		{"no base, disjoint conflicts", nil, "p\nq", "r", "<<<<<<< notes\np\nq\n=======\nr\n>>>>>>> cmux"},
		{"no base, ours empty", nil, "", "x\ny", "x\ny"},
		{"no base, theirs empty", nil, "x\ny", "", "x\ny"},
		{"inputs are normalised", ptr("a"), "a  \n\n", "a", "a"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Merge(tc.base, tc.ours, tc.theirs, "cmux"); got != tc.want {
				t.Fatalf("Merge = %q, want %q", got, tc.want)
			}
		})
	}

	t.Run("idempotent on a result containing markers", func(t *testing.T) {
		m := conflict
		if got := Merge(&m, m, m, "cmux"); got != m {
			t.Fatalf("Merge(m,m,m) = %q, want %q", got, m)
		}
	})
}
