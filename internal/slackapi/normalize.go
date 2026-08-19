// internal/slackapi/normalize.go
package slackapi

import (
	"encoding/json"
	"strconv"
	"strings"
)

// normalizeBlockKit converts an attachment's raw Block Kit blocks into domain
// BlockKit values. Only the core set is modeled (section/context/image/
// divider/header/rich_text); interactive or unknown blocks become
// "unsupported" and render nothing. The `elements` field is decoded per-type
// because context uses block elements while rich_text uses rich_text groups.
func normalizeBlockKit(raw []rawBlockKit) []BlockKit {
	var out []BlockKit
	for _, b := range raw {
		switch b.Type {
		case "section":
			bk := BlockKit{Type: "section"}
			if b.Text != nil {
				bk.Text = &TextObject{Type: b.Text.Type, Text: b.Text.Text}
			}
			if b.Accessory != nil {
				bk.Accessory = normalizeBlockElementPtr(b.Accessory)
			}
			out = append(out, bk)
		case "header":
			bk := BlockKit{Type: "header"}
			if b.Text != nil {
				bk.Text = &TextObject{Type: b.Text.Type, Text: b.Text.Text}
			}
			out = append(out, bk)
		case "context":
			bk := BlockKit{Type: "context"}
			var els []rawBlockElement
			if len(b.Elements) > 0 {
				_ = json.Unmarshal(b.Elements, &els) // malformed → empty, no crash
			}
			for _, e := range els {
				bk.Elements = append(bk.Elements, normalizeBlockElement(e))
			}
			out = append(out, bk)
		case "image":
			out = append(out, BlockKit{Type: "image", ImageURL: b.ImageURL, AltText: b.AltText})
		case "divider":
			out = append(out, BlockKit{Type: "divider"})
		case "rich_text":
			var grps []rawElemGrp
			if len(b.Elements) > 0 {
				_ = json.Unmarshal(b.Elements, &grps)
			}
			out = append(out, BlockKit{Type: "rich_text", RichText: normalizeRichTextBlocks([]rawBlock{{Type: "rich_text", Elements: grps}})})
		default:
			out = append(out, BlockKit{Type: "unsupported"})
		}
	}
	return out
}

func normalizeBlockElement(e rawBlockElement) BlockElement {
	return BlockElement{Type: e.Type, ImageURL: e.ImageURL, AltText: e.AltText, Text: e.Text}
}

func normalizeBlockElementPtr(e *rawBlockElement) *BlockElement {
	ne := normalizeBlockElement(*e)
	return &ne
}

// NormalizeThread converts a raw conversations.replies response into a
// domain Thread. Slack quirks (mrkdwn tokens, rich_text block nesting,
// per-message thread state) are resolved here so the rest of the codebase
// never touches raw Slack JSON.
func NormalizeThread(channel, threadTS string, raw RepliesResponse) Thread {
	th := Thread{Channel: channel, ThreadTS: threadTS}
	for i, m := range raw.Messages {
		if i == 0 {
			th.LastRead = m.LastRead
			th.LatestReply = m.LatestReply
		}
		th.Messages = append(th.Messages, normalizeMessage(m))
	}
	return th
}

// normalizeRichTextBlocks converts a slice of raw blocks into domain Blocks,
// keeping only "rich_text" blocks (section/quote/preformatted/list). Shared by
// message-level blocks and rich_text blocks carried inside an attachment.
func normalizeRichTextBlocks(raw []rawBlock) []Block {
	var out []Block
	for _, b := range raw {
		if b.Type != "rich_text" {
			continue
		}
		for _, grp := range b.Elements {
			switch grp.Type {
			case "rich_text_section":
				out = append(out, Block{Type: "section", Elements: normalizeLeaves(grp.Elements)})
			case "rich_text_quote":
				out = append(out, Block{Type: "quote", Elements: normalizeLeaves(grp.Elements)})
			case "rich_text_preformatted":
				out = append(out, Block{Type: "preformatted", Elements: normalizeLeaves(grp.Elements)})
			case "rich_text_list":
				var items [][]Element
				for _, item := range grp.Elements {
					items = append(items, normalizeLeaves(item.Elements))
				}
				out = append(out, Block{Type: "list", Style: grp.Style, Indent: grp.Indent, Items: items})
			default:
				// Unknown group type: skip rather than guess at its shape.
			}
		}
	}
	return out
}

// normalizeMessage converts a single raw Slack message (as seen in
// conversations.replies and in chat.postMessage's response "message" field,
// which share the same shape) into a domain Message.
func normalizeMessage(m rawMessage) Message {
	msg := Message{TS: m.TS, UserID: m.User, Text: m.Text, Edited: m.Edited != nil}
	msg.Blocks = normalizeRichTextBlocks(m.Blocks)
	for _, r := range m.Reactions {
		msg.Reactions = append(msg.Reactions, Reaction{Name: r.Name, Count: r.Count, UserIDs: r.Users})
	}
	for _, f := range m.Files {
		msg.Files = append(msg.Files, File{
			ID: f.ID, Name: f.Name, Title: f.Title, Mimetype: f.Mimetype, Filetype: f.Filetype,
			PrettyType: f.PrettyType, Size: f.Size, Permalink: f.Permalink, URLPrivate: f.URLPrivate,
			Thumb360: f.Thumb360, Thumb360W: f.Thumb360W, Thumb360H: f.Thumb360H, Thumb720: f.Thumb720,
			OriginalW: f.OriginalW, OriginalH: f.OriginalH, IsImage: strings.HasPrefix(f.Mimetype, "image/"),
		})
	}
	for _, a := range m.Attachments {
		msg.Attachments = append(msg.Attachments, Attachment{
			Title: a.Title, TitleLink: a.TitleLink, Text: a.Text,
			ServiceName: a.ServiceName, ServiceIcon: a.ServiceIcon,
			Footer: a.Footer, FooterIcon: a.FooterIcon, Color: a.Color,
			ImageURL: a.ImageURL, ThumbURL: a.ThumbURL,
			ImageWidth: a.ImageWidth, ImageHeight: a.ImageHeight,
			AuthorName: a.AuthorName, IsMsgUnfurl: a.IsMsgUnfurl, IsReplyUnfurl: a.IsReplyUnfurl,
			FromURL: a.FromURL, ChannelID: a.ChannelID,
			IsThreadUnfurl: a.IsMsgUnfurl || a.IsReplyUnfurl,
			Blocks:         normalizeBlockKit(a.Blocks),
		})
	}
	return msg
}

// normalizeLeaves converts a slice of raw leaf elements (text/user/link/
// emoji/usergroup/broadcast) into domain Elements.
func normalizeLeaves(raw []rawElement) []Element {
	var out []Element
	for _, e := range raw {
		out = append(out, Element{
			Type: e.Type, Text: e.Text, URL: e.URL, UserID: e.UserID,
			Name: e.Name, Unicode: e.Unicode,
			Style: Style{Bold: e.Style.Bold, Italic: e.Style.Italic, Code: e.Style.Code, Strike: e.Style.Strike},
		})
	}
	return out
}

// UnreadDividerIndex returns the index of the first message whose ts is
// numerically greater than the thread's LastRead, or -1 if every message
// has already been read. If LastRead is empty (no read cursor at all), this
// returns -1 rather than treating every message as unread: ParseFloat("")
// yields 0, which would otherwise make tsGreater(anyTS, "") true for every
// message and mark the whole thread unread.
func UnreadDividerIndex(t Thread) int {
	if t.LastRead == "" {
		return -1
	}
	for i, m := range t.Messages {
		if tsGreater(m.TS, t.LastRead) {
			return i
		}
	}
	return -1
}

// tsGreater compares two Slack timestamps numerically (they are decimal
// strings like "1700000000.000001"); a plain string compare would be wrong
// once the integer part changes length or leading digits differ.
func tsGreater(a, b string) bool {
	fa, _ := strconv.ParseFloat(a, 64)
	fb, _ := strconv.ParseFloat(b, 64)
	return fa > fb
}
