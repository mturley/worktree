import type { TaskScope } from "../hooks/useTasks"

// Lives here, not in TasksSection, so TaskRow can use it without an import
// cycle (TasksSection -> TaskList -> TaskRow).
/** What a resource type is called in the panel's summary. */
const RESOURCE_NOUN: Record<string, string> = { pr: "PR", jira: "issue", slack: "thread", link: "link" }

/** Which tasks the panel lists, for its summary: "all", "this worktree", "this PR"… */
export function scopeContext(scope: TaskScope): string {
  switch (scope.kind) {
    case "all":
      return "all"
    case "worktree":
      return "this worktree"
    case "resource":
      return `this ${RESOURCE_NOUN[scope.type] ?? "resource"}`
  }
}
