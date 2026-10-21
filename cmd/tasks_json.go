package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/mturley/worktree/internal/tasks"
)

// taskJSON is the JSON shape of a task. It is a contract: agent tooling
// binds to these snake_case keys, so change it only additively.
type taskJSON struct {
	ID                string        `json:"id"`
	Title             string        `json:"title"`
	Description       string        `json:"description"`
	State             string        `json:"state"`
	Priority          string        `json:"priority"`
	Starred           bool          `json:"starred"`
	Due               string        `json:"due,omitempty"`
	CreatedAt         string        `json:"created_at"`
	UpdatedAt         string        `json:"updated_at"`
	StartedAt         string        `json:"started_at,omitempty"`
	CompletedAt       string        `json:"completed_at,omitempty"`
	Archived          bool          `json:"archived"`
	Links             []linkJSON    `json:"links"`
	ImplicitWorktrees []string      `json:"implicit_worktrees"`
	Subtasks          []subtaskJSON `json:"subtasks"`
	Events            []eventJSON   `json:"events,omitempty"` // show only
}

type linkJSON struct {
	Kind         string `json:"kind"`
	ResourceType string `json:"resource_type,omitempty"`
	ResourceID   string `json:"resource_id,omitempty"`
	Worktree     string `json:"worktree,omitempty"`
	Focus        bool   `json:"focus"`
	Archived     bool   `json:"archived"`
}

type subtaskJSON struct {
	ID      int64  `json:"id"`
	Text    string `json:"text"`
	Checked bool   `json:"checked"`
}

type eventJSON struct {
	TS           string          `json:"ts"`
	Type         string          `json:"type"`
	Actor        string          `json:"actor"`
	ActorSession string          `json:"actor_session,omitempty"`
	Payload      json.RawMessage `json:"payload"`
}

// toTaskJSON converts a task, guaranteeing [] (never null) for every list.
func toTaskJSON(t tasks.Task) taskJSON {
	out := taskJSON{
		ID: formatTaskID(t.ID), Title: t.Title, Description: t.Description,
		State: string(t.State), Priority: string(t.Priority), Starred: t.Starred, Due: t.Due,
		CreatedAt: t.CreatedAt, UpdatedAt: t.UpdatedAt, StartedAt: t.StartedAt, CompletedAt: t.CompletedAt,
		Archived:          t.Archived,
		Links:             make([]linkJSON, 0, len(t.Links)),
		ImplicitWorktrees: make([]string, 0, len(t.Implicit)),
		Subtasks:          make([]subtaskJSON, 0, len(t.Subtasks)),
	}
	for _, l := range t.Links {
		out.Links = append(out.Links, linkJSON{
			Kind: string(l.Kind), ResourceType: l.ResourceType, ResourceID: l.ResourceID,
			Worktree: l.Worktree, Focus: l.Primary, Archived: l.Archived,
		})
	}
	out.ImplicitWorktrees = append(out.ImplicitWorktrees, t.Implicit...)
	for _, s := range t.Subtasks {
		out.Subtasks = append(out.Subtasks, subtaskJSON{ID: s.ID, Text: s.Text, Checked: s.Checked})
	}
	return out
}

func toEventsJSON(es []tasks.Event) []eventJSON {
	out := make([]eventJSON, 0, len(es))
	for _, e := range es {
		payload := e.Payload
		if len(payload) == 0 {
			payload = json.RawMessage("{}")
		}
		out = append(out, eventJSON{TS: e.TS, Type: e.Type, Actor: e.Actor, ActorSession: e.ActorSession, Payload: payload})
	}
	return out
}

func writeJSON(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(w, string(b))
	return err
}

var stateGlyphs = map[tasks.State]string{
	tasks.StateNotStarted: "☐",
	tasks.StateInProgress: "◩",
	tasks.StateDone:       "☑",
}

var priorityMarks = map[tasks.Priority]string{
	tasks.PriorityHigh:   "!!!",
	tasks.PriorityMedium: "!!",
	tasks.PriorityLow:    "!",
}

// linkLabel renders a link for the list chip: type:id, or wt:<base name>.
func linkLabel(t tasks.LinkTarget) string {
	if t.Kind == tasks.LinkWorktree {
		return "wt:" + filepath.Base(t.Worktree)
	}
	return t.ResourceType + ":" + t.ResourceID
}

// taskLine is the human-readable list line:
//
//	T42 ◩ ★ !!! Title  [due 2026-10-24] [2/5] [pr:o/r#1 +2]
//
// The star and priority columns keep their width when empty so titles line up.
func taskLine(t tasks.Task) string {
	star := " "
	if t.Starred {
		star = "★"
	}
	glyph := stateGlyphs[t.State]
	if glyph == "" {
		glyph = "?"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s %s %-3s %s", formatTaskID(t.ID), glyph, star, priorityMarks[t.Priority], t.Title)

	var chips []string
	if t.Due != "" {
		chips = append(chips, "[due "+t.Due+"]")
	}
	if n := len(t.Subtasks); n > 0 {
		done := 0
		for _, s := range t.Subtasks {
			if s.Checked {
				done++
			}
		}
		chips = append(chips, fmt.Sprintf("[%d/%d]", done, n))
	}
	if n := len(t.Links); n > 0 {
		first := -1
		for i, l := range t.Links {
			if l.Primary {
				first = i
				break
			}
		}
		switch {
		case first < 0:
			chips = append(chips, fmt.Sprintf("[%d linked]", n))
		case n == 1:
			chips = append(chips, "["+linkLabel(t.Links[first].LinkTarget)+"]")
		default:
			chips = append(chips, fmt.Sprintf("[%s +%d]", linkLabel(t.Links[first].LinkTarget), n-1))
		}
	}
	if len(chips) > 0 {
		b.WriteString("  ")
		b.WriteString(strings.Join(chips, " "))
	}
	return b.String()
}

// writeTaskDetail renders `tasks show` for a human.
func writeTaskDetail(w io.Writer, t tasks.Task, events []tasks.Event) {
	fmt.Fprintln(w, taskLine(t))
	fmt.Fprintf(w, "  state:    %s\n", t.State)
	fmt.Fprintf(w, "  priority: %s\n", t.Priority)
	if t.Due != "" {
		fmt.Fprintf(w, "  due:      %s\n", t.Due)
	}
	fmt.Fprintf(w, "  created:  %s\n", t.CreatedAt)
	fmt.Fprintf(w, "  updated:  %s\n", t.UpdatedAt)
	if t.StartedAt != "" {
		fmt.Fprintf(w, "  started:  %s\n", t.StartedAt)
	}
	if t.CompletedAt != "" {
		fmt.Fprintf(w, "  done:     %s\n", t.CompletedAt)
	}
	if t.Archived {
		fmt.Fprintln(w, "  archived: yes")
	}
	if t.Description != "" {
		fmt.Fprintln(w, "\nDescription:")
		for _, line := range strings.Split(t.Description, "\n") {
			fmt.Fprintln(w, "  "+line)
		}
	}
	writeLinkGroup := func(title string, focus bool) {
		var lines []string
		for _, l := range t.Links {
			if l.Primary != focus {
				continue
			}
			label := l.ResourceType + ":" + l.ResourceID
			if l.Kind == tasks.LinkWorktree {
				label = "wt:" + l.Worktree
			}
			if l.Archived {
				label += " (archived)"
			}
			lines = append(lines, label)
		}
		if len(lines) == 0 {
			return
		}
		fmt.Fprintf(w, "\n%s:\n", title)
		for _, l := range lines {
			fmt.Fprintln(w, "  "+l)
		}
	}
	writeLinkGroup("Focus", true)
	writeLinkGroup("Related", false)
	if len(t.Implicit) > 0 {
		fmt.Fprintln(w, "\nImplicit worktrees:")
		for _, p := range t.Implicit {
			fmt.Fprintln(w, "  "+p)
		}
	}
	if len(t.Subtasks) > 0 {
		fmt.Fprintln(w, "\nSubtasks:")
		for _, s := range t.Subtasks {
			box := "[ ]"
			if s.Checked {
				box = "[x]"
			}
			fmt.Fprintf(w, "  %s (#%d) %s\n", box, s.ID, s.Text)
		}
	}
	if len(events) > 0 {
		fmt.Fprintln(w, "\nHistory:")
		for _, e := range events {
			who := e.Actor
			if e.ActorSession != "" {
				who += "/" + e.ActorSession
			}
			fmt.Fprintf(w, "  %s  %-20s %s %s\n", e.TS, e.Type, who, string(e.Payload))
		}
	}
}
