import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ActionIcon, Box, Button, Group, Stack, Text, Tooltip } from '@mantine/core'
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
 *  read by the render (whether to show the popup), the Enter-key guard
 *  (whether to swallow Enter instead of sending) and the Escape-key guard.
 *  They must never disagree — a visible popup that Enter can fall through is
 *  how Enter posts a half-typed mention (fix-round-1 finding 1). `degraded`
 *  deliberately plays no part: a popup with zero items to select is not
 *  something Enter or Escape should treat as "open" (fix-round-2 ruling) —
 *  the degraded hint is shown separately, outside the popup, and never
 *  blocks sending. */
function isMenuVisible(hasMatch: boolean, itemCount: number): boolean {
  return hasMatch && itemCount > 0
}

/** Identifies one dismissed trigger *occurrence*: the text node it lives in,
 *  its trigger character, and the query typed at the moment of dismissal.
 *
 * Deliberately NOT keyed by any numeric offset (fix-round-2 open finding 1):
 * `detectTrigger`'s `start` is an offset from the start of the BLOCK, so
 * editing text anywhere before the trigger (even in the same text node)
 * shifts it, even though the trigger occurrence itself hasn't moved. Instead,
 * two detections in the SAME node with the SAME trigger character are treated
 * as the same occurrence if one query is a prefix of the other — covering
 * "caret moved away and back with no edit" (query unchanged), "the user kept
 * typing/backspacing within it" (query grew or shrank), and edits elsewhere
 * in the block (query unaffected either way). A occurrence in a DIFFERENT
 * node (e.g. after a select-all-and-retype) is never treated as the same,
 * regardless of query, so a genuinely new mention always reopens the menu.
 *
 * Trade-off, accepted deliberately: two textually-identical trigger
 * occurrences in the very same node (e.g. "@ad code @ad" — both spans read
 * "@ad") are not disambiguated by position. Escaping the first would also
 * suppress the second if the caret lands on it. No finding requires
 * distinguishing that case, and doing so would need a per-character marker
 * this editor doesn't otherwise maintain. */
interface SuppressedOccurrence {
  nodeKey: NodeKey
  trigger: TriggerMatch['trigger']
  query: string
}

function isSameSuppressedOccurrence(
  suppressed: SuppressedOccurrence,
  nodeKey: NodeKey,
  detected: TriggerMatch,
): boolean {
  return (
    suppressed.nodeKey === nodeKey &&
    suppressed.trigger === detected.trigger &&
    (detected.query.startsWith(suppressed.query) || suppressed.query.startsWith(detected.query))
  )
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
  // Written from an EFFECT (not the render body — fix-round-2 open finding
  // 3/finding 8): a render that gets abandoned or re-run (React concurrent
  // features) must not leave the command handlers reading state from a
  // render that was never committed.
  const matchRef = useRef(match)
  const itemsRef = useRef(items)
  const highlightedKeyRef = useRef(highlightedKey)
  const disabledRef = useRef(disabled)
  const onSendRef = useRef(onSend)
  useEffect(() => {
    matchRef.current = match
    itemsRef.current = items
    highlightedKeyRef.current = highlightedKey
    disabledRef.current = disabled
    onSendRef.current = onSend
  })

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
        // Atomicity (fix-round-2, "make it an invariant rather than a silent
        // partial"): rather than re-fetching $getSelection() and bailing if
        // it somehow isn't a RangeSelection (which would leave the trigger
        // text deleted with no pill inserted), select the known-good
        // position ourselves. `anchorNode` still exists (we just spliced it)
        // and `start` is within its new bounds by construction
        // (0 <= start <= newLength since start = offset - toDelete and
        // newLength = oldLength - toDelete), so `.select()` cannot fail —
        // there is no failure branch left to have deleted without inserting.
        const insertionPoint = anchorNode.select(start, start)
        insertionPoint.insertNodes([$createMentionNode(item), $createTextNode(' ')])
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
        // occurrence" no matter what lines up.
        if (suppressed && $getNodeByKey(suppressed.nodeKey) === null) {
          suppressed = null
          suppressedRef.current = null
        }
        if (suppressed !== null && isSameSuppressedOccurrence(suppressed, nodeKey, detected)) {
          setMatch(null)
          matchNodeKeyRef.current = null
          return
        }
        // A genuinely new/different occurrence — clear any stale suppression.
        suppressedRef.current = null
        matchNodeKeyRef.current = nodeKey
        setMatch(detected)
      })
    })

    const removeEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        // Enter and "the popup is visibly open" must agree (finding 1): only
        // swallow Enter (and select) when there is an actual popup with
        // items on screen. A degraded/empty state has nothing to select and
        // is not a popup Enter needs to fall through — it just sends.
        if (isMenuVisible(matchRef.current !== null, itemsRef.current.length)) {
          event?.preventDefault()
          selectHighlighted()
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
        if (!isMenuVisible(matchRef.current !== null, itemsRef.current.length)) {
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
        if (!isMenuVisible(matchRef.current !== null, itemsRef.current.length)) {
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
        if (!isMenuVisible(matchRef.current !== null, itemsRef.current.length)) {
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
        // On the unified predicate (fix-round-2 "also"): during the 150ms
        // autocomplete debounce (match set, items still empty, nothing on
        // screen yet), Escape must not swallow the key and record a
        // suppression for a popup the user never actually saw.
        if (!isMenuVisible(matchRef.current !== null, itemsRef.current.length) || !matchNodeKeyRef.current) {
          return false
        }
        suppressedRef.current = {
          nodeKey: matchNodeKeyRef.current,
          trigger: matchRef.current!.trigger,
          query: matchRef.current!.query,
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
  const menuVisible = isMenuVisible(match !== null, items.length)
  // Shown OUTSIDE the popup (ruling: "do not render the popup at all when
  // items.length === 0") so a degraded, candidate-less lookup never blocks
  // Enter from sending — it's informational only.
  const showDegradedHint = match !== null && items.length === 0 && degraded

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
      {showDegradedHint && (
        <Text size="xs" c="dimmed">
          Workspace search unavailable — showing people from this thread
        </Text>
      )}
    </>
  )
}
