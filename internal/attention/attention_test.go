package attention

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

var testNow = time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)

func rank(n int) *int { return &n }

func build(self Self, rs ...Resource) []Item {
	return Build(testNow, self, rs, nil, nil)
}

// signalsOf builds one resource and returns its signals; nil when dropped.
func signalsOf(t *testing.T, self Self, r Resource) []string {
	t.Helper()
	items := build(self, r)
	if len(items) == 0 {
		return nil
	}
	if len(items) > 1 {
		t.Fatalf("got %d items", len(items))
	}
	return items[0].Signals
}

func TestSignals(t *testing.T) {
	slack := func(body string) Resource {
		return Resource{Type: "slack", ID: "C1:1", UnreadCount: 1, Unread: []Event{{ID: "e", Source: "slack", Body: body}}}
	}
	self := Self{SlackID: "U1"}
	cases := []struct {
		name   string
		r      Resource
		signal string
		want   bool
	}{
		{"review requested", Resource{Type: "pr", ID: "1", State: "OPEN", ReviewRequestedFromMe: true}, "review_requested", true},
		{"review requested, lowercase state", Resource{Type: "pr", ID: "1", State: "open", ReviewRequestedFromMe: true}, "review_requested", true},
		{"review requested on a merged PR", Resource{Type: "pr", ID: "1", State: "MERGED", ReviewRequestedFromMe: true}, "review_requested", false},
		{"review not requested", Resource{Type: "pr", ID: "1", State: "OPEN", UnreadCount: 1}, "review_requested", false},

		{"changes requested", Resource{Type: "pr", ID: "1", State: "OPEN", Mine: true, ReviewDecision: "CHANGES_REQUESTED"}, "changes_requested", true},
		{"changes requested, not mine", Resource{Type: "pr", ID: "1", State: "OPEN", ReviewDecision: "CHANGES_REQUESTED", UnreadCount: 1}, "changes_requested", false},
		{"changes requested, closed", Resource{Type: "pr", ID: "1", State: "CLOSED", Mine: true, ReviewDecision: "CHANGES_REQUESTED", UnreadCount: 1}, "changes_requested", false},
		{"approved", Resource{Type: "pr", ID: "1", State: "OPEN", Mine: true, ReviewDecision: "APPROVED", UnreadCount: 1}, "changes_requested", false},

		{"ci failing", Resource{Type: "pr", ID: "1", State: "OPEN", Mine: true, CIStatus: "FAILURE"}, "ci_failing", true},
		{"ci failing, not mine", Resource{Type: "pr", ID: "1", State: "OPEN", CIStatus: "FAILURE", UnreadCount: 1}, "ci_failing", false},
		{"ci failing, merged", Resource{Type: "pr", ID: "1", State: "MERGED", Mine: true, CIStatus: "FAILURE", UnreadCount: 1}, "ci_failing", false},
		{"needs rebase", Resource{Type: "pr", ID: "1", State: "OPEN", Mine: true, Mergeable: "CONFLICTING"}, "needs_rebase", true},
		{"needs rebase, not mine", Resource{Type: "pr", ID: "1", State: "OPEN", Mergeable: "CONFLICTING", UnreadCount: 1}, "needs_rebase", false},
		{"needs rebase, merged", Resource{Type: "pr", ID: "1", State: "MERGED", Mine: true, Mergeable: "CONFLICTING", UnreadCount: 1}, "needs_rebase", false},
		{"mergeable", Resource{Type: "pr", ID: "1", State: "OPEN", Mine: true, Mergeable: "MERGEABLE", UnreadCount: 1}, "needs_rebase", false},
		{"mergeable unknown", Resource{Type: "pr", ID: "1", State: "OPEN", Mine: true, Mergeable: "", UnreadCount: 1}, "needs_rebase", false},
		{"ci passing", Resource{Type: "pr", ID: "1", State: "OPEN", Mine: true, CIStatus: "SUCCESS", UnreadCount: 1}, "ci_failing", false},

		{"assigned with unread", Resource{Type: "jira", ID: "J-1", AssignedToMe: true, UnreadCount: 1}, "assigned_to_you", true},
		{"assigned, nothing unread", Resource{Type: "jira", ID: "J-1", AssignedToMe: true}, "assigned_to_you", false},
		{"unread, not assigned", Resource{Type: "jira", ID: "J-1", UnreadCount: 1}, "assigned_to_you", false},

		{"mentioned", slack("hey <@U1> look"), "mentioned", true},
		{"someone else mentioned", slack("hey <@U2> look"), "mentioned", false},
		{"id without mention syntax", slack("U1 did this"), "mentioned", false},

		{"stale draft", Resource{Type: "pr", ID: "1", State: "OPEN", DraftComments: 2}, "stale_draft", true},
		{"stale draft on someone else's PR", Resource{Type: "pr", ID: "1", State: "OPEN", Mine: false, DraftComments: 1}, "stale_draft", true},
		{"no drafts", Resource{Type: "pr", ID: "1", State: "OPEN", UnreadCount: 1}, "stale_draft", false},
		{"drafts on a merged PR", Resource{Type: "pr", ID: "1", State: "MERGED", DraftComments: 2, UnreadCount: 1}, "stale_draft", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := signalsOf(t, self, c.r)
			if slices.Contains(got, c.signal) != c.want {
				t.Fatalf("signals = %v, want %s = %v", got, c.signal, c.want)
			}
		})
	}
}

func TestMentionNeedsSlackSourceAndSelfID(t *testing.T) {
	jira := Resource{Type: "jira", ID: "J", UnreadCount: 1, Unread: []Event{{Source: "jira", Body: "<@U1>"}}}
	if got := signalsOf(t, Self{SlackID: "U1"}, jira); slices.Contains(got, "mentioned") {
		t.Fatalf("a Jira body must not count: %v", got)
	}
	// No resolved Slack ID: "<@>" must not match anything.
	empty := Resource{Type: "slack", ID: "C:1", UnreadCount: 1, Unread: []Event{{Source: "slack", Body: "odd <@> text"}}}
	if got := signalsOf(t, Self{}, empty); slices.Contains(got, "mentioned") {
		t.Fatalf("no self id must not match: %v", got)
	}
}

// A mention in an older event than the five shown, or beyond the truncation
// point of a long body, still counts.
func TestMentionMatchesEveryUnreadFullBody(t *testing.T) {
	unread := []Event{}
	for range 6 {
		unread = append(unread, Event{Source: "slack", Body: "nothing here"})
	}
	unread = append(unread, Event{Source: "slack", Body: strings.Repeat("x", 600) + " <@U1>"})
	r := Resource{Type: "slack", ID: "C:1", UnreadCount: len(unread), Unread: unread}
	if got := signalsOf(t, Self{SlackID: "U1"}, r); !slices.Contains(got, "mentioned") {
		t.Fatalf("signals = %v", got)
	}

	long := Resource{Type: "slack", ID: "C:2", UnreadCount: 1,
		Unread: []Event{{Source: "slack", Body: strings.Repeat("y", 600) + " <@U1>"}}}
	items := build(Self{SlackID: "U1"}, long)
	if !slices.Contains(items[0].Signals, "mentioned") {
		t.Fatalf("signals = %v", items[0].Signals)
	}
	if strings.Contains(items[0].Events[0].Body, "<@U1>") {
		t.Fatal("the mention was past the cut, but the body kept it")
	}
}

func TestBodiesTruncatedTo500Runes(t *testing.T) {
	cases := []struct {
		name, body, want string
	}{
		{"short", "hello", "hello"},
		{"exactly 500", strings.Repeat("é", 500), strings.Repeat("é", 500)},
		{"501 multibyte runes", strings.Repeat("é", 501), strings.Repeat("é", 500) + "…"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := []Event{{Source: "github", Body: c.body}}
			items := build(Self{}, Resource{Type: "pr", ID: "1", UnreadCount: 1, Unread: in})
			got := items[0].Events[0].Body
			if got != c.want {
				t.Fatalf("got %d runes", utf8.RuneCountInString(got))
			}
			if in[0].Body != c.body {
				t.Fatal("Build changed its input")
			}
		})
	}
}

func TestMergedPRWithUnreadKeptWithoutPRSignals(t *testing.T) {
	r := Resource{Type: "pr", ID: "1", State: "MERGED", Mine: true, CIStatus: "FAILURE",
		ReviewDecision: "CHANGES_REQUESTED", DraftComments: 1, ReviewRequestedFromMe: true, UnreadCount: 1,
		Unread: []Event{{ID: "e1", Source: "github"}}}
	items := build(Self{}, r)
	if len(items) != 1 || len(items[0].Signals) != 0 || len(items[0].Events) != 1 {
		t.Fatalf("items = %+v", items)
	}
	r.UnreadCount, r.Unread = 0, nil
	if items := build(Self{}, r); len(items) != 0 {
		t.Fatalf("a merged PR with nothing unread must be dropped: %+v", items)
	}
}

// Review Focus 2: a resource no poll has reached has an empty state.
func TestNeverPolledResourceNoSignals(t *testing.T) {
	r := Resource{Type: "pr", ID: "1"}
	if items := build(Self{}, r); len(items) != 0 {
		t.Fatalf("dropped expected: %+v", items)
	}
	r.UnreadCount = 2
	items := build(Self{}, r)
	if len(items) != 1 || len(items[0].Signals) != 0 {
		t.Fatalf("items = %+v", items)
	}
}

func TestSignalOnlyResourceKept(t *testing.T) {
	items := build(Self{}, Resource{Type: "pr", ID: "1", State: "OPEN", ReviewRequestedFromMe: true})
	if len(items) != 1 || items[0].Kind != "resource" || items[0].Resource.ID != "1" {
		t.Fatalf("items = %+v", items)
	}
}

func TestEventsCappedAtFive(t *testing.T) {
	unread := []Event{}
	for _, id := range []string{"e1", "e2", "e3", "e4", "e5", "e6", "e7"} {
		unread = append(unread, Event{ID: id, Source: "github"})
	}
	items := build(Self{}, Resource{Type: "pr", ID: "1", UnreadCount: 7, Unread: unread})
	got := []string{}
	for _, e := range items[0].Events {
		got = append(got, e.ID)
	}
	if want := []string{"e1", "e2", "e3", "e4", "e5"}; !slices.Equal(got, want) {
		t.Fatalf("events = %v, want newest five %v", got, want)
	}
	if items[0].Resource.UnreadCount != 7 {
		t.Fatalf("unread count = %d", items[0].Resource.UnreadCount)
	}
}

func TestTaskItemDueSoon(t *testing.T) {
	cases := []struct {
		due  string
		want bool
	}{
		{"2026-11-01", true},  // overdue
		{"2026-11-02", true},  // today
		{"2026-11-03", true},  // tomorrow
		{"2026-11-05", true},  // three days
		{"2026-11-06", false}, // four days
		{"2026-11-07", false}, // five days
		{"", false},
		{"soon", false},
	}
	for _, c := range cases {
		items := Build(testNow, Self{}, nil, []OpenTask{{Task: Task{ID: "1", Due: c.due}}}, nil)
		if got := len(items) == 1; got != c.want {
			t.Errorf("due %q: item = %v, want %v", c.due, got, c.want)
		}
		if c.want && (items[0].Kind != "task" || !slices.Equal(items[0].Signals, []string{"task_due_soon"})) {
			t.Errorf("due %q: %+v", c.due, items[0])
		}
	}
}

// "Now" is the caller's local date, not UTC's.
func TestTaskDueUsesNowsLocation(t *testing.T) {
	zone := time.FixedZone("west", -8*3600)
	// Still 2026-11-01 here, though already 2026-11-02 in UTC.
	now := time.Date(2026, 11, 1, 23, 0, 0, 0, zone)
	for due, want := range map[string]bool{"2026-11-04": true, "2026-11-05": false} {
		items := Build(now, Self{}, nil, []OpenTask{{Task: Task{ID: "1", Due: due}}}, nil)
		if got := len(items) == 1; got != want {
			t.Errorf("due %s: item = %v, want %v", due, got, want)
		}
	}
}

func TestTaskItemBlockerResolved(t *testing.T) {
	items := Build(testNow, Self{}, nil, []OpenTask{{Task: Task{ID: "1"}, UnblockedUnread: true}}, nil)
	if len(items) != 1 || !slices.Equal(items[0].Signals, []string{"blocker_resolved"}) {
		t.Fatalf("items = %+v", items)
	}
	if items := Build(testNow, Self{}, nil, []OpenTask{{Task: Task{ID: "1"}}}, nil); len(items) != 0 {
		t.Fatalf("an unremarkable task must be dropped: %+v", items)
	}
	both := []OpenTask{{Task: Task{ID: "1", Due: "2026-11-02"}, UnblockedUnread: true}}
	items = Build(testNow, Self{}, nil, both, nil)
	if !slices.Equal(items[0].Signals, []string{"task_due_soon", "blocker_resolved"}) {
		t.Fatalf("signals = %v", items[0].Signals)
	}
}

func TestTaskRankMapping(t *testing.T) {
	want := map[string]*int{"high": rank(1), "medium": rank(2), "low": rank(3), "none": nil}
	for p, w := range want {
		items := Build(testNow, Self{}, nil, []OpenTask{{Task: Task{ID: "1", Priority: p}, UnblockedUnread: true}}, nil)
		got := items[0].Rank
		if (got == nil) != (w == nil) || (got != nil && *got != *w) {
			t.Errorf("%s: rank = %v", p, got)
		}
	}
}

func ids(items []Item) []string {
	out := []string{}
	for _, it := range items {
		if it.Kind == "task" {
			out = append(out, "task:"+it.Task.ID)
		} else {
			out = append(out, it.Resource.ID)
		}
	}
	return out
}

func TestOrderPriorityThenSignalsThenRecency(t *testing.T) {
	const older, newer = "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"
	rs := []Resource{
		{Type: "pr", ID: "no-rank", State: "OPEN", Mine: true, CIStatus: "FAILURE", ReviewDecision: "CHANGES_REQUESTED", DraftComments: 1},
		{Type: "jira", ID: "rank2-new", PriorityRank: rank(2), UnreadCount: 1, NewestUnreadTS: newer},
		{Type: "jira", ID: "rank2-old", PriorityRank: rank(2), UnreadCount: 1, NewestUnreadTS: older},
		{Type: "jira", ID: "rank2-signal", PriorityRank: rank(2), AssignedToMe: true, UnreadCount: 1, NewestUnreadTS: older},
		// Rank 0 is the highest, a real value.
		{Type: "jira", ID: "rank0", PriorityRank: rank(0), UnreadCount: 1, NewestUnreadTS: older},
	}
	got := ids(Build(testNow, Self{}, rs, nil, nil))
	want := []string{"rank0", "rank2-signal", "rank2-new", "rank2-old", "no-rank"}
	if !slices.Equal(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
}

// Tasks and resources share one order; a task's recency is its updated_at.
func TestOrderMixesTasksAndResources(t *testing.T) {
	rs := []Resource{
		{Type: "jira", ID: "J", PriorityRank: rank(1), AssignedToMe: true, UnreadCount: 1, NewestUnreadTS: "2026-11-01T12:00:00Z"},
		{Type: "pr", ID: "P", UnreadCount: 1, NewestUnreadTS: "2026-11-02T00:00:00Z"},
	}
	ts := []OpenTask{
		{Task: Task{ID: "1", Priority: "high"}, UnblockedUnread: true, UpdatedAt: "2026-11-02T00:00:00Z"},
		{Task: Task{ID: "2", Priority: "high"}, UnblockedUnread: true, UpdatedAt: "2026-10-01T00:00:00Z"},
		{Task: Task{ID: "3", Priority: "low"}, UnblockedUnread: true},
	}
	got := ids(Build(testNow, Self{}, rs, ts, nil))
	want := []string{"task:1", "J", "task:2", "task:3", "P"}
	if !slices.Equal(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
}

func TestOrderTiesBreakOnKindTypeID(t *testing.T) {
	rs := []Resource{
		{Type: "slack", ID: "a", UnreadCount: 1},
		{Type: "pr", ID: "b", UnreadCount: 1},
		{Type: "pr", ID: "a", UnreadCount: 1},
	}
	ts := []OpenTask{{Task: Task{ID: "z"}, UnblockedUnread: true}}
	items := Build(testNow, Self{}, rs, ts, nil)
	got := []string{}
	for _, it := range items {
		if it.Kind == "task" {
			got = append(got, "task")
		} else {
			got = append(got, it.Resource.Type+":"+it.Resource.ID)
		}
	}
	// The task has one signal, so it leads; the rest tie on everything else.
	if want := []string{"task", "pr:a", "pr:b", "slack:a"}; !slices.Equal(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
}

// Timestamps are compared as times, not text: an offset can reorder them.
func TestOrderComparesTimesNotText(t *testing.T) {
	rs := []Resource{
		{Type: "pr", ID: "earlier", UnreadCount: 1, NewestUnreadTS: "2026-11-02T01:00:00+02:00"}, // 2026-11-01T23:00Z
		{Type: "pr", ID: "later", UnreadCount: 1, NewestUnreadTS: "2026-11-02T00:00:00Z"},
	}
	if got := ids(Build(testNow, Self{}, rs, nil, nil)); got[0] != "later" {
		t.Fatalf("order = %v", got)
	}
}

func TestPRInheritsLinkedJiraRank(t *testing.T) {
	rs := []Resource{
		{Type: "pr", ID: "linked", UnreadCount: 1},
		{Type: "pr", ID: "plain", UnreadCount: 1},
		{Type: "jira", ID: "J", PriorityRank: rank(2), UnreadCount: 1},
	}
	items := Build(testNow, Self{}, rs, nil, map[string][]int{"pr:linked": {3, 1, 5}})
	got := ids(items)
	if want := []string{"linked", "J", "plain"}; !slices.Equal(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
	if items[0].Rank == nil || *items[0].Rank != 1 {
		t.Fatalf("effective rank = %v, want the minimum, 1", items[0].Rank)
	}
	if items[0].Resource.PriorityRank != nil {
		t.Fatal("the PR's own rank must stay absent")
	}
	if items[2].Rank != nil {
		t.Fatalf("plain PR rank = %v", *items[2].Rank)
	}
	// Only a PR inherits.
	jira := Build(testNow, Self{}, []Resource{{Type: "jira", ID: "X", UnreadCount: 1}}, nil, map[string][]int{"jira:X": {1}, "pr:X": {1}})
	if jira[0].Rank != nil {
		t.Fatalf("jira rank = %v", *jira[0].Rank)
	}
}

func TestSignalsInFixedOrder(t *testing.T) {
	r := Resource{Type: "pr", ID: "1", State: "OPEN", Mine: true, ReviewRequestedFromMe: true,
		ReviewDecision: "CHANGES_REQUESTED", CIStatus: "FAILURE", Mergeable: "CONFLICTING", AssignedToMe: true, UnreadCount: 1,
		DraftComments: 1, Unread: []Event{{Source: "slack", Body: "<@U1>"}}}
	got := signalsOf(t, Self{SlackID: "U1"}, r)
	want := []string{"review_requested", "changes_requested", "ci_failing", "needs_rebase", "assigned_to_you", "mentioned", "stale_draft"}
	if !slices.Equal(got, want) {
		t.Fatalf("signals = %v, want %v", got, want)
	}
}

func TestBuildEmptyIsNotNil(t *testing.T) {
	if got := Build(testNow, Self{}, nil, nil, nil); got == nil || len(got) != 0 {
		t.Fatalf("got %#v", got)
	}
}

// Every field is snake_case, the booleans stay visible when false, the lists
// are [] rather than null, and the full-body input list is not output.
func TestJSONShape(t *testing.T) {
	items := Build(testNow, Self{},
		[]Resource{{Type: "jira", ID: "J", UnreadCount: 1, PriorityRank: rank(0)}},
		[]OpenTask{{Task: Task{ID: "1", Title: "t", State: "not_started", Priority: "none"}, UnblockedUnread: true, UpdatedAt: "2026-11-01T00:00:00Z"}},
		nil)
	b, err := json.Marshal(items)
	if err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("items: %s", b)
	}
	for _, it := range got {
		if sig, ok := it["signals"].([]any); !ok || sig == nil {
			t.Errorf("signals not an array: %s", b)
		}
		if ev, ok := it["events"].([]any); !ok || ev == nil {
			t.Errorf("events not an array: %s", b)
		}
	}
	var res, task map[string]any
	for _, it := range got {
		if it["kind"] == "resource" {
			res = it["resource"].(map[string]any)
			if it["priority_rank"] != float64(0) {
				t.Errorf("rank 0 was dropped: %s", b)
			}
		} else {
			task = it["task"].(map[string]any)
		}
	}
	for _, k := range []string{"type", "id", "unread_count", "mine", "assigned_to_me", "review_requested_from_me", "draft_comments", "priority_rank"} {
		if _, ok := res[k]; !ok {
			t.Errorf("resource lacks %q: %s", k, b)
		}
	}
	for _, k := range []string{"worktrees", "tasks"} {
		if v, ok := res[k].([]any); !ok || v == nil {
			t.Errorf("resource %s not an array: %s", k, b)
		}
	}
	if _, ok := res["unread"]; ok {
		t.Errorf("the input list leaked: %s", b)
	}
	for _, k := range []string{"id", "title", "state", "priority", "unblocked_unread", "updated_at"} {
		if _, ok := task[k]; !ok {
			t.Errorf("task lacks %q: %s", k, b)
		}
	}
	if v, ok := task["worktrees"].([]any); !ok || v == nil {
		t.Errorf("task worktrees not an array: %s", b)
	}
	for k := range task {
		if k != strings.ToLower(k) {
			t.Errorf("task key %q is not snake_case", k)
		}
	}
	for k := range res {
		if k != strings.ToLower(k) {
			t.Errorf("resource key %q is not snake_case", k)
		}
	}
}
