package notes

// ActionKind is what a sync check must do to bring notes and the cmux
// workspace description back into agreement.
type ActionKind int

const (
	ActNone ActionKind = iota
	ActPush
	ActPull
	ActMerge
)

// Action is a sync decision. Text is what both sides must hold afterwards
// (empty for ActNone).
type Action struct {
	Kind ActionKind
	Text string
}

// Decide compares notes and the cmux description against the last synced
// base. base is nil when there is none; a base recorded for a different
// workspace (baseWorkspace != workspaceID) is treated as no base. All
// comparisons are on Normalize'd text.
func Decide(notes, cmuxDesc string, base *string, baseWorkspace, workspaceID string) Action {
	n, c := Normalize(notes), Normalize(cmuxDesc)

	// An empty description is never pulled: cmux "lost" it, so refill it.
	if c == "" && n != "" {
		return Action{ActPush, n}
	}
	if n == c {
		return Action{ActNone, ""}
	}

	var b *string
	if base != nil && baseWorkspace == workspaceID {
		nb := Normalize(*base)
		b = &nb
	}
	if b == nil {
		if n == "" {
			return Action{ActPull, c}
		}
		return Action{ActMerge, Merge(nil, n, c, "cmux")}
	}

	switch {
	case c == *b:
		return Action{ActPush, n}
	case n == *b:
		return Action{ActPull, c}
	default:
		return Action{ActMerge, Merge(b, n, c, "cmux")}
	}
}
