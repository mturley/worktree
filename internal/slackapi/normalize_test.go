// internal/slackapi/normalize_test.go
package slackapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func loadFixture(t *testing.T) RepliesResponse {
	t.Helper()
	data, err := os.ReadFile("testdata/replies.json")
	if err != nil {
		t.Fatal(err)
	}
	var r RepliesResponse
	if err := json.Unmarshal(data, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestNormalizeThreadParent(t *testing.T) {
	raw := loadFixture(t)
	th := NormalizeThread("C000000001", "1700000000.000001", raw)
	if len(th.Messages) != 5 {
		t.Fatalf("messages = %d, want 5", len(th.Messages))
	}
	p := th.Messages[0]
	if p.TS != "1700000000.000001" {
		t.Fatalf("parent ts = %s", p.TS)
	}
	if th.LastRead != "1700000000.000003" {
		t.Fatalf("last_read = %s", th.LastRead)
	}
	// Parent has a rich_text section block with a user mention + emoji.
	if len(p.Blocks) != 1 || p.Blocks[0].Type != "section" {
		t.Fatalf("expected single section block, got %+v", p.Blocks)
	}
	var sawUser, sawEmoji bool
	for _, e := range p.Blocks[0].Elements {
		if e.Type == "user" && e.UserID == "U000000009" {
			sawUser = true
		}
		if e.Type == "emoji" && e.Name == "green_ball" {
			sawEmoji = true
		}
	}
	if !sawUser || !sawEmoji {
		t.Fatalf("expected user+emoji elements, got %+v", p.Blocks[0].Elements)
	}
	if len(p.Reactions) != 1 || p.Reactions[0].Name != "agree+1" || p.Reactions[0].Count != 2 {
		t.Fatalf("reactions = %+v", p.Reactions)
	}
}

func TestNormalizeThreadRichTextGroups(t *testing.T) {
	raw := loadFixture(t)
	th := NormalizeThread("C000000001", "1700000000.000001", raw)
	if len(th.Messages) != 5 {
		t.Fatalf("messages = %d, want 5", len(th.Messages))
	}
	m := th.Messages[4]
	if len(m.Blocks) != 4 {
		t.Fatalf("blocks = %d, want 4 (section, list, quote, preformatted); got %+v", len(m.Blocks), m.Blocks)
	}

	section := m.Blocks[0]
	if section.Type != "section" {
		t.Fatalf("block[0].Type = %q, want section", section.Type)
	}

	list := m.Blocks[1]
	if list.Type != "list" {
		t.Fatalf("block[1].Type = %q, want list", list.Type)
	}
	if list.Style != "bullet" {
		t.Fatalf("list.Style = %q, want bullet", list.Style)
	}
	if len(list.Items) != 2 {
		t.Fatalf("list.Items = %d, want 2", len(list.Items))
	}
	// First item: mentions a user, references a custom emoji, and contains a
	// link whose URL must survive the nested parse.
	var sawUser, sawEmoji, sawLink bool
	for _, e := range list.Items[0] {
		switch {
		case e.Type == "user" && e.UserID == "U000000010":
			sawUser = true
		case e.Type == "emoji" && e.Name == "party_parrot":
			sawEmoji = true
		case e.Type == "link" && e.URL == "https://example.com/plan":
			sawLink = true
		}
	}
	if !sawUser || !sawEmoji || !sawLink {
		t.Fatalf("expected user+emoji+link in first list item, got %+v", list.Items[0])
	}
	if len(list.Items[1]) != 1 || list.Items[1][0].Text != "ship it" {
		t.Fatalf("second list item = %+v, want single text %q", list.Items[1], "ship it")
	}
	if !list.Items[1][0].Style.Strike {
		t.Fatalf("second list item Style.Strike = false, want true (fixture sets style.strike)")
	}

	quote := m.Blocks[2]
	if quote.Type != "quote" {
		t.Fatalf("block[2].Type = %q, want quote", quote.Type)
	}
	if len(quote.Elements) != 1 || quote.Elements[0].Text != "quoted status update" {
		t.Fatalf("quote elements = %+v", quote.Elements)
	}

	pre := m.Blocks[3]
	if pre.Type != "preformatted" {
		t.Fatalf("block[3].Type = %q, want preformatted", pre.Type)
	}
	if len(pre.Elements) != 1 || pre.Elements[0].Text != "code block line" {
		t.Fatalf("preformatted elements = %+v", pre.Elements)
	}
}

func TestNormalizeThreadCapturesFiles(t *testing.T) {
	raw := loadFixture(t)
	th := NormalizeThread("C0EXAMPLE1", "1700000000.000001", raw)
	var withFiles *Message
	for i := range th.Messages {
		if len(th.Messages[i].Files) > 0 {
			withFiles = &th.Messages[i]
			break
		}
	}
	if withFiles == nil {
		t.Fatal("expected a message with files")
	}
	if len(withFiles.Files) != 2 {
		t.Fatalf("files=%d, want 2", len(withFiles.Files))
	}
	img := withFiles.Files[0]
	if !img.IsImage || img.Mimetype != "image/png" {
		t.Fatalf("img=%+v", img)
	}
	if img.Thumb360 == "" || img.OriginalW != 1200 {
		t.Fatalf("img thumbs/dims: %+v", img)
	}
	doc := withFiles.Files[1]
	if doc.IsImage {
		t.Fatal("pdf should not be IsImage")
	}
	if doc.PrettyType != "PDF" || doc.Size != 67890 || doc.Permalink == "" {
		t.Fatalf("doc=%+v", doc)
	}
}

func TestNormalizeThreadCapturesAttachments(t *testing.T) {
	raw := loadFixture(t)
	th := NormalizeThread("C0EXAMPLE1", "1700000000.000001", raw)
	var m *Message
	for i := range th.Messages {
		if len(th.Messages[i].Attachments) > 0 {
			m = &th.Messages[i]
			break
		}
	}
	if m == nil {
		t.Fatal("expected a message with attachments")
	}
	if len(m.Attachments) != 2 {
		t.Fatalf("attachments=%d, want 2", len(m.Attachments))
	}
	web := m.Attachments[0]
	if web.Title == "" || web.TitleLink == "" || web.Color != "36a64f" {
		t.Fatalf("web=%+v", web)
	}
	if web.ImageURL == "" || web.ImageWidth != 571 {
		t.Fatalf("web image: %+v", web)
	}
	if web.IsThreadUnfurl {
		t.Fatal("web unfurl should not be a thread unfurl")
	}
	th2 := m.Attachments[1]
	if !th2.IsThreadUnfurl || th2.FromURL == "" || th2.AuthorName == "" {
		t.Fatalf("thread unfurl=%+v", th2)
	}
}

func TestUnreadDividerIndex(t *testing.T) {
	th := Thread{
		LastRead: "100.000002",
		Messages: []Message{{TS: "100.000001"}, {TS: "100.000002"}, {TS: "100.000003"}},
	}
	if got := UnreadDividerIndex(th); got != 2 {
		t.Fatalf("divider index = %d, want 2", got)
	}
	th.LastRead = "100.000003"
	if got := UnreadDividerIndex(th); got != -1 {
		t.Fatalf("divider index = %d, want -1 (all read)", got)
	}
}

func TestUnreadDividerIndexEmptyLastReadTreatedAsNothingUnread(t *testing.T) {
	th := Thread{
		LastRead: "",
		Messages: []Message{{TS: "100.000001"}, {TS: "100.000002"}},
	}
	if got := UnreadDividerIndex(th); got != -1 {
		t.Fatalf("divider index = %d, want -1 (no read cursor => nothing unread)", got)
	}
}

func TestUnreadDividerIndexLastReadAtOrAfterLastMessage(t *testing.T) {
	th := Thread{
		LastRead: "100.000005",
		Messages: []Message{{TS: "100.000001"}, {TS: "100.000002"}},
	}
	if got := UnreadDividerIndex(th); got != -1 {
		t.Fatalf("divider index = %d, want -1 (all read)", got)
	}
}

func TestUnreadDividerIndexLastReadBetweenMessages(t *testing.T) {
	th := Thread{
		LastRead: "100.000001",
		Messages: []Message{{TS: "100.000001"}, {TS: "100.000002"}, {TS: "100.000003"}},
	}
	if got := UnreadDividerIndex(th); got != 1 {
		t.Fatalf("divider index = %d, want 1", got)
	}
}

func TestRepliesUsesFormEncodingAndAuthHeaders(t *testing.T) {
	var gotAuth, gotCookie, gotBody, gotCT string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotCookie = r.Header.Get("Cookie")
		gotCT = r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		fixture, _ := os.ReadFile("testdata/replies.json")
		w.Write(fixture)
	}))
	defer srv.Close()

	c := NewWithBaseURL("xoxc-t", "xoxd-c", srv.URL)
	th, err := c.Replies(context.Background(), "C0EXAMPLE1", "1700000000.000001")
	if err != nil {
		t.Fatal(err)
	}
	if len(th.Messages) != 5 {
		t.Fatalf("messages=%d", len(th.Messages))
	}
	if gotAuth != "Bearer xoxc-t" {
		t.Fatalf("auth=%q", gotAuth)
	}
	if gotCookie != "d=xoxd-c" {
		t.Fatalf("cookie=%q", gotCookie)
	}
	if !strings.HasPrefix(gotCT, "application/x-www-form-urlencoded") {
		t.Fatalf("ct=%q", gotCT)
	}
	if !strings.Contains(gotBody, "channel=C0EXAMPLE1") || !strings.Contains(gotBody, "ts=1700000000.000001") {
		t.Fatalf("body=%q", gotBody)
	}
}

func TestRepliesAuthErrorMapped(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":false,"error":"invalid_auth"}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("x", "y", srv.URL)
	_, err := c.Replies(context.Background(), "C", "1.1")
	if !errors.Is(err, ErrAuth) {
		t.Fatalf("err=%v, want ErrAuth", err)
	}
}

func TestUsersInfoPopulatesRealNameSeparateFromID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"user":{"id":"U000000001","real_name":"Ada Lovelace","profile":{"display_name":"ada","image_72":"https://example.com/ada.png"}}}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("x", "y", srv.URL)
	users, err := c.Users(context.Background(), []string{"U000000001"})
	if err != nil {
		t.Fatal(err)
	}
	u, ok := users["U000000001"]
	if !ok {
		t.Fatalf("missing user in map: %+v", users)
	}
	if u.ID != "U000000001" {
		t.Fatalf("id=%q, want U000000001", u.ID)
	}
	if u.RealName != "Ada Lovelace" {
		t.Fatalf("real_name=%q, want %q (must not be overwritten by id)", u.RealName, "Ada Lovelace")
	}
	if u.DisplayName != "ada" {
		t.Fatalf("display_name=%q", u.DisplayName)
	}
}

func TestEmojiDerefsOneLevelOfAlias(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"emoji":{"thumbsup":"https://example.com/thumbsup.png","+1":"alias:thumbsup"}}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("x", "y", srv.URL)
	emoji, err := c.Emoji(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if emoji["+1"] != "https://example.com/thumbsup.png" {
		t.Fatalf("+1 = %q, want deref'd URL", emoji["+1"])
	}
}

func TestWhoAmIReturnsUserID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"user_id":"U000000042"}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("x", "y", srv.URL)
	id, err := c.WhoAmI(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if id != "U000000042" {
		t.Fatalf("user_id=%q, want U000000042", id)
	}
}

func TestChannelReturnsName(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"channel":{"name":"general"}}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("x", "y", srv.URL)
	name, err := c.Channel(context.Background(), "C000000001")
	if err != nil {
		t.Fatal(err)
	}
	if name != "general" {
		t.Fatalf("name=%q, want general", name)
	}
}

func TestMarkReadSendsExpectedParams(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("x", "y", srv.URL)
	err := c.MarkRead(context.Background(), "C0EXAMPLE1", "1700000000.000001", "1700000000.000005")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(gotBody, "channel=C0EXAMPLE1") || !strings.Contains(gotBody, "thread_ts=1700000000.000001") || !strings.Contains(gotBody, "ts=1700000000.000005") {
		t.Fatalf("body=%q", gotBody)
	}
}

func TestNormalizeRichTextBlocks_SectionAndList(t *testing.T) {
	raw := []rawBlock{{
		Type: "rich_text",
		Elements: []rawElemGrp{
			{Type: "rich_text_section", Elements: []rawElement{{Type: "text", Text: "hi"}}},
			{Type: "rich_text_list", Style: "bullet", Indent: 0, Elements: []rawElement{
				{Type: "rich_text_section", Elements: []rawElement{{Type: "text", Text: "one"}}},
			}},
		},
	}}
	got := normalizeRichTextBlocks(raw)
	if len(got) != 2 {
		t.Fatalf("want 2 blocks, got %d", len(got))
	}
	if got[0].Type != "section" || len(got[0].Elements) != 1 || got[0].Elements[0].Text != "hi" {
		t.Errorf("section block wrong: %+v", got[0])
	}
	if got[1].Type != "list" || got[1].Style != "bullet" || len(got[1].Items) != 1 || got[1].Items[0][0].Text != "one" {
		t.Errorf("list block wrong: %+v", got[1])
	}
}

func TestNormalizeBlockKit_CoreTypesAndUnsupported(t *testing.T) {
	raw := []rawBlockKit{
		{Type: "section",
			Text:      &rawTextObject{Type: "mrkdwn", Text: "hello <@U1>"},
			Accessory: &rawBlockElement{Type: "image", ImageURL: "https://cdn.example/x.png", AltText: "thumb"}},
		{Type: "context", Elements: json.RawMessage(`[
			{"type":"image","image_url":"https://cdn.example/i.png","alt_text":"a"},
			{"type":"mrkdwn","text":"ctx *b*"}
		]`)},
		{Type: "rich_text", Elements: json.RawMessage(`[
			{"type":"rich_text_section","elements":[{"type":"text","text":"rt"}]}
		]`)},
		{Type: "divider"},
		{Type: "image", ImageURL: "https://cdn.example/big.png", AltText: "big"},
		{Type: "header", Text: &rawTextObject{Type: "plain_text", Text: "Title"}},
		{Type: "actions"}, // interactive → unsupported
	}
	got := normalizeBlockKit(raw)
	if len(got) != 7 {
		t.Fatalf("want 7 blocks, got %d", len(got))
	}
	if got[0].Type != "section" || got[0].Text == nil || got[0].Text.Text != "hello <@U1>" {
		t.Errorf("section text wrong: %+v", got[0])
	}
	if got[0].Accessory == nil || got[0].Accessory.Type != "image" || got[0].Accessory.ImageURL != "https://cdn.example/x.png" {
		t.Errorf("section accessory wrong: %+v", got[0].Accessory)
	}
	if got[1].Type != "context" || len(got[1].Elements) != 2 || got[1].Elements[0].Type != "image" || got[1].Elements[1].Text != "ctx *b*" {
		t.Errorf("context wrong: %+v", got[1])
	}
	if got[2].Type != "rich_text" || len(got[2].RichText) != 1 || got[2].RichText[0].Type != "section" || got[2].RichText[0].Elements[0].Text != "rt" {
		t.Errorf("rich_text wrong: %+v", got[2])
	}
	if got[3].Type != "divider" {
		t.Errorf("divider wrong: %+v", got[3])
	}
	if got[4].Type != "image" || got[4].ImageURL != "https://cdn.example/big.png" || got[4].AltText != "big" {
		t.Errorf("image wrong: %+v", got[4])
	}
	if got[5].Type != "header" || got[5].Text == nil || got[5].Text.Text != "Title" {
		t.Errorf("header wrong: %+v", got[5])
	}
	if got[6].Type != "unsupported" {
		t.Errorf("actions should be unsupported, got %q", got[6].Type)
	}
}

func TestNormalizeThread_AttachmentBlocksFixture(t *testing.T) {
	data, err := os.ReadFile("testdata/attachment_blocks.json")
	if err != nil {
		t.Fatal(err)
	}
	var raw RepliesResponse
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	th := NormalizeThread("C0EXAMPLE", "1700000000.000100", raw)
	if len(th.Messages) != 1 || len(th.Messages[0].Attachments) != 1 {
		t.Fatalf("want 1 message with 1 attachment, got %d msgs", len(th.Messages))
	}
	blocks := th.Messages[0].Attachments[0].Blocks
	if len(blocks) != 5 {
		t.Fatalf("want 5 blocks, got %d", len(blocks))
	}
	if blocks[0].Type != "section" || blocks[0].Accessory == nil || blocks[0].Accessory.ImageURL == "" {
		t.Errorf("section+accessory wrong: %+v", blocks[0])
	}
	if blocks[1].Type != "context" || len(blocks[1].Elements) != 2 {
		t.Errorf("context wrong: %+v", blocks[1])
	}
	if blocks[2].Type != "rich_text" || len(blocks[2].RichText) != 1 {
		t.Errorf("rich_text wrong: %+v", blocks[2])
	}
	if blocks[3].Type != "divider" {
		t.Errorf("divider wrong: %+v", blocks[3])
	}
	if blocks[4].Type != "unsupported" {
		t.Errorf("actions should be unsupported: %+v", blocks[4])
	}
}

func TestNormalizeBlockKit_DegenerateElements(t *testing.T) {
	// Test 1: context block with NIL Elements
	raw1 := []rawBlockKit{{Type: "context"}}
	got1 := normalizeBlockKit(raw1)
	if len(got1) != 1 || got1[0].Type != "context" || len(got1[0].Elements) != 0 {
		t.Errorf("context with nil Elements: got %+v, want type=context with len(Elements)=0", got1[0])
	}

	// Test 2: rich_text block with NIL Elements
	raw2 := []rawBlockKit{{Type: "rich_text"}}
	got2 := normalizeBlockKit(raw2)
	if len(got2) != 1 || got2[0].Type != "rich_text" || len(got2[0].RichText) != 0 {
		t.Errorf("rich_text with nil Elements: got %+v, want type=rich_text with len(RichText)=0", got2[0])
	}

	// Test 3: context block with malformed JSON Elements
	raw3 := []rawBlockKit{{Type: "context", Elements: json.RawMessage("{bad")}}
	got3 := normalizeBlockKit(raw3)
	if len(got3) != 1 || got3[0].Type != "context" || len(got3[0].Elements) != 0 {
		t.Errorf("context with malformed Elements: got %+v, want type=context with len(Elements)=0", got3[0])
	}
}
