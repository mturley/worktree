package webui

import (
	"regexp"
	"strings"
)

// slackToken is one of Slack mrkdwn's angle-bracket tokens: a mention, a
// channel, a special command or a link. Literal < and > in a message arrive
// escaped (&lt; &gt;), so a bare bracket never starts one.
var slackToken = regexp.MustCompile(`<([^<>]+)>`)

var slackUnescape = strings.NewReplacer("&lt;", "<", "&gt;", ">", "&amp;", "&")

// slackPlain turns a line of Slack mrkdwn into plain text, for a task title:
// <@U…|name> → @name (@user without a name), <#C…|name> → #name, <!here>
// → @here, <url|label> → label, <url> → url, then &lt; &gt; &amp; are
// unescaped. Formatting marks (*bold*, _italic_) are left as they are. The
// UI's twin is ui/src/lib/mrkdwnPlain.ts.
func slackPlain(s string) string {
	s = slackToken.ReplaceAllStringFunc(s, func(m string) string {
		target, label, _ := strings.Cut(m[1:len(m)-1], "|")
		switch {
		case strings.HasPrefix(target, "@"):
			if label != "" {
				return "@" + strings.TrimPrefix(label, "@")
			}
			return "@user"
		case strings.HasPrefix(target, "#"):
			if label != "" {
				return "#" + strings.TrimPrefix(label, "#")
			}
			return "#channel"
		case strings.HasPrefix(target, "!"):
			if label != "" {
				return label
			}
			cmd, _, _ := strings.Cut(strings.TrimPrefix(target, "!"), "^")
			return "@" + cmd
		}
		if label != "" {
			return label
		}
		return target
	})
	// One pass, so "&amp;lt;" becomes "&lt;", not "<".
	return slackUnescape.Replace(s)
}
