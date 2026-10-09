package linked

import (
	"regexp"
	"strings"
	"unicode"

	"github.com/mturley/watcher"
)

// LinkContext is the visible label of a link and the text around it, shown
// as an indented snippet under a row. Before and After are already
// truncated (see contextRunes).
type LinkContext struct {
	Before string `json:"before"`
	Label  string `json:"label"`
	After  string `json:"after"`
}

// contextRunes bounds each side of the snippet.
const contextRunes = 60

// truncateBefore keeps the last ~contextRunes runes, starting at a word
// boundary, with a leading ellipsis when anything was cut.
func truncateBefore(s string) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= contextRunes {
		return s
	}
	tail := r[len(r)-contextRunes:]
	if !unicode.IsSpace(r[len(r)-contextRunes-1]) {
		// The cut landed inside a word: drop the partial word.
		if i := indexSpace(tail); i >= 0 {
			tail = tail[i+1:]
		}
	}
	return "…" + strings.TrimSpace(string(tail))
}

// truncateAfter keeps the first ~contextRunes runes, ending at a word
// boundary, with a trailing ellipsis when anything was cut.
func truncateAfter(s string) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= contextRunes {
		return s
	}
	head := r[:contextRunes]
	if !unicode.IsSpace(r[contextRunes]) {
		if i := lastIndexSpace(head); i >= 0 {
			head = head[:i]
		}
	}
	return strings.TrimSpace(string(head)) + "…"
}

func indexSpace(r []rune) int {
	for i, c := range r {
		if unicode.IsSpace(c) {
			return i
		}
	}
	return -1
}

func lastIndexSpace(r []rune) int {
	for i := len(r) - 1; i >= 0; i-- {
		if unicode.IsSpace(r[i]) {
			return i
		}
	}
	return -1
}

// contextFor builds the shown context for a link occurrence. key is the
// item's own identifiers ("PROJ-1", "#7"…): a label that merely restates the
// URL or the key adds nothing, and for resource rows suppresses the snippet.
// Plain links (isLink) show whenever there is any text to show.
func contextFor(ref watcher.LinkRef, isLink bool, keyForms ...string) *LinkContext {
	label := strings.TrimSpace(ref.Label)
	if label == "" {
		label = ref.URL
	}
	sameAsURL := strings.EqualFold(label, strings.TrimSpace(ref.URL))
	if isLink {
		if sameAsURL && ref.Before == "" && ref.After == "" {
			return nil
		}
	} else {
		if sameAsURL {
			return nil
		}
		for _, k := range keyForms {
			if strings.EqualFold(label, k) {
				return nil
			}
		}
	}
	return &LinkContext{
		Before: truncateBefore(ref.Before),
		Label:  label,
		After:  truncateAfter(ref.After),
	}
}

var (
	// Alternatives, in order: [label](url), <url>, bare URL.
	mdLinkPattern = regexp.MustCompile("\\[([^\\]]*)\\]\\((https?://[^)\\s]+)(?:\\s+\"[^\"]*\")?\\)|<(https?://[^>\\s]+)>|https?://[^\\s<>()\\[\\]\"'`]+")
	mdLinePrefix  = regexp.MustCompile(`^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)`)
	mdListItem    = regexp.MustCompile(`^\s*(?:[-*+]|\d+[.)])\s+`)
	mdAnyLink     = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	mdDoubleEmph  = regexp.MustCompile(`\*\*|__`)
	mdStar        = regexp.MustCompile(`\*+`)
	// An underscore only counts as emphasis at a word edge, so snake_case
	// survives.
	mdLeadUnder  = regexp.MustCompile(`(^|\W)_+`)
	mdTrailUnder = regexp.MustCompile(`_+(\W|$)`)
)

// stripMarkdown removes light inline markdown from a text segment.
func stripMarkdown(s string) string {
	s = mdAnyLink.ReplaceAllString(s, "$1")
	s = mdDoubleEmph.ReplaceAllString(s, "")
	s = mdStar.ReplaceAllString(s, "")
	s = mdLeadUnder.ReplaceAllString(s, "$1")
	s = mdTrailUnder.ReplaceAllString(s, "$1")
	return strings.ReplaceAll(s, "`", "")
}

// markdownBlocks splits a body into paragraphs (blank-line separated); each
// list item line starts its own block.
func markdownBlocks(body string) []string {
	var blocks []string
	var cur []string
	flush := func() {
		if len(cur) > 0 {
			blocks = append(blocks, strings.Join(cur, "\n"))
			cur = nil
		}
	}
	for _, line := range strings.Split(body, "\n") {
		switch {
		case strings.TrimSpace(line) == "":
			flush()
		case mdListItem.MatchString(line), strings.HasPrefix(strings.TrimSpace(line), "#"):
			flush()
			cur = append(cur, line)
			if strings.HasPrefix(strings.TrimSpace(line), "#") {
				flush()
			}
		default:
			cur = append(cur, line)
		}
	}
	flush()
	return blocks
}

// ExtractMarkdownLinks returns every link in a GitHub-flavoured markdown
// body, one entry per occurrence, in order, with its label and the text
// around it in the same paragraph (light markdown stripped). Images
// (markdown or <img>) and HTML comments — PR templates are full of
// commented-out guidance — are ignored. Trailing sentence punctuation is
// trimmed from bare URLs.
func ExtractMarkdownLinks(body string) []watcher.LinkRef {
	body = htmlCommentPattern.ReplaceAllString(body, "")
	body = mdImagePattern.ReplaceAllString(body, "")
	body = htmlImgPattern.ReplaceAllString(body, "")
	var out []watcher.LinkRef
	for _, block := range markdownBlocks(body) {
		block = mdLinePrefix.ReplaceAllString(block, "")
		var text strings.Builder
		type found struct {
			url, label string
			start, end int
		}
		var links []found
		pos := 0
		for _, loc := range mdLinkPattern.FindAllStringSubmatchIndex(block, -1) {
			text.WriteString(stripMarkdown(block[pos:loc[0]]))
			pos = loc[1]
			sub := func(n int) string {
				if loc[2*n] < 0 {
					return ""
				}
				return block[loc[2*n]:loc[2*n+1]]
			}
			var u, label, rest string
			switch {
			case loc[2] >= 0: // [label](url)
				u, label = sub(2), stripMarkdown(sub(1))
			case loc[6] >= 0: // <url>
				u = sub(3)
			default: // bare
				raw := block[loc[0]:loc[1]]
				u = strings.TrimRight(raw, ".,;:!?")
				rest = raw[len(u):]
			}
			u = strings.TrimRight(u, ".,;:!?")
			if strings.TrimSpace(label) == "" {
				label = u
			}
			start := text.Len()
			text.WriteString(label)
			if u != "" {
				links = append(links, found{u, label, start, text.Len()})
			}
			text.WriteString(rest)
		}
		text.WriteString(stripMarkdown(block[pos:]))
		full := text.String()
		for _, l := range links {
			out = append(out, watcher.LinkRef{
				URL: l.url, Label: l.label,
				Before: watcher.CollapseSpace(full[:l.start]),
				After:  watcher.CollapseSpace(full[l.end:]),
			})
		}
	}
	return out
}
