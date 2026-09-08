import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ActionIcon, Box, Button, Group, Stack, Tooltip } from '@mantine/core'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $createTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  type LexicalEditor,
  type NodeKey,
  type RangeSelection,
} from 'lexical'
import type { AutocompleteItem, User, UserGroup } from '../../api/slackApi'
import { detectTrigger, type TriggerMatch } from './composer/detectTrigger'
import { useAutocomplete } from './composer/useAutocomplete'
import type { LocalContext } from './composer/candidates'
import { MentionNode, $createMentionNode } from './composer/MentionNode'
import { AutocompleteMenu, itemKey } from './composer/AutocompleteMenu'

export interface ComposerProps {
  onSend: (text: string) => void
  disabled?: boolean
  channel?: string
  users?: Record<string, User>
  groups?: Record<string, UserGroup>
  /** Test-only escape hatch: jsdom's contenteditable support is too thin for
   *  userEvent.type to reliably reach Lexical, so tests drive the editor
   *  directly via `editor.update(...)` once they have this reference. */
  onEditorReady?: (editor: LexicalEditor) => void
}

interface ToolbarAction {
  label: string
  icon: string
  wrap: (selected: string) => string
}

// Minimal mrkdwn wrapping. Slack's full link syntax is `<url|text>`, but
// without prompting for a URL we just wrap the selection as `<selection>`
// (treated as the URL). The user can edit in a `|label` by hand if needed.
// (A richer link dialog is a later-phase enhancement.)
const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { label: 'Bold', icon: 'B', wrap: (s) => `*${s}*` },
  { label: 'Italic', icon: 'I', wrap: (s) => `_${s}_` },
  { label: 'Code', icon: '</>', wrap: (s) => `\`${s}\`` },
  { label: 'Strikethrough', icon: 'S', wrap: (s) => `~${s}~` },
  { label: 'Link', icon: '🔗', wrap: (s) => `<${s}>` },
]

/** Reconstructs the plain text of the current block from its start up to the
 *  caret, by concatenating preceding siblings' text content and slicing the
 *  anchor node's own text to the caret offset. Needed because Lexical only
 *  gives us the anchor node + offset, not a ready-made "text before caret". */
function getTextBeforeCaret(selection: RangeSelection): string {
  const anchor = selection.anchor
  const anchorNode = anchor.getNode()
  if (anchorNode.getType() === 'root') {
    // Empty editor, or a selection collapsed directly onto root — no text
    // precedes the caret.
    return ''
  }
  const topLevel = anchorNode.getTopLevelElementOrThrow()
  let text = ''
  for (const child of topLevel.getChildren()) {
    if (child.getKey() === anchorNode.getKey()) {
      text += anchorNode.getTextContent().slice(0, anchor.offset)
      break
    }
    text += child.getTextContent()
  }
  return text
}

/** The single source of truth for "is the autocomplete popup visibly open",
 *  read by BOTH the render (whether to show the popup) and the Enter-key
 *  guard (whether to swallow Enter instead of sending). They must never
 *  disagree — a visible popup that Enter can fall through is how Enter posts
 *  a half-typed mention: see Task 15 fix-round-1 finding 1. */
function isMenuVisible(hasMatch: boolean, itemCount: number, degraded: boolean): boolean {
  return hasMatch && (itemCount > 0 || degraded)
}

/** Identifies one dismissed trigger *occurrence* — the text node it lives in
 *  plus its offset within the block — so a caret move away and back doesn't
 *  reopen it (finding 3), but replacing that text (a new node, or the same
 *  node at a different offset) is treated as a new occurrence and does
 *  reopen (finding 2). A bare `start` offset can't tell those apart. */
interface SuppressedOccurrence {
  nodeKey: NodeKey
  start: number
  trigger: TriggerMatch['trigger']
}

export function Composer({ onSend, disabled, channel, users, groups, onEditorReady }: ComposerProps) {
  const initialConfig = useMemo(
    () => ({
      namespace: 'slack-composer',
      nodes: [MentionNode],
      onError: (error: Error) => {
        throw error
      },
      theme: {},
    }),
    [],
  )

  return (
    <Stack gap={4}>
      <LexicalComposer initialConfig={initialConfig}>
        <ComposerInner
          onSend={onSend}
          disabled={disabled}
          channel={channel ?? ''}
          users={users ?? {}}
          groups={groups ?? {}}
          onEditorReady={onEditorReady}
        />
      </LexicalComposer>
    </Stack>
  )
}

interface ComposerInnerProps {
  onSend: (text: string) => void
  disabled?: boolean
  channel: string
  users: Record<string, User>
  groups: Record<string, UserGroup>
  onEditorReady?: (editor: LexicalEditor) => void
}

function ComposerInner({ onSend, disabled, channel, users, groups, onEditorReady }: ComposerInnerProps): JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [match, setMatch] = useState<TriggerMatch | null>(null)
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null)
  const [isEmpty, setIsEmpty] = useState(true)

  const ctx: LocalContext = useMemo(() => ({ users, groups }), [users, groups])
  const { items, degraded } = useAutocomplete(match, channel, ctx)

  // Refs mirroring the latest render's state/props, read inside Lexical
  // command handlers registered once on mount (see the editor effect below).
  const matchRef = useRef(match)
  matchRef.current = match
  const itemsRef = useRef(items)
  itemsRef.current = items
  const degradedRef = useRef(degraded)
  degradedRef.current = degraded
  const highlightedKeyRef = useRef(highlightedKey)
  highlightedKeyRef.current = highlightedKey
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const onSendRef = useRef(onSend)
  onSendRef.current = onSend

  // The occurrence most recently dismissed with Escape (see
  // SuppressedOccurrence above), and the text node the CURRENT open match
  // lives in (needed to record that occurrence if Escape is pressed).
  const suppressedRef = useRef<SuppressedOccurrence | null>(null)
  const matchNodeKeyRef = useRef<NodeKey | null>(null)

  // Callbacks whose real implementation lives inside the command-registration
  // effect below (see finding 5: they only read refs there, so `[editor]` is
  // an honest dependency list with nothing to disable-lint away). Render-side
  // callers (the Send button, the menu's onSelect) go through these stable
  // indirection points instead of calling into the effect's scope directly.
  const insertMentionRef = useRef<(item: AutocompleteItem) => void>(() => {})
  const handleSendRef = useRef<() => void>(() => {})

  // Keep the highlight valid as candidates arrive/merge; default to the first
  // item without clobbering an existing highlight that is still present.
  useEffect(() => {
    if (items.length === 0) {
      setHighlightedKey(null)
      return
    }
    setHighlightedKey((prev) => (prev !== null && items.some((i) => itemKey(i) === prev) ? prev : itemKey(items[0])))
  }, [items])

  useEffect(() => {
    onEditorReady?.(editor)
  }, [editor, onEditorReady])

  // The old plain Textarea used `disabled` to genuinely block typing.
  // Lexical's ContentEditable doesn't honor a DOM `disabled` attribute (it's
  // inert on a div) — `setEditable` is the real mechanism.
  useEffect(() => {
    editor.setEditable(!disabled)
  }, [editor, disabled])

  // Trigger detection + the keyboard/paste command wiring. Registered once
  // per editor instance; all state read through refs so the handlers always
  // see the latest values without needing to re-register every render. Every
  // function below is declared INSIDE this effect and touches only refs,
  // stable setState setters, and `editor` itself — so `[editor]` is a
  // complete, honest dependency list and no eslint-disable is needed.
  useEffect(() => {
    function insertMention(item: AutocompleteItem) {
      editor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return
        }
        // Recompute the trigger from the LIVE model rather than trusting a
        // captured TriggerMatch (finding 4): if the caret has moved or the
        // text has changed since the match was computed, trust reality. A
        // precondition failure below becomes a silent no-op the user can
        // retry, never a message that keeps the raw "@query" AND gets a
        // pill appended after it.
        const live = detectTrigger(getTextBeforeCaret(selection))
        if (!live) {
          return
        }
        const anchorNode = selection.anchor.getNode()
        const offset = selection.anchor.offset
        const toDelete = 1 + live.query.length
        const start = offset - toDelete
        if (!$isTextNode(anchorNode) || start < 0) {
          return
        }
        // Delete the trigger character plus the typed query by splicing the
        // text node directly, rather than `selection.deleteCharacter()`
        // (which depends on the browser's Selection.modify() and is a no-op
        // under jsdom, making it untestable). Splicing is deterministic
        // either way.
        anchorNode.spliceText(start, toDelete, '', true)
        const afterDelete = $getSelection()
        if (!$isRangeSelection(afterDelete)) {
          return
        }
        afterDelete.insertNodes([$createMentionNode(item), $createTextNode(' ')])
      })
      suppressedRef.current = null
      matchNodeKeyRef.current = null
      setMatch(null)
    }
    insertMentionRef.current = insertMention

    function selectHighlighted(): boolean {
      const currentItems = itemsRef.current
      if (!matchRef.current || currentItems.length === 0) {
        return false
      }
      const key = highlightedKeyRef.current
      const item = currentItems.find((i) => itemKey(i) === key) ?? currentItems[0]
      insertMention(item)
      return true
    }

    function moveHighlight(delta: number) {
      const currentItems = itemsRef.current
      if (currentItems.length === 0) {
        return
      }
      const key = highlightedKeyRef.current
      const index = currentItems.findIndex((i) => itemKey(i) === key)
      const nextIndex = index === -1 ? 0 : (index + delta + currentItems.length) % currentItems.length
      setHighlightedKey(itemKey(currentItems[nextIndex]))
    }

    function handleSend() {
      const text = editor.getEditorState().read(() => $getRoot().getTextContent())
      const trimmed = text.trim()
      if (trimmed.length === 0 || disabledRef.current) {
        return
      }
      onSendRef.current(trimmed)
      editor.update(() => {
        $getRoot().clear()
      })
    }
    handleSendRef.current = handleSend

    const removeUpdateListener = editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          setMatch(null)
          matchNodeKeyRef.current = null
          setIsEmpty($getRoot().getTextContent().trim().length === 0)
          return
        }
        setIsEmpty($getRoot().getTextContent().trim().length === 0)
        const textBeforeCaret = getTextBeforeCaret(selection)
        const detected = detectTrigger(textBeforeCaret)
        if (!detected) {
          // Caret sits somewhere with no trigger under it. This must NOT
          // clear an Escape suppression (finding 3) — dismissing the menu
          // and moving the caret away (then back, with no edit) must not
          // reopen it. Only a genuinely different occurrence does that,
          // handled below.
          setMatch(null)
          matchNodeKeyRef.current = null
          return
        }
        const anchorNode = selection.anchor.getNode()
        const nodeKey = anchorNode.getKey()
        let suppressed = suppressedRef.current
        // Defensive: if the suppressed occurrence's node no longer exists
        // (e.g. it was deleted and retyped), it can't still be "the same
        // occurrence" no matter what offset lines up.
        if (suppressed && $getNodeByKey(suppressed.nodeKey) === null) {
          suppressed = null
          suppressedRef.current = null
        }
        const isSuppressed =
          suppressed !== null &&
          suppressed.nodeKey === nodeKey &&
          suppressed.start === detected.start &&
          suppressed.trigger === detected.trigger
        if (isSuppressed) {
          setMatch(null)
          matchNodeKeyRef.current = null
          return
        }
        // A genuinely new/different occurrence (finding 2: e.g. the old
        // text was replaced wholesale) — clear any stale suppression.
        suppressedRef.current = null
        matchNodeKeyRef.current = nodeKey
        setMatch(detected)
      })
    })

    const removeEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        // Enter and "the popup is visibly open" must agree (finding 1): a
        // degraded, zero-item popup is still a popup on screen, and Enter
        // must never fall through it to send.
        if (isMenuVisible(matchRef.current !== null, itemsRef.current.length, degradedRef.current)) {
          event?.preventDefault()
          if (itemsRef.current.length > 0) {
            selectHighlighted()
          }
          return true
        }
        if (event?.shiftKey) {
          return false
        }
        event?.preventDefault()
        handleSend()
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )

    const removeArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (!matchRef.current || itemsRef.current.length === 0) {
          return false
        }
        event?.preventDefault()
        moveHighlight(1)
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )

    const removeArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (!matchRef.current || itemsRef.current.length === 0) {
          return false
        }
        event?.preventDefault()
        moveHighlight(-1)
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )

    const removeTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (!matchRef.current || itemsRef.current.length === 0) {
          return false
        }
        event?.preventDefault()
        moveHighlight(1)
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )

    const removeEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        if (!matchRef.current || !matchNodeKeyRef.current) {
          return false
        }
        suppressedRef.current = {
          nodeKey: matchNodeKeyRef.current,
          start: matchRef.current.start,
          trigger: matchRef.current.trigger,
        }
        matchNodeKeyRef.current = null
        setMatch(null)
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )

    const removePaste = editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        // Duck-typed rather than `instanceof ClipboardEvent`: jsdom (used in
        // tests) has no ClipboardEvent global, but a real paste event always
        // carries a clipboardData with getData.
        const clipboardData = (event as ClipboardEvent | null)?.clipboardData
        if (!clipboardData) {
          return false
        }
        const text = clipboardData.getData('text/plain')
        if (!text) {
          return false
        }
        event.preventDefault()
        editor.update(() => {
          const selection = $getSelection()
          if ($isRangeSelection(selection)) {
            selection.insertText(text)
          }
        })
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )

    return () => {
      removeUpdateListener()
      removeEnter()
      removeArrowDown()
      removeArrowUp()
      removeTab()
      removeEscape()
      removePaste()
    }
  }, [editor])

  function handleToolbarClick(action: ToolbarAction) {
    editor.update(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) {
        return
      }
      const selected = selection.getTextContent()
      selection.insertText(action.wrap(selected))
    })
    editor.focus()
  }

  const sendDisabled = isEmpty || !!disabled
  const menuVisible = isMenuVisible(match !== null, items.length, degraded)

  return (
    <>
      <Group gap={4}>
        {TOOLBAR_ACTIONS.map((action) => (
          <Tooltip key={action.label} label={action.label}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={action.label}
              disabled={disabled}
              onClick={() => handleToolbarClick(action)}
            >
              {action.icon}
            </ActionIcon>
          </Tooltip>
        ))}
      </Group>
      <Group align="flex-end" gap="xs" wrap="nowrap">
        <Box pos="relative" style={{ flex: 1 }}>
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                aria-label="Reply…"
                disabled={disabled}
                style={{
                  minHeight: '2.25rem',
                  maxHeight: '16rem',
                  overflowY: 'auto',
                  padding: '0.5rem',
                  borderRadius: 4,
                  border: '1px solid var(--mantine-color-dark-4)',
                  outline: 'none',
                }}
              />
            }
            placeholder={
              <Box
                pos="absolute"
                top={8}
                left={12}
                c="dimmed"
                style={{ pointerEvents: 'none' }}
              >
                Reply…
              </Box>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          {menuVisible && (
            <Box pos="absolute" bottom="100%" left={0} mb={4} style={{ zIndex: 10 }}>
              <AutocompleteMenu
                items={items}
                highlightedId={highlightedKey}
                degraded={degraded}
                onSelect={(item) => insertMentionRef.current(item)}
              />
            </Box>
          )}
        </Box>
        <Button onClick={() => handleSendRef.current()} disabled={sendDisabled}>
          Send
        </Button>
      </Group>
    </>
  )
}
