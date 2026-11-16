# The worktree's task list while a resource is selected

## Intent

Selecting a resource on the worktree detail page replaces the worktree's task
panel with a panel scoped to that resource ("Tasks (this PR)"), and leaves an
"N other tasks" badge on "← all resources". Mike uses the task list to
navigate between resources as he switches between tasks, so hiding most of it
on selection, and moving it, gets in the way. The whole list should stay
visible and in place, with the selected resource's tasks marked.

## Goals

- The worktree's full task list is shown whether or not a resource is
  selected, in the same position, so selecting and deselecting never moves it.
- The selected resource's tasks are easy to pick out at a glance.
- Adding a task while a resource is selected still links it to that resource,
  and says so before you add it.

## Non-goals / anti-goals

- Fading or hiding the other tasks. They stay fully readable: they're how
  Mike moves between resources.
- Anything that looks like unread. Blue (tint and box border) means unread
  and stays reserved for it.
- Layout shift on selection (for example, a gutter column that appears only
  while a resource is selected).

## Approaches considered

- **A: one combined list, matching rows marked (chosen).** One order to drag,
  and the list stays where it was.
- **B: one list with "This PR" and "Other tasks" headings.** Rejected: it
  regroups the list on selection, and it complicates the pinned In progress
  and Starred sections and drag semantics.
- **C: worktree tasks in the left column, resource tasks under the card.**
  Rejected: it only works wide; narrow, a selection takes over the page.

For the marker: a filled chip, an icon gutter, and fading the rest were each
mocked up. Fading was dropped (above). The icon gutter shifts the layout. Bar,
icon and tint together were overkill.

## Design

**Placement.** The worktree page's own `useTasksPanel` (worktree scope) keeps
rendering where it does with nothing selected: wide, at the top of the right
column; narrow, above the content. With a resource selected the order is
"← all resources", task panel, resource card, the card's tabs. The resource
panes (`ResourceDetailPane`, `SlackThreadPane`, `LinkPane`) no longer render
their own resource-scoped task panel. `OtherTasksBadge` is removed from the
back button.

**Marking the selected resource's rows.** A row is marked when the task has
any resource link to the selected resource, not only a focus link (my call).
A marked row gets:

- a 3px violet bar just outside the row's left edge, in the panel's left
  padding, so it sits outside the unread box border and never shifts content;
- a violet tint (`var(--mantine-color-violet-light)`, as the selected
  ResourceCard uses) when the row is not unread; an unread row keeps the blue
  unread background and border;
- a violet outlined tag at the right: THIS PR / THIS ISSUE / THIS THREAD /
  THIS LINK, worded like `scopeContext`.

The violet ties the rows back to the selected card in the resource list.

**Link chip on marked rows (my call).** The tag replaces the chip when the chip
would name the selected resource. That's the same rule as `linkChip`'s
`ownResource` today, with any "+N" count kept. When the task's focus link is
another resource, that chip stays beside the tag.

**Adding a task.** While a resource is selected, quick-add creates the task
linked to that resource (the create call uses the resource scope, as the
resource pane's panel does today). The list's query stays worktree-scoped: a
task linked to a resource the worktree follows already appears in the
worktree's list. The input's placeholder and a tooltip on the Add and
"Add & open" buttons say where the task goes ("Add to this PR" / "Add to this
worktree").

**Quick-add priority icons.** The add bar's priority Select
(`TaskQuickAdd`) shows each priority's `PriorityGlyph`, both in its options
and as the selected value, as the task modal's priority Select does
(`TaskSidebar`, `leftSection` + `renderOption`). The option-row helper moves
somewhere both can share, and the Select widens as needed to fit the glyph.
This one applies on every page.

**Expanded state (my call).** Selecting a resource no longer resets an
expanded panel (drop the `resetKey` tied to the selection), since it is now the
same list.

## Left to the builder

- How `useTasksPanel` / `TaskList` take the selected resource (a `highlight`
  resource for marking and a create scope distinct from the query scope).
- Exact bar offset relative to the panel's padding and the row's grip.
- Updating tests that assert the resource-scoped panel or the badge.
- Whether any other page (home) needs the marking. Not planned.
