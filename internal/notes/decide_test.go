package notes

import "testing"

func TestDecide(t *testing.T) {
	s := func(v string) *string { return &v }
	const ws = "ws-1"
	tests := []struct {
		name       string
		notes, cmx string
		base       *string
		baseWS     string
		want       Action
	}{
		{"all equal", "a", "a", s("a"), ws, Action{ActNone, ""}},
		{"notes changed", "b", "a", s("a"), ws, Action{ActPush, "b"}},
		{"cmux changed", "a", "c", s("a"), ws, Action{ActPull, "c"}},
		{"both changed", "n", "c", s("a"), ws, Action{ActMerge, Merge(s("a"), "n", "c", "cmux")}},
		{"cmux trimming only", "a\n", "a", s("a\n"), ws, Action{ActNone, ""}},
		{"cmux empty base==notes", "n", "", s("n"), ws, Action{ActPush, "n"}},
		{"cmux empty base empty", "n", "", s(""), ws, Action{ActPush, "n"}},
		{"both empty", "", "", s("x"), ws, Action{ActNone, ""}},
		{"no base notes empty", "", "c", nil, "", Action{ActPull, "c"}},
		{"no base cmux empty", "n", "", nil, "", Action{ActPush, "n"}},
		{"other workspace base", "n", "c", s("a"), "ws-old", Action{ActMerge, Merge(nil, "n", "c", "cmux")}},
		{"no base equal", "a\n", "a", nil, "", Action{ActNone, ""}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Decide(tt.notes, tt.cmx, tt.base, tt.baseWS, ws)
			if got != tt.want {
				t.Fatalf("Decide = %+v, want %+v", got, tt.want)
			}
		})
	}
}
