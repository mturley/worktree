import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import type { Nodes, Parents } from "mdast"

/**
 * Event types whose body is a GitHub comment as its author wrote it: GitHub-
 * flavoured Markdown with raw HTML mixed in (`<details>`, `<!-- -->`, `<sub>`,
 * tables), which bots like CodeRabbit lean on heavily. Every other body is
 * plain text, a CI check list, or Jira's, and is shown as it is.
 */
const GITHUB_MARKDOWN_TYPES: ReadonlySet<string> = new Set(["pr_comment", "pr_review_comment", "pr_approved"])

export function isGitHubMarkdownBody(type: string): boolean {
  return GITHUB_MARKDOWN_TYPES.has(type)
}

/** Nodes whose children run together on one line; every other parent puts each child on its own. */
const PHRASING_PARENTS: ReadonlySet<string> = new Set([
  "paragraph", "heading", "emphasis", "strong", "delete", "link", "linkReference", "tableCell",
])

const parser = unified().use(remarkParse).use(remarkGfm)

/**
 * A GitHub comment body as plain text, for a one- or two-line preview: the
 * Markdown is parsed, not pattern-stripped, so its syntax goes and its text
 * stays (a link or image becomes its text). Raw HTML is reduced to its text
 * content, so `<summary>Walkthrough</summary>` keeps "Walkthrough" and
 * comments vanish. Each block is one line, whitespace collapsed, blank lines
 * dropped.
 *
 * The HTML is read by DOMParser, which builds an inert document: scripts do
 * not run and images do not load. Rendering a body goes through
 * GitHubCommentMarkdown; this is only for text that must be a string.
 */
export function githubBodyToPlain(body: string): string {
  return text(parser.parse(body))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
}

function text(node: Nodes): string {
  switch (node.type) {
    case "html":
      return htmlText(node.value)
    case "text":
    case "inlineCode":
    case "code":
      return node.value
    case "image":
    case "imageReference":
      return node.alt ?? ""
    case "break":
      return "\n"
  }
  if (!("children" in node)) return ""
  const parent = node as Parents
  if (parent.type === "tableRow") return parent.children.map(text).join(" ")
  return parent.children.map(text).join(PHRASING_PARENTS.has(parent.type) ? "" : "\n")
}

let domParser: DOMParser | undefined

/** An inline `<br>`, which Markdown sees as an HTML node of its own. */
const BR = /^<br\s*\/?>$/i

function htmlText(html: string): string {
  if (BR.test(html.trim())) return "\n"
  domParser ??= new DOMParser()
  return domText(domParser.parseFromString(html, "text/html").body)
}

/** Elements that start a new line; textContent would run them together. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "P", "DIV", "BR", "LI", "TR", "TABLE", "UL", "OL", "DETAILS", "SUMMARY", "BLOCKQUOTE", "PRE",
  "H1", "H2", "H3", "H4", "H5", "H6", "HR",
])

function domText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ""
  if (node.nodeType !== Node.ELEMENT_NODE) return ""
  const tag = (node as Element).tagName
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") return ""
  const inner = Array.from(node.childNodes, domText).join("")
  if (BLOCK_TAGS.has(tag)) return `\n${inner}\n`
  if (tag === "TD" || tag === "TH") return `${inner} `
  return inner
}
