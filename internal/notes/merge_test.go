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
	block := "<<<<<<< notes\nB1\n=======\nB2\n>>>>>>> cmux"
	tests := []struct {
		name         string
		base         *string
		ours, theirs string
		want         string
	}{
		{"disjoint edits merge cleanly", ptr("a\nb\nc"), "a\nX\nb\nc", "a\nb\nc\nY", "a\nX\nb\nc\nY"},
		{"different insertions at one spot keep both", ptr("a"), "a\nb", "a\nc", "a\nb\nc"},
		{"nil base, different insertions conflict", nil, "a\nb", "a\nc", "a\n<<<<<<< notes\nb\n=======\nc\n>>>>>>> cmux"},
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
		{"same-spot insertion, ours extends theirs", ptr("a"), "a\nc\nd", "a\nc", "a\nc\nd"},
		{"same-spot insertion, theirs is a prefix of ours", ptr("a"), "a\nF1\nF2\nx", "a\nF1\nF2", "a\nF1\nF2\nx"},
		{"same-spot insertion, theirs extends ours", ptr("a"), "a\nc", "a\nc\nd", "a\nc\nd"},
		{"same-spot insertions share a line", ptr("a"), "a\np\ns\nq", "a\nr\ns\nt", "a\np\nr\ns\nq\nt"},
		{"both hold a conflict block, one adds a line before it", ptr("a"), "a\ny\n" + block, "a\n" + block, "a\ny\n" + block},
		{"both hold a conflict block, each adds a different line after it", ptr("a"), "a\n" + block + "\ny", "a\n" + block + "\nz", "a\n" + block + "\ny\nz"},
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

	t.Run("a base with markers and one side unchanged takes the other side", func(t *testing.T) {
		m := conflict
		edited := "top\n" + conflict + "\nz"
		if got := Merge(&m, m, edited, "cmux"); got != edited {
			t.Fatalf("Merge(m, m, edited) = %q, want %q", got, edited)
		}
		if got := Merge(&m, edited, m, "cmux"); got != edited {
			t.Fatalf("Merge(m, edited, m) = %q, want %q", got, edited)
		}
	})
}
