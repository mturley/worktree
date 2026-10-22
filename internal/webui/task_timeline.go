package webui

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/mturley/worktree/internal/tasks"
	"github.com/mturley/worktree/internal/unread"
)

// taskEventToTimeline renders one of a task's own events as a TimelineEvent,
// so task history and watcher events share one row component and one feed.
// The task detail's activity feed uses it now; Phase 4's feeds reuse it.
//
// The event is attributed to a pseudo-resource ("task", "<id>") titled with
// the task's title. Its id is "task:<event id>", which cannot collide with a
// watcher event id.
func taskEventToTimeline(ev tasks.Event, t tasks.Task) TimelineEvent {
	title := ev.Type
	if f, ok := taskEventTitles[ev.Type]; ok {
		if s := f(ev.Payload, t); s != "" {
			title = s
		}
	}
	return TimelineEvent{
		ID:            "task:" + strconv.FormatInt(ev.ID, 10),
		TS:            ev.TS,
		Source:        "tasks",
		Type:          ev.Type,
		TypeLabel:     taskEventLabels[ev.Type],
		Title:         title,
		Author:        taskEventAuthor(ev),
		ResourceType:  "task",
		ResourceID:    strconv.FormatInt(t.ID, 10),
		ResourceTitle: t.Title,
		Worktrees:     []string{},
		WorktreePaths: []string{},
	}
}

// taskFeedRow converts a feed event for the activity feeds: the converted
// row, with Unread set by the unread rule — an agent's event newer than its
// task's cursor (cursors is unread.Cursors; a missing cursor reads as "", so
// every agent event counts). The user's own events are never unread.
func taskFeedRow(fe tasks.FeedEvent, cursors map[string]string) TimelineEvent {
	te := taskEventToTimeline(fe.Event, tasks.Task{ID: fe.TaskID, Title: fe.TaskTitle})
	te.Unread = fe.Actor == tasks.ActorAgent && fe.TS > cursors[unread.Key("task", te.ResourceID)]
	return te
}

// matchTaskEvent is matchEvent for a converted task event: every term must
// appear in the converted title or the task's title, case-insensitively.
// The match names the first of those fields holding any term, as matchEvent
// does; a task-title match is reported as "resource" (the pseudo-resource the
// row is attributed to), with the task title as its snippet.
func matchTaskEvent(te *TimelineEvent, terms []string) *searchMatch {
	if len(terms) == 0 {
		return nil
	}
	fields := []struct{ name, text string }{{"title", te.Title}, {"resource", te.ResourceTitle}}
	lower := []string{strings.ToLower(fields[0].text), strings.ToLower(fields[1].text)}
	for _, t := range terms {
		if !strings.Contains(lower[0], t) && !strings.Contains(lower[1], t) {
			return nil
		}
	}
	for i, f := range fields {
		for _, t := range terms {
			if strings.Contains(lower[i], t) {
				return &searchMatch{Field: f.name, Snippet: f.text}
			}
		}
	}
	return nil
}

func taskEventAuthor(ev tasks.Event) string {
	if ev.Actor == tasks.ActorAgent {
		if ev.ActorSession != "" {
			return "agent (" + ev.ActorSession + ")"
		}
		return "agent"
	}
	return "you"
}

// quote wraps s in curly quotes, as every task event title names things.
func quote(s string) string { return "“" + s + "”" }

// taskEventPayload is the union of the task event payloads' fields.
type taskEventPayload struct {
	From         string                     `json:"from"`
	To           string                     `json:"to"`
	Changes      map[string]json.RawMessage `json:"changes"`
	Kind         string                     `json:"kind"`
	ResourceType string                     `json:"resource_type"`
	ResourceID   string                     `json:"resource_id"`
	Worktree     string                     `json:"worktree"`
	Focus        bool                       `json:"focus"`
	Text         string                     `json:"text"`
	Key          string                     `json:"key"`
	Title        string                     `json:"title"`
}

func parseTaskPayload(raw json.RawMessage) taskEventPayload {
	var p taskEventPayload
	_ = json.Unmarshal(raw, &p) // a malformed payload renders a generic title
	return p
}

type taskTitleFunc func(raw json.RawMessage, t tasks.Task) string

// taskEventTitles holds one entry per event type in internal/tasks/events.go.
// An unknown type (a newer writer) falls back to the raw type.
var taskEventTitles = map[string]taskTitleFunc{
	tasks.EventTaskCreated: func(_ json.RawMessage, t tasks.Task) string { return "Created " + quote(t.Title) },
	tasks.EventTaskDeleted: func(_ json.RawMessage, t tasks.Task) string { return "Deleted " + quote(t.Title) },
	tasks.EventTaskEdited:  taskEditedTitle,
	tasks.EventTaskStateChanged: func(raw json.RawMessage, t tasks.Task) string {
		p := parseTaskPayload(raw)
		switch tasks.State(p.To) {
		case tasks.StateInProgress:
			return "Started " + quote(t.Title)
		case tasks.StateDone:
			return "Completed " + quote(t.Title)
		case tasks.StateNotStarted:
			if tasks.State(p.From) == tasks.StateDone {
				return "Reopened " + quote(t.Title)
			}
			return "Marked " + quote(t.Title) + " not started"
		}
		return ""
	},
	tasks.EventTaskLinked: func(raw json.RawMessage, _ tasks.Task) string {
		return "Linked " + linkPayloadRef(parseTaskPayload(raw))
	},
	tasks.EventTaskUnlinked: func(raw json.RawMessage, _ tasks.Task) string {
		return "Unlinked " + linkPayloadRef(parseTaskPayload(raw))
	},
	tasks.EventTaskFocusChanged: func(raw json.RawMessage, _ tasks.Task) string {
		p := parseTaskPayload(raw)
		group := "Related"
		if p.Focus {
			group = "Focus"
		}
		return "Moved " + linkPayloadRef(p) + " to " + group
	},
	tasks.EventSubtaskAdded:      subtaskTitle("Added subtask "),
	tasks.EventSubtaskEdited:     subtaskTitle("Edited subtask "),
	tasks.EventSubtaskChecked:    subtaskTitle("Checked "),
	tasks.EventSubtaskUnchecked:  subtaskTitle("Unchecked "),
	tasks.EventSubtaskRemoved:    subtaskTitle("Removed subtask "),
	tasks.EventTaskEventLinked:   eventLinkTitle("Linked event "),
	tasks.EventTaskEventUnlinked: eventLinkTitle("Unlinked event "),
}

// taskEventLabels is the short type label shown beside a row, like a
// watcher event's DisplayName.
var taskEventLabels = map[string]string{
	tasks.EventTaskCreated:       "Created",
	tasks.EventTaskEdited:        "Edited",
	tasks.EventTaskStateChanged:  "State",
	tasks.EventTaskDeleted:       "Deleted",
	tasks.EventTaskLinked:        "Linked",
	tasks.EventTaskUnlinked:      "Unlinked",
	tasks.EventTaskFocusChanged:  "Focus",
	tasks.EventSubtaskAdded:      "Subtask",
	tasks.EventSubtaskEdited:     "Subtask",
	tasks.EventSubtaskChecked:    "Subtask",
	tasks.EventSubtaskUnchecked:  "Subtask",
	tasks.EventSubtaskRemoved:    "Subtask",
	tasks.EventTaskEventLinked:   "Event linked",
	tasks.EventTaskEventUnlinked: "Event unlinked",
}

func subtaskTitle(prefix string) taskTitleFunc {
	return func(raw json.RawMessage, _ tasks.Task) string {
		return prefix + quote(parseTaskPayload(raw).Text)
	}
}

func eventLinkTitle(prefix string) taskTitleFunc {
	return func(raw json.RawMessage, _ tasks.Task) string {
		p := parseTaskPayload(raw)
		name := p.Title
		if name == "" {
			name = p.Key
		}
		return prefix + quote(name)
	}
}

// linkPayloadRef names a link from a task_linked/unlinked/focus_changed
// payload: a resource's short ref, or "worktree <basename>".
func linkPayloadRef(p taskEventPayload) string {
	if tasks.LinkKind(p.Kind) == tasks.LinkWorktree {
		return "worktree " + filepath.Base(p.Worktree)
	}
	return shortResourceRef(p.ResourceType, p.ResourceID)
}

// taskEditFields is the order task_edited changes are described in; the
// payload is a map, so the order has to come from somewhere fixed.
var taskEditFields = []string{"title", "description", "priority", "starred", "due"}

func taskEditedTitle(raw json.RawMessage, _ tasks.Task) string {
	p := parseTaskPayload(raw)
	var parts []string
	for _, f := range taskEditFields {
		c, ok := p.Changes[f]
		if !ok {
			continue
		}
		var ch struct{ From, To any }
		_ = json.Unmarshal(c, &ch)
		from, to := fmt.Sprint(ch.From), fmt.Sprint(ch.To)
		switch f {
		case "title":
			parts = append(parts, "renamed "+quote(from)+" to "+quote(to))
		case "description":
			parts = append(parts, "edited the description")
		case "priority":
			if to == string(tasks.PriorityNone) || to == "" {
				parts = append(parts, "cleared the priority")
			} else {
				parts = append(parts, "set priority to "+to)
			}
		case "starred":
			if to == "true" {
				parts = append(parts, "starred")
			} else {
				parts = append(parts, "unstarred")
			}
		case "due":
			if to == "" || ch.To == nil {
				parts = append(parts, "cleared the due date")
			} else {
				parts = append(parts, "set the due date to "+to)
			}
		}
	}
	if len(parts) == 0 {
		return "Edited"
	}
	return capitalize(strings.Join(parts, "; "))
}

func capitalize(s string) string {
	r, n := utf8.DecodeRuneInString(s)
	if n == 0 {
		return s
	}
	return string(unicode.ToUpper(r)) + s[n:]
}

// shortResourceRef is a resource's compact name: "#123" for a PR, the key
// for a Jira issue, "Slack thread" for a thread, else the id (a link's id is
// its URL).
func shortResourceRef(typ, id string) string {
	switch typ {
	case "pr":
		if i := strings.LastIndex(id, "#"); i >= 0 {
			return id[i:]
		}
	case "slack":
		return "Slack thread"
	}
	return id
}
