// internal/slackapi/types.go
package slackapi

import "encoding/json"

// --- Raw Slack API shapes (conversations.replies) ---

type RepliesResponse struct {
	OK               bool         `json:"ok"`
	Error            string       `json:"error"`
	Messages         []rawMessage `json:"messages"`
	HasMore          bool         `json:"has_more"`
	ResponseMetadata struct {
		NextCursor string `json:"next_cursor"`
	} `json:"response_metadata"`
}

type rawMessage struct {
	TS          string          `json:"ts"`
	User        string          `json:"user"`
	Text        string          `json:"text"`
	ThreadTS    string          `json:"thread_ts"`
	LastRead    string          `json:"last_read"`
	LatestReply string          `json:"latest_reply"`
	Edited      *struct{}       `json:"edited"`
	Blocks      []rawBlock      `json:"blocks"`
	Reactions   []rawReaction   `json:"reactions"`
	Files       []rawFile       `json:"files"`
	Attachments []rawAttachment `json:"attachments"`
}

type rawFile struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Title      string `json:"title"`
	Mimetype   string `json:"mimetype"`
	Filetype   string `json:"filetype"`
	PrettyType string `json:"pretty_type"`
	Size       int    `json:"size"`
	Permalink  string `json:"permalink"`
	URLPrivate string `json:"url_private"`
	Thumb360   string `json:"thumb_360"`
	Thumb360W  int    `json:"thumb_360_w"`
	Thumb360H  int    `json:"thumb_360_h"`
	Thumb720   string `json:"thumb_720"`
	OriginalW  int    `json:"original_w"`
	OriginalH  int    `json:"original_h"`
}

type rawAttachment struct {
	Title         string        `json:"title"`
	TitleLink     string        `json:"title_link"`
	Text          string        `json:"text"`
	ServiceName   string        `json:"service_name"`
	ServiceIcon   string        `json:"service_icon"`
	Footer        string        `json:"footer"`
	FooterIcon    string        `json:"footer_icon"`
	Color         string        `json:"color"`
	ImageURL      string        `json:"image_url"`
	ThumbURL      string        `json:"thumb_url"`
	ImageWidth    int           `json:"image_width"`
	ImageHeight   int           `json:"image_height"`
	AuthorName    string        `json:"author_name"`
	IsMsgUnfurl   bool          `json:"is_msg_unfurl"`
	IsReplyUnfurl bool          `json:"is_reply_unfurl"`
	FromURL       string        `json:"from_url"`
	ChannelID     string        `json:"channel_id"`
	Blocks        []rawBlockKit `json:"blocks"`
}

type rawTextObject struct {
	Type string `json:"type"` // "mrkdwn" | "plain_text"
	Text string `json:"text"`
}

type rawBlockElement struct {
	Type     string `json:"type"` // "image" | "mrkdwn" | "plain_text" | (interactive)
	Text     string `json:"text"` // for mrkdwn/plain_text elements
	ImageURL string `json:"image_url"`
	AltText  string `json:"alt_text"`
}

// rawBlockKit models a Block Kit block carried inside an attachment. `elements`
// is decoded per-type in normalize: for "context" it is []rawBlockElement, for
// "rich_text" it is []rawElemGrp (the same rich_text groups as message blocks).
type rawBlockKit struct {
	Type      string           `json:"type"`
	Text      *rawTextObject   `json:"text"`      // section/header
	Accessory *rawBlockElement `json:"accessory"` // section
	ImageURL  string           `json:"image_url"` // image block
	AltText   string           `json:"alt_text"`  // image block
	Elements  json.RawMessage  `json:"elements"`  // context: []rawBlockElement; rich_text: []rawElemGrp
}

type rawBlock struct {
	Type     string       `json:"type"`
	Elements []rawElemGrp `json:"elements"` // rich_text_section wrappers
}

type rawElemGrp struct {
	Type     string       `json:"type"` // "rich_text_section", "rich_text_list", "rich_text_quote", "rich_text_preformatted", etc.
	Style    string       `json:"style"`
	Indent   int          `json:"indent"`
	Elements []rawElement `json:"elements"`
}

// rawElement models a single entry inside a rawElemGrp's Elements array.
// For "rich_text_section"/"rich_text_quote"/"rich_text_preformatted" groups,
// each entry is a leaf (text/user/link/emoji/usergroup/broadcast) and Type,
// Text, URL, etc. are populated directly. For "rich_text_list" groups, each
// entry is itself a nested "rich_text_section" item (Type=="rich_text_section"
// with its own Elements holding the item's leaves) rather than a leaf, so
// Elements is reused here to carry those nested leaves.
type rawElement struct {
	Type    string `json:"type"`
	Text    string `json:"text"`
	URL     string `json:"url"`
	UserID  string `json:"user_id"`
	Name    string `json:"name"` // emoji name / usergroup
	Unicode string `json:"unicode"`
	Style   struct {
		Bold   bool `json:"bold"`
		Italic bool `json:"italic"`
		Code   bool `json:"code"`
		Strike bool `json:"strike"`
	} `json:"style"`
	Elements []rawElement `json:"elements"` // populated for rich_text_list items (nested rich_text_section)
}

type rawReaction struct {
	Name  string   `json:"name"`
	Count int      `json:"count"`
	Users []string `json:"users"`
}

// --- Domain types (normalized, Slack quirks removed) ---

type Thread struct {
	Channel     string
	ThreadTS    string
	LastRead    string // parent message last_read
	LatestReply string
	Messages    []Message
}

type Message struct {
	TS          string
	UserID      string
	Text        string  // raw mrkdwn fallback
	Blocks      []Block // normalized rich_text groups (nil if no blocks)
	Reactions   []Reaction
	Edited      bool
	Files       []File
	Attachments []Attachment
}

// File is a normalized Slack file attachment (e.g. an uploaded image or
// document shared into a message).
type File struct {
	ID         string
	Name       string
	Title      string
	Mimetype   string
	Filetype   string
	PrettyType string
	Size       int
	Permalink  string
	URLPrivate string
	Thumb360   string
	Thumb360W  int
	Thumb360H  int
	Thumb720   string
	OriginalW  int
	OriginalH  int
	IsImage    bool
}

// Attachment is a normalized Slack legacy "attachment" (e.g. a link unfurl
// or a Slack thread/message unfurl).
type Attachment struct {
	Title          string
	TitleLink      string
	Text           string
	ServiceName    string
	ServiceIcon    string
	Footer         string
	FooterIcon     string
	Color          string // hex, no '#'
	ImageURL       string
	ThumbURL       string
	ImageWidth     int
	ImageHeight    int
	AuthorName     string
	IsMsgUnfurl    bool
	IsReplyUnfurl  bool
	FromURL        string
	ChannelID      string
	IsThreadUnfurl bool // derived: IsMsgUnfurl || IsReplyUnfurl
	Blocks         []BlockKit
}

// TextObject is a Block Kit text object ({type: mrkdwn|plain_text, text}).
type TextObject struct {
	Type string // "mrkdwn" | "plain_text"
	Text string
}

// BlockElement is a leaf inside a context block or a section accessory: an
// image, or an mrkdwn/plain_text text element.
type BlockElement struct {
	Type     string // "image" | "mrkdwn" | "plain_text"
	ImageURL string // image
	AltText  string // image
	Text     string // mrkdwn/plain_text
}

// BlockKit is one normalized Block Kit block carried inside an attachment
// (e.g. a Confluence/Jira is_app_unfurl preview). Type is one of:
// "section" | "context" | "image" | "divider" | "header" | "rich_text" |
// "unsupported". Interactive/unknown blocks normalize to "unsupported" and
// render nothing.
type BlockKit struct {
	Type      string         // see above
	Text      *TextObject    // section/header
	Elements  []BlockElement // context
	Accessory *BlockElement  // section
	ImageURL  string         // image
	AltText   string         // image
	RichText  []Block        // rich_text: normalized rich_text groups
}

// Block is one group within a message's rich_text block: a paragraph
// ("section"), a blockquote ("quote"), a code block ("preformatted"), or a
// list ("list"). For section/quote/preformatted, Elements holds the leaf
// elements to render in order. For list, Style/Indent describe the list and
// Items holds one leaf-element slice per list item (Elements is unused).
type Block struct {
	Type     string      // "section" | "list" | "quote" | "preformatted"
	Elements []Element   // for section/quote/preformatted: the leaf elements
	Style    string      // "bullet" | "ordered" (list only, empty otherwise)
	Indent   int         // nesting level (list only, 0-based)
	Items    [][]Element // for list: one []Element per list item
}

type Element struct {
	Type    string // "text" | "user" | "link" | "emoji" | "usergroup" | "broadcast"
	Text    string // for text/link label
	URL     string // for link
	UserID  string // for user mention
	Name    string // for emoji name / usergroup id
	Unicode string // for standard emoji codepoint (may be empty)
	Style   Style  // bold/italic/code for text
}

type Style struct{ Bold, Italic, Code, Strike bool }

type Reaction struct {
	Name    string
	Count   int
	UserIDs []string
}

type User struct {
	ID          string
	RealName    string
	DisplayName string
	Avatar72    string
}
