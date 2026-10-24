import type { ReviewCommentItem } from "../../api/types"

const LANGS: Record<string, string> = {
  go: "go", ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", json: "json", md: "markdown", py: "python",
  sh: "sh", yaml: "yaml", yml: "yaml", css: "css", html: "html", sql: "sql", rs: "rust",
}

function language(file: string): string {
  const name = file.slice(file.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  if (dot < 0) return ""
  return LANGS[name.slice(dot + 1).toLowerCase()] ?? ""
}

function fenceFor(lines: string[]): string {
  let longest = 0
  for (const line of lines) {
    for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  }
  return "`".repeat(Math.max(3, longest + 1))
}

function span(s: number, e: number, sep: string): string {
  return e > s ? `${s}${sep}${e}` : `${s}`
}

function location(c: ReviewCommentItem): string {
  const p = c.prompt
  switch (p.status) {
    case "removed":
      return p.end_line > p.start_line
        ? `${c.file} (removed lines, previously ${span(p.start_line, p.end_line, "–")})`
        : `${c.file} (removed line, previously ${p.start_line})`
    case "outdated":
      return `${c.file}:${span(c.start_line, c.end_line, "-")} (out of date — this code has since changed; it was:)`
    default:
      return `${c.file}:${span(p.start_line, p.end_line, "-")}`
  }
}

const indent = (s: string) => s.split("\n").map((l) => `   ${l}`).join("\n")

/** The text handed to an agent: each comment with its code and its note. */
export function buildPrompt(input: {
  directory: string
  branch?: string
  baseRef: string
  comments: ReviewCommentItem[]
}): string {
  const where = input.branch ? `branch ${input.branch}, ` : ""
  const head = `Review comments on ${input.directory} (${where}changes vs ${input.baseRef}):`
  const items = input.comments.map((c, i) => {
    const fence = fenceFor(c.snippet)
    return [
      `${i + 1}. ${location(c)}`,
      indent(`${fence}${language(c.file)}\n${c.snippet.join("\n")}\n${fence}`),
      indent(c.body),
    ].join("\n")
  })
  return `${[head, ...items].join("\n\n")}\n`
}
