import { describe, expect, it } from "vitest"
import { githubBodyToPlain, isGitHubMarkdownBody } from "./githubBody"

describe("githubBodyToPlain", () => {
  it.each([
    ["inline formatting", "**bold**, _em_, ~~gone~~ and `code`", "bold, em, gone and code"],
    ["headings and lists, one line each", "## Summary\n\n- one\n- two", "Summary\none\ntwo"],
    ["links and images as their text", "See [the docs](https://x.io) ![logo](https://y.io/a.png)", "See the docs logo"],
    ["bare autolinks", "https://x.io/pull/1", "https://x.io/pull/1"],
    ["HTML comments dropped", "<!-- This is an auto-generated comment -->\nHello", "Hello"],
    ["text inside block HTML kept", "<details>\n<summary>Walkthrough</summary>\n\nThe body\n</details>", "Walkthrough\nThe body"],
    ["inline HTML tags dropped, text kept", "a <sub>small</sub> b", "a small b"],
    ["entities decoded in Markdown and HTML", "a &amp; b <b>&lt;x&gt;</b>", "a & b <x>"],
    ["tag-only HTML leaves nothing", "<img src=\"https://y.io/a.png\" alt=\"\">", ""],
    ["blank", "  \n\n ", ""],
    ["inline <br> breaks the line", "line one<br>line two", "line one\nline two"],
    ["a <br/> in a table cell", "| a |\n| - |\n| x<br/>y |", "a\nx\ny"],
    ["HTML table cells apart", "<table><tr><td>alpha</td><td>beta</td></tr></table>", "alpha beta"],
    ["script and style text dropped", "<div>a<script>evil()</script><style>p{}</style>b</div>", "ab"],
    ["HTML block elements on their own lines", "<p>one</p><p>two</p><div>three</div>", "one\ntwo\nthree"],
  ])("%s", (_name, input, want) => {
    expect(githubBodyToPlain(input)).toBe(want)
  })

  it("keeps a code block's text", () => {
    expect(githubBodyToPlain("Try:\n\n```ts\nconst a = 1\n```")).toBe("Try:\nconst a = 1")
  })
})

describe("isGitHubMarkdownBody", () => {
  it.each([
    ["pr_comment", true],
    ["pr_review_comment", true],
    ["pr_approved", true],
    ["jira_comment", false],
    ["ci_failed", false],
    ["slack_reply", false],
    ["watch_started", false],
  ])("%s → %s", (type, want) => {
    expect(isGitHubMarkdownBody(type)).toBe(want)
  })
})
