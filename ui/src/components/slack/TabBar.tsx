import { useState, type CSSProperties } from 'react'
import { Tabs, ActionIcon, TextInput, Tooltip, Group, Stack, Text } from '@mantine/core'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useNow } from '../../hooks/useNow'
import type { TabMeta } from '../../hooks/useTabMetas'
import { fallbackTitle } from '../../lib/fallbackTitle'
import { relativeFromNow } from '../../lib/relativeTime'
import { defaultTabName, type Tab } from '../../state/tabs'
import { AddTabModal } from './AddTabModal'

interface TabBarProps {
  tabs: Tab[]
  activeTabId: string | null
  metas: Map<string, TabMeta>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onRename: (id: string, name: string) => void
  onAdd: (tab: Tab, name: string, description: string) => void
  onReorder: (fromIndex: number, toIndex: number) => void
}

// Keeps tabs from growing unbounded when a channel/author name is long;
// long text is ellipsized rather than blowing out the tab bar's width.
const TAB_MAX_WIDTH = 220

const truncateStyle: CSSProperties = {
  display: 'block',
  maxWidth: TAB_MAX_WIDTH,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const unreadDotStyle: CSSProperties = {
  display: 'inline-block',
  width: 8,
  height: 8,
  borderRadius: '50%',
  backgroundColor: 'var(--mantine-color-blue-5)',
  flexShrink: 0,
}

function infoLines(meta: TabMeta | undefined, now: Date): { from: string; started?: string } {
  if (!meta || meta.status === 'loading') {
    return { from: 'Loading…' }
  }
  if (meta.status === 'error') {
    return { from: 'Unable to load details' }
  }
  const from = meta.author ? (meta.channelName ? `From ${meta.author} in #${meta.channelName}` : `From ${meta.author}`) : 'No messages yet'
  const started =
    meta.startedTs && meta.activeTs
      ? `Started ${relativeFromNow(meta.startedTs, now)} · Active ${relativeFromNow(meta.activeTs, now)}`
      : undefined
  return { from, started }
}

interface SortableTabProps {
  tab: Tab
  meta: TabMeta | undefined
  now: Date
  renamingId: string | null
  renameValue: string
  onRenameValueChange: (value: string) => void
  onStartRename: (tab: Tab) => void
  onCommitRename: () => void
  onCancelRename: () => void
  onClose: (id: string) => void
}

// Wraps a single tab in dnd-kit's sortable behavior while keeping the exact
// same visual output as before. A `PointerSensor` with an activation
// distance (see `sensors` below) means a plain click/dblclick still reaches
// the tab (and its rename/close controls) unimpeded — only a drag past the
// threshold engages the sortable listeners.
function SortableTab({
  tab,
  meta,
  now,
  renamingId,
  renameValue,
  onRenameValueChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onClose,
}: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id })
  const hasCustomTitle = tab.name !== defaultTabName(tab.channel, tab.threadTs)
  const { from, started } = infoLines(meta, now)
  const showUnreadDot = meta?.status === 'ready' && meta.hasUnread
  // Fallback title (untitled tabs): while the meta hasn't resolved yet,
  // show a dimmed placeholder instead of the literal "No title"; once
  // ready, show a preview of the thread's first message, or "(no title)"
  // if there's genuinely no text to preview.
  const untitledText = !meta || meta.status === 'loading' ? '…' : fallbackTitle(meta.firstMessageText) || '(no title)'

  const style: CSSProperties = {
    height: 'auto',
    alignItems: 'flex-start',
    paddingTop: 8,
    paddingBottom: 8,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <Tabs.Tab
      key={tab.id}
      value={tab.id}
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      rightSection={
        <ActionIcon
          component="span"
          size="xs"
          variant="subtle"
          onClick={(event) => {
            event.stopPropagation()
            onClose(tab.id)
          }}
          aria-label={`Close ${tab.name}`}
        >
          &times;
        </ActionIcon>
      }
    >
      {renamingId === tab.id ? (
        <TextInput
          autoFocus
          size="xs"
          value={renameValue}
          onChange={(event) => onRenameValueChange(event.currentTarget.value)}
          onBlur={onCommitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onCommitRename()
            } else if (event.key === 'Escape') {
              onCancelRename()
            }
          }}
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <Tooltip label={tab.description || tab.name} disabled={!tab.description}>
          <Group gap={6} wrap="nowrap" align="flex-start">
            {showUnreadDot && (
              <span
                data-testid="tab-unread-dot"
                aria-label="Unread messages"
                style={{ ...unreadDotStyle, marginTop: 6 }}
              />
            )}
            <Stack
              gap={2}
              onDoubleClick={() => onStartRename(tab)}
              style={{ maxWidth: TAB_MAX_WIDTH, textAlign: 'left' }}
            >
              {hasCustomTitle ? (
                <Text fw={700} size="sm" style={truncateStyle}>
                  {tab.name}
                </Text>
              ) : (
                <Text size="sm" c="dimmed" fs="italic" style={truncateStyle}>
                  {untitledText}
                </Text>
              )}
              <Text size="xs" c="dimmed" style={truncateStyle}>
                {from}
              </Text>
              {started && (
                <Text size="xs" c="dimmed" style={truncateStyle}>
                  {started}
                </Text>
              )}
            </Stack>
          </Group>
        </Tooltip>
      )}
    </Tabs.Tab>
  )
}

export function TabBar({ tabs, activeTabId, metas, onSelect, onClose, onRename, onAdd, onReorder }: TabBarProps) {
  const [modalOpened, setModalOpened] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // Relative times ("3m ago") only need to look fresh, not tick every
  // second like the ThreadView header does.
  const now = useNow(30_000)

  // A small activation distance means a plain click still selects the tab
  // (or reaches the dblclick-rename / close-button handlers) instead of
  // every pointerdown being hijacked as a drag start.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  )

  function startRename(tab: Tab) {
    setRenamingId(tab.id)
    setRenameValue(tab.name)
  }

  function commitRename() {
    if (renamingId !== null) {
      const trimmed = renameValue.trim()
      if (trimmed) {
        onRename(renamingId, trimmed)
      }
    }
    setRenamingId(null)
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) {
      return
    }
    const fromIndex = tabs.findIndex((tab) => tab.id === active.id)
    const toIndex = tabs.findIndex((tab) => tab.id === over.id)
    if (fromIndex === -1 || toIndex === -1) {
      return
    }
    onReorder(fromIndex, toIndex)
  }

  const tabIds = tabs.map((tab) => tab.id)

  return (
    <Group align="center" gap="xs" wrap="nowrap">
      <Tabs
        value={activeTabId}
        onChange={(value) => value && onSelect(value)}
        style={{ flex: 1, overflowX: 'auto' }}
      >
        <Tabs.List>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
              {tabs.map((tab) => (
                <SortableTab
                  key={tab.id}
                  tab={tab}
                  meta={metas.get(tab.id)}
                  now={now}
                  renamingId={renamingId}
                  renameValue={renameValue}
                  onRenameValueChange={setRenameValue}
                  onStartRename={startRename}
                  onCommitRename={commitRename}
                  onCancelRename={() => setRenamingId(null)}
                  onClose={onClose}
                />
              ))}
            </SortableContext>
          </DndContext>
          <ActionIcon
            component="div"
            variant="subtle"
            onClick={() => setModalOpened(true)}
            aria-label="Add tab"
            style={{ alignSelf: 'center', marginLeft: 4 }}
          >
            +
          </ActionIcon>
        </Tabs.List>
      </Tabs>
      <AddTabModal opened={modalOpened} onClose={() => setModalOpened(false)} onAdd={onAdd} />
    </Group>
  )
}
