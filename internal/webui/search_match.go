package webui

import (
	"net/url"
	"strconv"
	"strings"

	"github.com/mturley/worktree/internal/tasks"
)

// Go twin of the matchers in ui/src/lib/search.ts (matchResource, matchTask,
// matchWorktree, rankText, rankResource, rankTask). Field lists, order, which
// fields get a snippet and the rank rules must stay identical: the shared
// fixture ui/src/lib/testdata/search-parity.json is read by
// TestSearchParityFixture here and by searchParity.test.ts there.

// matchWorktreesViaResources is the twin of MATCH_WORKTREES_VIA_RESOURCES.
const matchWorktreesViaResources = true

type searchField struct {
	name, text string
	long       bool
}

// uiShortRef is ui/src/lib/resourceRef.ts's shortResourceRef, which differs
// from shortResourceRef (task_timeline.go) for Slack ("") and links (host).
func uiShortRef(typ, id string) string {
	switch typ {
	case "pr":
		if i := strings.LastIndex(id, "#"); i >= 0 {
			return id[i:]
		}
		return id
	case "jira":
		return id
	case "link":
		u, err := url.Parse(id)
		if err != nil || u.Scheme == "" || u.Hostname() == "" {
			return ""
		}
		return strings.TrimPrefix(u.Hostname(), "www.")
	}
	return ""
}

func resourceLabel(r *resourceDTO) string {
	if r.CustomName != "" {
		return r.CustomName
	}
	if r.Title != "" {
		return r.Title
	}
	return r.ID
}

func resourceFields(r *resourceDTO) []searchField {
	status := r.Status
	if status == "" {
		status = r.State
	}
	link := ""
	if r.Type == "link" {
		link = r.URL
	}
	return []searchField{
		{name: "key", text: r.ID + "\n" + uiShortRef(r.Type, r.ID) + "\n" + r.ChannelName},
		{name: "name", text: r.CustomName},
		{name: "title", text: r.Title},
		{name: "description", text: r.CustomDescription, long: true},
		{name: "assignee", text: r.Assignee},
		{name: "author", text: r.Author},
		{name: "reporter", text: r.Reporter},
		{name: "status", text: status},
		{name: "labels", text: strings.Join(r.Labels, ", ")},
		{name: "description", text: r.Description, long: true},
		{name: "url", text: link},
	}
}

func lowerTexts(fields []searchField) []string {
	out := make([]string, len(fields))
	for i, f := range fields {
		out[i] = strings.ToLower(f.text)
	}
	return out
}

func allTermsHit(lower []string, terms []string) bool {
	for _, t := range terms {
		hit := false
		for _, l := range lower {
			if strings.Contains(l, t) {
				hit = true
				break
			}
		}
		if !hit {
			return false
		}
	}
	return true
}

// firstHit is the highest-priority field containing any term.
func firstHit(fields []searchField, terms []string) *searchMatch {
	for _, f := range fields {
		low := strings.ToLower(f.text)
		for _, t := range terms {
			if !strings.Contains(low, t) {
				continue
			}
			if f.long {
				return &searchMatch{Field: f.name, Snippet: snippet(f.text, t)}
			}
			return &searchMatch{Field: f.name, Snippet: f.text}
		}
	}
	return nil
}

func matchResource(r *resourceDTO, terms []string) *searchMatch {
	if len(terms) == 0 {
		return nil
	}
	fields := resourceFields(r)
	if !allTermsHit(lowerTexts(fields), terms) {
		return nil
	}
	return firstHit(fields, terms)
}

func matchTask(t tasks.Task, terms []string) *searchMatch {
	if len(terms) == 0 {
		return nil
	}
	fields := []searchField{
		{name: "title", text: t.Title},
		{name: "ref", text: taskRef(t)},
		{name: "description", text: t.Description, long: true},
	}
	if !allTermsHit(lowerTexts(fields), terms) {
		return nil
	}
	return firstHit(fields, terms)
}

func taskRef(t tasks.Task) string { return "T" + strconv.FormatInt(t.ID, 10) }

func matchWorktree(w *worktreeSummary, workspaceTitles []string, rs []resourceDTO, terms []string) *searchMatch {
	if len(terms) == 0 {
		return nil
	}
	own := []searchField{
		{name: "branch", text: w.Branch},
		{name: "repo", text: w.Repo},
		{name: "name", text: worktreeBaseName(w.Path)},
	}
	for _, t := range workspaceTitles {
		own = append(own, searchField{name: "workspace", text: t})
	}
	own = append(own, searchField{name: "notes", text: w.NotesSearch, long: true})
	var via []resourceDTO
	if matchWorktreesViaResources {
		via = rs
	}
	texts := lowerTexts(own)
	for i := range via {
		texts = append(texts, lowerTexts(resourceFields(&via[i]))...)
	}
	if !allTermsHit(texts, terms) {
		return nil
	}
	if hit := firstHit(own, terms); hit != nil {
		return hit
	}
	for i := range via {
		r := &via[i]
		if rHit := firstHit(resourceFields(r), terms); rHit != nil {
			return &searchMatch{
				Field: "resource", Snippet: resourceLabel(r), ViaKey: uiShortRef(r.Type, r.ID),
				ViaType: r.Type, ViaID: r.ID, ViaField: rHit.Field,
			}
		}
	}
	return nil
}

// worktreeBaseName is homeWorktree.ts's worktreeName: the last non-empty path
// segment, else the whole path.
func worktreeBaseName(p string) string {
	parts := strings.FieldsFunc(p, func(r rune) bool { return r == '/' })
	if len(parts) == 0 {
		return p
	}
	return parts[len(parts)-1]
}

// rankText: 1 label starts with the first term, 2 contains any term, 3 otherwise.
func rankText(label string, terms []string) int {
	low := strings.ToLower(label)
	if len(terms) > 0 && strings.HasPrefix(low, terms[0]) {
		return 1
	}
	for _, t := range terms {
		if strings.Contains(low, t) {
			return 2
		}
	}
	return 3
}

// rankResource is rankText, with 0 for a term that IS the resource's key or short ref.
func rankResource(r *resourceDTO, terms []string) int {
	keys := []string{strings.ToLower(r.ID), strings.ToLower(uiShortRef(r.Type, r.ID))}
	for _, t := range terms {
		for _, k := range keys {
			if t == k {
				return 0
			}
		}
	}
	return rankText(resourceLabel(r), terms)
}

// rankTask is rankText over the title, with 0 for a term that IS the task's id ("t8").
func rankTask(t tasks.Task, terms []string) int {
	ref := strings.ToLower(taskRef(t))
	for _, term := range terms {
		if term == ref {
			return 0
		}
	}
	return rankText(t.Title, terms)
}
