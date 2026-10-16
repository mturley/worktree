package webui

import (
	"strings"
	"unicode"
)

// Search over the activity feeds (`q` on /api/timeline and
// /api/worktree-timeline). The rules mirror ui/src/lib/search.ts:
// case-insensitive, whitespace-separated terms, every term must match
// somewhere on the event. See docs/web-ui-architecture.md "Search".

// searchMatch says why an event matched, for the UI's dimmed "why" line.
// Field is "title", "body", "author" or "resource"; Snippet is text around
// the hit (body), the author, or the resource's short key (resource).
type searchMatch struct {
	Field   string `json:"field"`
	Snippet string `json:"snippet"`
}

func parseSearchTerms(q string) []string {
	var out []string
	seen := map[string]bool{}
	for _, f := range strings.Fields(strings.ToLower(q)) {
		if !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	return out
}

var likeEscaper = strings.NewReplacer(`\`, `\\`, `_`, `\_`, `%`, `\%`)

func likeContains(term string) string { return "%" + likeEscaper.Replace(term) + "%" }

// searchArgsPerTerm is how many placeholders one term's group uses.
const searchArgsPerTerm = 6

// searchSQL narrows the global timeline to events matching every term. The
// resource fields are EXISTS subqueries rather than joins, so they can never
// multiply rows. Cached titles live under "title" (PR, Slack, link) or
// "summary" (Jira) in state_json — see enrichResourceDTO.
//
// SQLite's LIKE folds ASCII case only; matchEvent (Go, Unicode) decorates
// whatever SQL returns, so a non-ASCII mismatch can only make SQL stricter.
func searchSQL(terms []string) (string, []any) {
	if len(terms) == 0 {
		return "", nil
	}
	const group = `AND (
    e.title LIKE ? ESCAPE '\' OR COALESCE(e.body,'') LIKE ? ESCAPE '\' OR COALESCE(e.author,'') LIKE ? ESCAPE '\'
 OR er.resource_id LIKE ? ESCAPE '\'
 OR EXISTS (SELECT 1 FROM watcher_resource_meta m
             WHERE m.resource_type = er.resource_type AND m.resource_id = er.resource_id
               AND COALESCE(m.custom_name,'') LIKE ? ESCAPE '\')
 OR EXISTS (SELECT 1 FROM watcher_resource_state rs
             WHERE rs.resource_type = er.resource_type AND rs.resource_id = er.resource_id
               AND CASE WHEN json_valid(rs.state_json)
                   THEN COALESCE(json_extract(rs.state_json,'$.title'),'') || ' ' || COALESCE(json_extract(rs.state_json,'$.summary'),'')
                   ELSE '' END LIKE ? ESCAPE '\')
) `
	var b strings.Builder
	args := make([]any, 0, len(terms)*searchArgsPerTerm)
	for _, t := range terms {
		b.WriteString(group)
		p := likeContains(t)
		for i := 0; i < searchArgsPerTerm; i++ {
			args = append(args, p)
		}
	}
	return b.String(), args
}

// matchEvent is the Go twin of searchSQL over an enriched event. It returns
// nil unless every term appears in some field; otherwise the highest-priority
// field containing any term.
func matchEvent(te *TimelineEvent, terms []string) *searchMatch {
	if len(terms) == 0 {
		return nil
	}
	resourceText := te.ResourceID
	if d := te.Resource; d != nil {
		resourceText = strings.Join([]string{d.ID, d.CustomName, d.Title}, "\n")
	}
	fields := []struct{ name, text string }{
		{"title", te.Title}, {"body", te.Body}, {"author", te.Author}, {"resource", resourceText},
	}
	lower := make([]string, len(fields))
	for i, f := range fields {
		lower[i] = strings.ToLower(f.text)
	}
	for _, t := range terms {
		hit := false
		for _, l := range lower {
			if strings.Contains(l, t) {
				hit = true
				break
			}
		}
		if !hit {
			return nil
		}
	}
	for i, f := range fields {
		for _, t := range terms {
			if !strings.Contains(lower[i], t) {
				continue
			}
			switch f.name {
			case "body":
				return &searchMatch{Field: "body", Snippet: snippet(f.text, t)}
			case "resource":
				return &searchMatch{Field: "resource", Snippet: te.ResourceID}
			default:
				return &searchMatch{Field: f.name, Snippet: f.text}
			}
		}
	}
	return nil
}

// snippetRadius is how many runes of context to keep on each side of a hit.
const snippetRadius = 30

// snippet returns text around the first occurrence of term (lowercase):
// whitespace collapsed, cut at word boundaries, "…" marking each cut. "" when
// term does not occur. Same rule as ui/src/lib/search.ts snippet().
func snippet(text, term string) string {
	flat := []rune(strings.Join(strings.Fields(text), " "))
	low := make([]rune, len(flat))
	for i, r := range flat {
		low[i] = unicode.ToLower(r)
	}
	tr := []rune(term)
	at := -1
	for i := 0; i+len(tr) <= len(low); i++ {
		if string(low[i:i+len(tr)]) == term {
			at = i
			break
		}
	}
	if at < 0 {
		return ""
	}
	start, end := at-snippetRadius, at+len(tr)+snippetRadius
	cutStart, cutEnd := start > 0, end < len(flat)
	if !cutStart {
		start = 0
	} else {
		// Drop the partial word at the cut.
		for start < at && flat[start-1] != ' ' {
			start++
		}
	}
	if !cutEnd {
		end = len(flat)
	} else {
		for end > at+len(tr) && flat[end] != ' ' {
			end--
		}
	}
	out := strings.TrimSpace(string(flat[start:end]))
	if cutStart {
		out = "…" + out
	}
	if cutEnd {
		out += "…"
	}
	return out
}
