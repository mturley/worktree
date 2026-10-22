import { useEffect, useRef, useState, type ReactNode } from "react"
import { ActionIcon, Anchor, Badge, Box, Button, Group, Popover, Stack, Text, Title } from "@mantine/core"
import { IconGripVertical, IconX } from "@tabler/icons-react"
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { TaskDetail, TaskDetailLink, TaskImplicit } from "../../../api/types"
import { useTaskDetailMutations } from "../../../hooks/useTaskDetail"
import { resourceCollisions } from "../../../lib/resourceCollision"
import { shortResourceRef } from "../../../lib/resourceRef"
import { useHoverMenu, type HoverMenu } from "../../../lib/useHoverMenu"
import type { GroupId } from "../../../lib/resourceOrder"
import { LinkPicker } from "./LinkPicker"
import { basename, linkKey, linkTarget, viaRef } from "./linkTargets"
import { useSectionAction } from "./sectionAction"

/** The two groups' link keys, in order. */
export interface LinkGroups {
  focus: string[]
  related: string[]
}

const dndId = (key: string) => `link:${key}`
const fromDndId = (id: string) => (id.startsWith("link:") ? id.slice(5) : null)

/**
 * Applies a drop to the two groups. `over` is a dnd id: a link's, or a
 * group's ("focus"/"related", reachable only when that group is empty — see
 * resourceCollisions). Within a group a drop lands where the link it is over
 * was (arrayMove, as dnd-kit's sortable shows it); across groups it lands
 * before that link, or after it when the dragged link is `below` its centre.
 * Null when nothing changes.
 */
export function dropLinks(groups: LinkGroups, active: string, over: string, below: boolean): LinkGroups | null {
  const a = fromDndId(active)
  if (a === null) return null
  const from: GroupId | null = groups.focus.includes(a) ? "focus" : groups.related.includes(a) ? "related" : null
  if (!from) return null
  const next: LinkGroups = { focus: [...groups.focus], related: [...groups.related] }

  if (over === "focus" || over === "related") {
    if (over === from) return null
    next[from] = next[from].filter((k) => k !== a)
    next[over] = [...next[over], a]
    return next
  }
  const o = fromDndId(over)
  if (o === null || o === a) return null
  const to: GroupId | null = groups.focus.includes(o) ? "focus" : groups.related.includes(o) ? "related" : null
  if (!to) return null
  if (to === from) {
    next[to] = arrayMove(next[to], next[to].indexOf(a), next[to].indexOf(o))
  } else {
    next[from] = next[from].filter((k) => k !== a)
    const i = next[to].indexOf(o) + (below ? 1 : 0)
    next[to] = [...next[to].slice(0, i), a, ...next[to].slice(i)]
  }
  return next
}

/**
 * "Linked to": the task's Focus and Related links, two SortableContexts in
 * one DndContext so a link can be dragged within and between them; each link
 * removable, and switchable from its grip's hover menu. Implicit worktrees
 * (those following a linked resource) are listed dashed and read-only.
 *
 * Nothing here navigates inside the app: a resource's title opens its page
 * in a new tab. The modal's close() undoes its open() with history.back(), so
 * an in-app navigation from inside it would have to close it first.
 */
export function LinksSection({ task }: { task: TaskDetail }) {
  const m = useTaskDetailMutations(task.id)
  const { run, alert } = useSectionAction()
  const [dragging, setDragging] = useState(false)
  const [pending, setPending] = useState<LinkGroups | null>(null)
  const saving = useRef(0)
  useEffect(() => {
    if (!dragging && saving.current === 0) setPending(null)
  }, [task.detail_links])

  const menuFor = useHoverMenu({ openDelay: 300, closeDelay: 400, disabled: dragging })
  const sensors = useSensors(
    // As ResourceList: only the grip drags, after a few pixels of travel.
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const byKey = new Map(task.detail_links.map((l) => [linkKey(l), l]))
  const server: LinkGroups = {
    focus: task.detail_links.filter((l) => l.focus).map(linkKey),
    related: task.detail_links.filter((l) => !l.focus).map(linkKey),
  }
  const groups = pending ?? server
  const pick = (keys: string[]) => keys.flatMap((k) => byKey.get(k) ?? [])
  const focus = pick(groups.focus)
  const related = pick(groups.related)

  const collisions = resourceCollisions((g) => (g === "focus" ? focus : related).length === 0)

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(false)
    if (!over) return
    const dragged = active.rect.current.translated
    const below = !!dragged && dragged.top + dragged.height / 2 > over.rect.top + over.rect.height / 2
    const next = dropLinks(groups, String(active.id), String(over.id), below)
    if (!next) return
    setPending(next)
    saving.current++
    const targets = (keys: string[]) => pick(keys).map(linkTarget)
    run(
      // Both groups in full: the call states what the order IS.
      m.orderLinks(targets(next.focus), targets(next.related)).finally(() => {
        // The cache now holds the server's order (the response, or the
        // refetch after a failure), so the optimistic one can go. A failed
        // write's refetch can be structurally equal to what was cached, which
        // would never re-trigger the effect above.
        if (--saving.current === 0) setPending(null)
      }),
    )
  }

  const rows = (ls: TaskDetailLink[]) =>
    ls.map((l) => {
      const key = linkKey(l)
      return (
        <SortableLinkRow
          key={key}
          l={l}
          menu={menuFor(key)}
          onRemove={() => run(m.removeLink(linkTarget(l)))}
          onSetFocus={(f) => run(m.setLinkFocus(linkTarget(l), f))}
        />
      )
    })

  const empty = task.detail_links.length === 0 && task.implicit.length === 0

  return (
    <Stack gap={6}>
      <Title order={6}>Linked to</Title>
      {alert}
      {empty && <Text size="sm" c="dimmed">Not linked to anything.</Text>}
      {task.detail_links.length > 0 && (
        <DndContext
          sensors={sensors}
          collisionDetection={collisions}
          autoScroll={false}
          onDragStart={() => setDragging(true)}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(false)}
        >
          <LinkGroup group="focus" title="Focus" count={focus.length} dragging={dragging}>
            <SortableContext items={groups.focus.map(dndId)} strategy={verticalListSortingStrategy}>
              {rows(focus)}
            </SortableContext>
          </LinkGroup>
          <LinkGroup group="related" title="Related" count={related.length} dragging={dragging}>
            <SortableContext items={groups.related.map(dndId)} strategy={verticalListSortingStrategy}>
              {rows(related)}
            </SortableContext>
          </LinkGroup>
        </DndContext>
      )}
      {task.implicit.length > 0 && (
        <Stack gap={4}>
          {task.implicit.map((im) => <ImplicitRow key={im.worktree} im={im} />)}
        </Stack>
      )}
      <LinkPicker task={task} />
    </Stack>
  )
}

function LinkGroup({ group, title, count, dragging, children }: {
  group: GroupId
  title: string
  count: number
  dragging: boolean
  children: ReactNode
}) {
  // A drop target of its own, so a link can reach a group with nothing in it.
  const { setNodeRef, isOver } = useDroppable({ id: group })
  if (count === 0 && !dragging) return null
  return (
    <Stack gap={2}>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase">{title}</Text>
      <Stack
        gap={2}
        ref={setNodeRef}
        data-link-drop
        data-testid={`links-${group}`}
        style={{
          minHeight: dragging ? 32 : undefined,
          borderRadius: 6,
          outline: isOver ? "2px dashed var(--mantine-color-violet-5)" : undefined,
        }}
      >
        {count === 0 && <Text c="dimmed" size="xs" p={6}>Drop a link here.</Text>}
        {children}
      </Stack>
    </Stack>
  )
}

function LinkLabel({ l }: { l: TaskDetailLink }) {
  const ref = l.kind === "resource" ? shortResourceRef(l.resource_type ?? "", l.resource_id ?? "") : ""
  const text = l.kind === "worktree" ? `⎇ ${l.title}` : l.title
  return (
    <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
      {ref && ref !== l.title && <Text size="xs" c="dimmed" style={{ flex: "none" }}>{ref}</Text>}
      {l.url ? (
        <Anchor href={l.url} target="_blank" rel="noreferrer" size="sm" truncate style={{ minWidth: 0 }}>
          {text}
        </Anchor>
      ) : (
        <Text size="sm" truncate style={{ minWidth: 0 }}>{text}</Text>
      )}
      {l.archived && <Badge size="xs" color="gray" variant="light" style={{ flex: "none" }}>archived</Badge>}
    </Group>
  )
}

function SortableLinkRow({ l, menu, onRemove, onSetFocus }: {
  l: TaskDetailLink
  menu: HoverMenu
  onRemove: () => void
  onSetFocus: (focus: boolean) => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: dndId(linkKey(l)) })
  return (
    <Group
      ref={setNodeRef}
      data-link-sortable
      gap={6}
      wrap="nowrap"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 1 : undefined,
        position: "relative",
        opacity: isDragging ? 0.6 : 1,
      }}
    >
      <Popover opened={menu.opened} onClose={menu.close} position="right" withArrow shadow="md" offset={4}>
        <Popover.Target>
          <ActionIcon
            ref={setActivatorNodeRef}
            variant="subtle"
            color="gray"
            size="sm"
            style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
            onMouseEnter={menu.onTargetEnter}
            onMouseLeave={menu.onLeave}
            {...attributes}
            {...listeners}
            aria-label={`Drag to reorder ${l.title}`}
          >
            <IconGripVertical size={14} />
          </ActionIcon>
        </Popover.Target>
        <Popover.Dropdown p="xs" onMouseEnter={menu.onDropdownEnter} onMouseLeave={menu.onLeave}>
          <Stack gap={6}>
            <Text size="xs" c="dimmed">Drag to reorder</Text>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => {
                menu.close()
                onSetFocus(!l.focus)
              }}
            >
              {l.focus ? "Make Related" : "Make Focus"}
            </Button>
          </Stack>
        </Popover.Dropdown>
      </Popover>
      <LinkLabel l={l} />
      <ActionIcon variant="subtle" color="gray" size="sm" aria-label={`Remove link: ${l.title}`} onClick={onRemove}>
        <IconX size={14} />
      </ActionIcon>
    </Group>
  )
}

function ImplicitRow({ im }: { im: TaskImplicit }) {
  return (
    <Box
      data-testid={`implicit-${im.worktree}`}
      px={6}
      py={2}
      style={{ borderWidth: 1, borderStyle: "dashed", borderColor: "var(--mantine-color-default-border)", borderRadius: 6 }}
    >
      <Group gap={6} wrap="nowrap">
        <Text size="sm" c="dimmed" truncate style={{ minWidth: 0 }}>⎇ {im.branch || basename(im.worktree)}</Text>
        <Text size="xs" c="dimmed" style={{ flex: "none" }}>via {im.via.map(viaRef).join(", ")}</Text>
      </Group>
    </Box>
  )
}
