import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $createLineBreakNode,
  $createTextNode,
  type ElementNode,
  type LexicalEditor,
} from 'lexical'
import { Composer } from './Composer'
import * as api from '../../api/slackApi'

// RTL's queries are scoped to document.body by default; without cleanup
// between tests, renders from earlier tests remain in the DOM and multi-test
// files start matching multiple elements.
afterEach(cleanup)

// jsdom doesn't implement window.matchMedia; MantineProvider's color-scheme
// effect needs it, so stub a minimal version for this test file only.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

/** These `findByText` waits are SETUP, not the assertion: every one of them is
 *  waiting out the composer's 150ms autocomplete debounce plus a mocked fetch
 *  plus a React commit before the test does the thing it is actually about.
 *  Testing Library's 1000ms default is uncomfortably close to that chain under
 *  a loaded parallel run, and a timeout there fails the test for a reason that
 *  has nothing to do with the behaviour under test. A generous timeout costs
 *  nothing (a passing test still resolves as soon as the menu appears) and
 *  means any future failure here is unambiguously about the behaviour. */
const MENU_WAIT = { timeout: 10_000 }

function renderWithProvider(ui: React.ReactElement) {
  return render(<MantineProvider>{ui}</MantineProvider>)
}

/** jsdom's contenteditable support is too thin for simulated keystrokes to
 *  reliably reach Lexical's DOM mutation observer, so these tests drive the
 *  editor directly through its own API (obtained via the test-only
 *  `onEditorReady` prop) rather than simulated typing. This still exercises
 *  the real code paths (selection, node insertion, update listeners) that
 *  typing would drive — only the input mechanism differs. Keyboard shortcuts
 *  (Enter/Shift+Enter/Escape) are still dispatched as real DOM events via
 *  `fireEvent.keyDown`, since Lexical's command handlers are registered on
 *  the root editor element and jsdom delivers those fine. */
function grabEditor(): { getEditor: () => LexicalEditor; onEditorReady: (editor: LexicalEditor) => void } {
  let editor: LexicalEditor | undefined
  return {
    onEditorReady: (e) => {
      editor = e
    },
    getEditor: () => {
      if (!editor) throw new Error('editor not ready')
      return editor
    },
  }
}

/** Replaces the editor's whole content with `text`, then leaves the caret at
 *  the end (so trigger detection re-runs against it, as it would after real
 *  typing). */
function setEditorText(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot()
      const paragraph = root.getFirstChild() as ElementNode | null
      if (!paragraph) {
        return
      }
      for (const child of paragraph.getChildren()) {
        child.remove()
      }
      paragraph.append($createTextNode(text))
      paragraph.selectEnd()
    },
    { discrete: true },
  )
}

/** Inserts `text` at the end of the editor's content, without clearing what
 *  is already there (e.g. an already-inserted mention pill). */
function appendEditorText(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot()
      const paragraph = root.getFirstChild() as ElementNode | null
      if (!paragraph) {
        return
      }
      paragraph.selectEnd()
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        selection.insertText(text)
      }
    },
    { discrete: true },
  )
}

/** Selects the full text of the editor's first (and only) text node, for
 *  driving the toolbar-wrap tests. */
function selectAll(editor: LexicalEditor) {
  editor.update(
    () => {
      const root = $getRoot()
      const paragraph = root.getFirstChild() as ElementNode | null
      const textNode = paragraph?.getFirstChild()
      if (!textNode) {
        return
      }
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        selection.anchor.set(textNode.getKey(), 0, 'text')
        selection.focus.set(textNode.getKey(), textNode.getTextContentSize(), 'text')
      }
    },
    { discrete: true },
  )
}

/** Moves the caret within the editor's existing first text node WITHOUT
 *  editing any text — for driving "click elsewhere, then click back" style
 *  scenarios (the caret-move-then-return case in finding 3), where reusing
 *  `setEditorText` would create a fresh text node and defeat the point. */
function moveCaretTo(editor: LexicalEditor, offset: number) {
  editor.update(
    () => {
      const root = $getRoot()
      const paragraph = root.getFirstChild() as ElementNode | null
      const textNode = paragraph?.getFirstChild()
      if (!textNode || !$isTextNode(textNode)) {
        return
      }
      textNode.select(offset, offset)
    },
    { discrete: true },
  )
}

/** Inserts `text` at `offset` within the editor's existing first text node,
 *  splicing into it (preserving its node key) rather than replacing it —
 *  for the "the user fixed a typo earlier in the line" scenario (fix-round-2
 *  open finding 1), where `setEditorText` would create a fresh node and
 *  defeat the point of the repro. */
function insertTextAt(editor: LexicalEditor, offset: number, text: string) {
  editor.update(
    () => {
      const root = $getRoot()
      const paragraph = root.getFirstChild() as ElementNode | null
      const textNode = paragraph?.getFirstChild()
      if (!textNode || !$isTextNode(textNode)) {
        return
      }
      textNode.select(offset, offset)
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        selection.insertText(text)
      }
    },
    { discrete: true },
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Replaces `deleteCount` characters starting at `offset` in the editor's
 *  first text node with `newText`, splicing in place (preserving the node's
 *  key) — for turning one trigger occurrence into a DIFFERENT trigger
 *  character at the exact same node position, without creating a new node. */
function replaceRangeInNode(editor: LexicalEditor, offset: number, deleteCount: number, newText: string) {
  editor.update(
    () => {
      const root = $getRoot()
      const paragraph = root.getFirstChild() as ElementNode | null
      const textNode = paragraph?.getFirstChild()
      if (!textNode || !$isTextNode(textNode)) {
        return
      }
      textNode.spliceText(offset, deleteCount, newText, true)
    },
    { discrete: true },
  )
}

/** Appends `text` as a BRAND-NEW, separate text-node sibling, after a
 *  LineBreakNode — as opposed to `appendEditorText`, which splices into the
 *  existing last text node. A LineBreakNode is the separator (rather than
 *  just appending two adjacent TextNodes) because Lexical's reconciler
 *  merges directly-adjacent TextNodes of identical format into one during
 *  commit (confirmed empirically: two appended TextNodes rendered, and were
 *  detected, as a single merged run) — a LineBreakNode between them is not a
 *  TextNode, so it blocks that merge and keeps them genuinely distinct nodes.
 *  Used to build a second, unmergeable node (distinct key) after an existing
 *  one, without touching the existing node at all — for testing that the
 *  suppression key's node-identity component actually matters (fix-round-3's
 *  requested test-gap coverage). Leaves the caret at the end of the new node. */
function appendNewTextNode(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot()
      const paragraph = root.getFirstChild() as ElementNode | null
      if (!paragraph) {
        return
      }
      const node = $createTextNode(text)
      paragraph.append($createLineBreakNode(), node)
      node.selectEnd()
    },
    { discrete: true },
  )
}

describe('Composer', () => {
  it('sends on Enter and clears; Shift+Enter inserts a newline', async () => {
    const onSend = vi.fn()
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole } = renderWithProvider(<Composer onSend={onSend} onEditorReady={onEditorReady} />)
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())
    setEditorText(getEditor(), 'hello')

    fireEvent.keyDown(editorEl, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled() // shift+enter = newline
    // Assert the newline actually landed in the model (serialization is
    // $getRoot().getTextContent(), so a real line break must show up in it),
    // not just that onSend wasn't called for some unrelated reason.
    await waitFor(() => {
      const text = getEditor().getEditorState().read(() => $getRoot().getTextContent())
      expect(text).toBe('hello\n')
    })

    fireEvent.keyDown(editorEl, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hello')
    await waitFor(() => {
      const text = getEditor().getEditorState().read(() => $getRoot().getTextContent())
      expect(text).toBe('')
    })
  })

  it('disables Send for empty/whitespace text', async () => {
    const onSend = vi.fn()
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole } = renderWithProvider(<Composer onSend={onSend} onEditorReady={onEditorReady} />)
    await waitFor(() => getEditor())
    const send = getByRole('button', { name: /send/i }) as HTMLButtonElement
    expect(send.disabled).toBe(true)

    setEditorText(getEditor(), '   ')
    await waitFor(() => expect(send.disabled).toBe(true))
  })

  it('does not send when text is only whitespace and Enter is pressed', async () => {
    const onSend = vi.fn()
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole } = renderWithProvider(<Composer onSend={onSend} onEditorReady={onEditorReady} />)
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())
    setEditorText(getEditor(), '   ')
    fireEvent.keyDown(editorEl, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('disables Send when disabled prop is true even with text', async () => {
    const onSend = vi.fn()
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole } = renderWithProvider(<Composer onSend={onSend} disabled onEditorReady={onEditorReady} />)
    await waitFor(() => getEditor())
    setEditorText(getEditor(), 'hello')
    const send = getByRole('button', { name: /send/i }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
  })

  it('bold toolbar wraps the selection in *asterisks*', async () => {
    const { getEditor, onEditorReady } = grabEditor()
    const { getByLabelText } = renderWithProvider(<Composer onSend={() => {}} onEditorReady={onEditorReady} />)
    await waitFor(() => getEditor())
    setEditorText(getEditor(), 'word')
    selectAll(getEditor())
    fireEvent.click(getByLabelText('Bold'))
    await waitFor(() => {
      const text = getEditor().getEditorState().read(() => $getRoot().getTextContent())
      expect(text).toBe('*word*')
    })
  })

  it('strikethrough toolbar wraps the selection in ~tildes~', async () => {
    const { getEditor, onEditorReady } = grabEditor()
    const { getByLabelText } = renderWithProvider(<Composer onSend={() => {}} onEditorReady={onEditorReady} />)
    await waitFor(() => getEditor())
    setEditorText(getEditor(), 'word')
    selectAll(getEditor())
    fireEvent.click(getByLabelText('Strikethrough'))
    await waitFor(() => {
      const text = getEditor().getEditorState().read(() => $getRoot().getTextContent())
      expect(text).toBe('~word~')
    })
  })

  it('inserts a pill and sends its token, not the typed name', async () => {
    const onSend = vi.fn()
    vi.spyOn(api, 'autocomplete').mockResolvedValue([
      { kind: 'user', id: 'U1', label: 'ada', detail: 'aroberts', token: '<@U1>' },
    ])
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())
    setEditorText(getEditor(), 'hi @ada')
    fireEvent.mouseDown(await findByText('ada', undefined, MENU_WAIT))
    await waitFor(() => {
      const text = getEditor().getEditorState().read(() => $getRoot().getTextContent())
      expect(text).toBe('hi <@U1> ')
    })
    appendEditorText(getEditor(), '!')
    fireEvent.keyDown(editorEl, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hi <@U1> !')
  })

  it('Enter picks a candidate instead of sending while the menu is open', async () => {
    const onSend = vi.fn()
    vi.spyOn(api, 'autocomplete').mockResolvedValue([{ kind: 'user', id: 'U1', label: 'ada', token: '<@U1>' }])
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())
    setEditorText(getEditor(), '@ada')
    await findByText('ada', undefined, MENU_WAIT) // menu is open
    fireEvent.keyDown(editorEl, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  // Regression: the command handlers read `matchRef`/`itemsRef`, which are
  // mirrored from state in an effect. If that mirror were a PASSIVE effect,
  // there is a window between "the menu's DOM has landed" and "the refs the
  // Enter handler reads are current" — React schedules passive effects on a
  // macrotask, while anything observing the DOM (a MutationObserver, which is
  // what Testing Library's `findBy*` uses, or the browser dispatching the
  // user's next keystroke) runs first. A keypress landing in that window read
  // `itemsRef.current.length === 0`, decided the menu was closed, and SENT.
  //
  // This drives that window deterministically: Enter is dispatched from a
  // MutationObserver callback, i.e. the earliest possible moment after the
  // menu is in the DOM. It fails against a passive mirror and passes against
  // a layout one.
  it('Enter picks a candidate the instant the menu lands in the DOM', async () => {
    const onSend = vi.fn()
    vi.spyOn(api, 'autocomplete').mockResolvedValue([{ kind: 'user', id: 'U1', label: 'ada', token: '<@U1>' }])
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, queryByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())

    let pressed = false
    const observer = new MutationObserver(() => {
      if (pressed || !queryByText('ada')) {
        return
      }
      pressed = true
      observer.disconnect()
      fireEvent.keyDown(editorEl, { key: 'Enter' })
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    try {
      setEditorText(getEditor(), '@ada')
      await waitFor(() => expect(pressed).toBe(true), MENU_WAIT)
    } finally {
      observer.disconnect()
    }
    expect(onSend).not.toHaveBeenCalled()
  })

  it('Tab accepts the highlighted candidate while the menu is open, like Enter', async () => {
    const onSend = vi.fn()
    vi.spyOn(api, 'autocomplete').mockResolvedValue([{ kind: 'user', id: 'U1', label: 'ada', token: '<@U1>' }])
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText, queryByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())
    setEditorText(getEditor(), '@ada')
    await findByText('ada', undefined, MENU_WAIT) // menu is open
    fireEvent.keyDown(editorEl, { key: 'Tab' })
    expect(onSend).not.toHaveBeenCalled()
    await waitFor(() => {
      const text = getEditor().getEditorState().read(() => $getRoot().getTextContent())
      expect(text).toBe('<@U1> ')
    })
    // The menu closes once the pill is inserted.
    expect(queryByText('ada')).not.toBeInTheDocument()
  })

  it('Tab with the menu closed does not insert anything', async () => {
    const onSend = vi.fn()
    vi.spyOn(api, 'autocomplete').mockResolvedValue([])
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())
    setEditorText(getEditor(), 'no trigger here')
    fireEvent.keyDown(editorEl, { key: 'Tab' })
    const text = getEditor().getEditorState().read(() => $getRoot().getTextContent())
    expect(text).toBe('no trigger here')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('Escape closes the menu and Enter sends the literal text once it is dismissed', async () => {
    const onSend = vi.fn()
    vi.spyOn(api, 'autocomplete').mockResolvedValue([{ kind: 'user', id: 'U1', label: 'ada', token: '<@U1>' }])
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())
    setEditorText(getEditor(), 'hello @ada')
    await findByText('ada', undefined, MENU_WAIT) // menu is open
    fireEvent.keyDown(editorEl, { key: 'Escape' })
    fireEvent.keyDown(editorEl, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hello @ada')
  })

  // Fix-round-1 regression coverage (task-15-report.md fix round 1), revised
  // in fix round 2 per the ruling: a degraded, candidate-less lookup no
  // longer renders a popup at all (previously it did, and Enter swallowed
  // the key to avoid falling through it — which meant a message ending in
  // an unmatched mention could not be sent without first pressing Escape).

  it('Enter sends normally when the lookup is degraded and there is nothing to select (finding 1 / round-2 ruling)', async () => {
    const onSend = vi.fn()
    // null, not []: null is a FAILED lookup, which is the only thing that
    // degrades. [] would be a healthy "nobody by that name" and must not
    // raise the hint at all (see slackApi.autocomplete's contract).
    vi.spyOn(api, 'autocomplete').mockResolvedValue(null)
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText, queryByRole } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())
    setEditorText(getEditor(), 'hi @zo')
    // No local candidates (users={}) and the server lookup failed, so there
    // is nothing to select — the degraded hint appears as inline text, but
    // no popup (no listbox) is rendered for it.
    await findByText(/workspace search unavailable/i, undefined, MENU_WAIT)
    expect(queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.keyDown(editorEl, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hi @zo')
  })

  it('reopens the menu for a brand-new mention typed at the same position after Escape (finding 2)', async () => {
    const onSend = vi.fn()
    const autocomplete = vi.spyOn(api, 'autocomplete')
    autocomplete.mockResolvedValueOnce([{ kind: 'user', id: 'U1', label: 'ada', token: '<@U1>' }])
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())

    setEditorText(getEditor(), '@ada')
    await findByText('ada', undefined, MENU_WAIT) // menu open at the first "@" occurrence
    fireEvent.keyDown(editorEl, { key: 'Escape' })

    // Select-all + retype: a brand-new occurrence at the same block offset,
    // not a continuation of the dismissed one.
    autocomplete.mockResolvedValueOnce([{ kind: 'user', id: 'U2', label: 'bo', token: '<@U2>' }])
    setEditorText(getEditor(), '@bo')
    await findByText('bo', undefined, MENU_WAIT) // must reopen, not stay suppressed
  })

  it('stays closed across a caret move away and back with no edit, but sends the literal text (finding 3)', async () => {
    const onSend = vi.fn()
    vi.spyOn(api, 'autocomplete').mockResolvedValue([{ kind: 'user', id: 'U1', label: 'ada', token: '<@U1>' }])
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText, queryByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())

    setEditorText(getEditor(), 'hello @ad')
    await findByText('ada', undefined, MENU_WAIT) // menu open, backed by the debounced fetch resolving
    fireEvent.keyDown(editorEl, { key: 'Escape' })
    expect(queryByText('ada')).toBeNull()

    moveCaretTo(getEditor(), 0) // click at line start — no trigger under the caret
    moveCaretTo(getEditor(), 'hello @ad'.length) // click back after the "d"
    // Asserting a NEGATIVE (the menu did not reopen) can't be expressed as
    // "wait until this becomes true" — there is no event to wait for when
    // the code is behaving correctly. Instead settle past the 150ms
    // autocomplete debounce with margin before asserting: 400ms is enough
    // that, if the code were wrong and had kicked off a fresh (unsuppressed)
    // lookup, its resolution would have landed by the time we check (see the
    // fix-round-2 report for the pre-fix-vs-post-fix timing this was
    // verified against).
    await sleep(400)
    expect(queryByText('ada')).toBeNull() // must NOT have reopened

    fireEvent.keyDown(editorEl, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hello @ad')
  })

  it('stays closed across an edit BEFORE the trigger in the same text node, then sends the literal text (fix-round-2 open finding 1)', async () => {
    // detectTrigger's `start` is an offset from the start of the BLOCK, not
    // from the trigger's own text node — so an edit earlier in the line
    // (even within the same node) shifts it, even though the trigger
    // occurrence itself hasn't moved. This reproduces exactly that: fix a
    // typo before "@ad", then return to the mention, rather than a bare
    // caret move with no edit at all (which the test above already covers).
    const onSend = vi.fn()
    vi.spyOn(api, 'autocomplete').mockResolvedValue([{ kind: 'user', id: 'U1', label: 'ada', token: '<@U1>' }])
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText, queryByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())

    setEditorText(getEditor(), 'hello @ad')
    await findByText('ada', undefined, MENU_WAIT) // menu open, backed by the debounced fetch resolving
    fireEvent.keyDown(editorEl, { key: 'Escape' })
    expect(queryByText('ada')).toBeNull()

    insertTextAt(getEditor(), 0, 'x ') // edit BEFORE the trigger, same text node
    moveCaretTo(getEditor(), 'x hello @ad'.length) // click back after the "d"
    await sleep(400) // see the settle-not-poll comment in the test above
    expect(queryByText('ada')).toBeNull() // must NOT have reopened

    fireEvent.keyDown(editorEl, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('x hello @ad')
  })

  // Fix-round-3 regression coverage: round 2's query-prefix suppression key
  // over-generalized. Escaping a bare "@" (query "") made every later query
  // in the same node "start with ''" and stay suppressed forever (new
  // finding 1); escaping "@ad" also wrongly suppressed unrelated later
  // "@ada"/"@adam" mentions, not just literal duplicates (new finding 2).

  it('escaping a bare "@" does not disable mentions for the rest of the text node (round-3 new finding 1)', async () => {
    const onSend = vi.fn()
    const autocomplete = vi.spyOn(api, 'autocomplete')
    // Local candidates (@here/@channel/@everyone) already make a bare "@"
    // open a menu with items, with no server round trip required — mock []
    // for the remote side and let a later "ada" query resolve for real.
    autocomplete.mockImplementation(async (_trigger, query) =>
      query === 'ada' ? [{ kind: 'user', id: 'U1', label: 'ada', token: '<@U1>' }] : [],
    )
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    await waitFor(() => getEditor())

    setEditorText(getEditor(), 'hi @')
    await findByText('@here', undefined, MENU_WAIT) // local candidates open the menu for a bare "@"
    fireEvent.keyDown(getByRole('textbox'), { key: 'Escape' })

    // Insert new content right after the escaped "@", including a brand-new
    // "@ada" mention — same repro as the coordinator's observed bug.
    insertTextAt(getEditor(), 'hi @'.length, 'there, @ada')
    await findByText('ada', undefined, MENU_WAIT) // must open for the new mention, not stay suppressed
  })

  it('escaping "@ad" does not suppress a later unrelated "@ada" mention (round-3 new finding 2)', async () => {
    const onSend = vi.fn()
    const autocomplete = vi.spyOn(api, 'autocomplete')
    autocomplete.mockImplementation(async (_trigger, query) => {
      if (query === 'ad') return [{ kind: 'user', id: 'U1', label: 'ad-user', token: '<@U1>' }]
      if (query === 'ada') return [{ kind: 'user', id: 'U2', label: 'ada-user', token: '<@U2>' }]
      return []
    })
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    await waitFor(() => getEditor())

    setEditorText(getEditor(), 'hello @ad')
    await findByText('ad-user', undefined, MENU_WAIT) // menu open for the first mention
    fireEvent.keyDown(getByRole('textbox'), { key: 'Escape' })

    // A second, textually-related but genuinely different mention further
    // along the SAME node — "@ada" is not a literal duplicate of "@ad".
    appendEditorText(getEditor(), ' cc @ada')
    await findByText('ada-user', undefined, MENU_WAIT) // must open, not stay suppressed as if it were "@ad" continued
  })

  it('a mention typed in a different, later text node opens even with an IDENTICAL before-trigger prefix to an escaped mention in an earlier node (test-gap: node-identity component)', async () => {
    // Deliberately gives node B the exact same leading text ("hello ") and
    // trigger character ('@') as node A's escaped occurrence, AND the same
    // node-relative trigger offset (6), so the node key is the ONLY
    // component of the suppression identity that can distinguish them.
    // Confirmed by mutation testing (see the fix-round-4 report): forcing the
    // node-key comparison in `isSuppressedOccurrence` to `true` makes this
    // exact test fail.
    const onSend = vi.fn()
    const autocomplete = vi.spyOn(api, 'autocomplete')
    autocomplete.mockImplementation(async (_trigger, query) => {
      if (query === 'ad') return [{ kind: 'user', id: 'U1', label: 'ad-user', token: '<@U1>' }]
      if (query === 'bo') return [{ kind: 'user', id: 'U2', label: 'bo-user', token: '<@U2>' }]
      return []
    })
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    await waitFor(() => getEditor())

    // Node A: "hello @ad" — open its menu and Escape it, recording a
    // suppression keyed to node A's key, trigger '@', before-text "hello ".
    setEditorText(getEditor(), 'hello @ad')
    await findByText('ad-user', undefined, MENU_WAIT) // confirms the menu opened for node A
    fireEvent.keyDown(getByRole('textbox'), { key: 'Escape' })

    // Node B: a BRAND-NEW, separate text node with the SAME before-trigger
    // text and trigger character, but different content overall and a
    // different query — node A is untouched, not deleted, not edited.
    appendNewTextNode(getEditor(), 'hello @bo')
    await findByText('bo-user', undefined, MENU_WAIT) // node B's mention must open regardless of node A's escaped state
  })

  it('replacing an escaped "@ad" with ":sm" in place reopens the menu (via re-anchoring to null, NOT the trigger comparison)', async () => {
    // NOT coverage of the suppression identity — it is a passenger, kept
    // only because the user-visible behaviour (swap a mention for an emoji
    // in place and the menu comes back) is worth pinning. It survives EVERY
    // single-component mutation, including the trigger comparison it was
    // originally written to isolate: overwriting "@ad" deletes the anchored
    // character, so `reanchorOffset` returns null and the suppression is
    // dropped before any comparison happens. Round 5 verified it only dies
    // under a combined two-mutation break. Do not count it as coverage.
    const onSend = vi.fn()
    const autocomplete = vi.spyOn(api, 'autocomplete')
    autocomplete.mockImplementation(async (trigger, query) => {
      if (trigger === '@' && query === 'ad') return [{ kind: 'user', id: 'U1', label: 'ad-user', token: '<@U1>' }]
      if (trigger === ':' && query === 'sm') return [{ kind: 'emoji', id: 'smile', label: ':smile:', token: ':smile:' }]
      return []
    })
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    await waitFor(() => getEditor())

    // "hello @ad" — open its menu and Escape it (trigger '@', before-text "hello ").
    setEditorText(getEditor(), 'hello @ad')
    await findByText('ad-user', undefined, MENU_WAIT)
    fireEvent.keyDown(getByRole('textbox'), { key: 'Escape' })

    // Replace "@ad" (offsets 6-9) with ":sm" IN PLACE — same node, same
    // before-text "hello ", but a ':' trigger instead of '@'.
    replaceRangeInNode(getEditor(), 'hello '.length, '@ad'.length, ':sm')
    await findByText(':smile:', undefined, MENU_WAIT) // must open — the trigger character differs
  })

  // Fix-round-4 regression coverage. Rounds 2 and 3 both keyed the
  // suppression on a text HEURISTIC (a query prefix, then a before-trigger
  // suffix), and both had a degenerate value ('') that compared true against
  // everything, killing mentions for the rest of the text node after a single
  // Escape. Round 4 keys on the trigger's node-relative OFFSET, re-anchored
  // across edits by the pure `reanchorOffset` (unit-tested exhaustively in
  // composer/suppression.test.ts); these three cover the user-visible
  // behaviour that each earlier scheme got wrong.

  it('escaping a bare "@" at node offset 0 does not suppress a later mention typed after it (round-4)', async () => {
    const onSend = vi.fn()
    const autocomplete = vi.spyOn(api, 'autocomplete')
    autocomplete.mockImplementation(async (_trigger, query) =>
      query === 'ada' ? [{ kind: 'user', id: 'U1', label: 'ada-user', token: '<@U1>' }] : [],
    )
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    await waitFor(() => getEditor())

    // A trigger at node offset 0 — the exact shape that made round 3's
    // before-text key record '' and match everything afterwards.
    setEditorText(getEditor(), '@')
    await findByText('@here', undefined, MENU_WAIT) // local candidates open the menu for a bare "@"
    fireEvent.keyDown(getByRole('textbox'), { key: 'Escape' })

    // Keep typing straight past it, ending in a genuinely new mention.
    appendEditorText(getEditor(), '-team standup at 3, @ada')
    await findByText('ada-user', undefined, MENU_WAIT) // must open for the new mention
  })

  it('escaping "@ad" after a short recurring lead-in does not suppress a later "@bo" (round-4)', async () => {
    // "cc " is exactly the kind of short, repeating lead-in that made round
    // 3's `endsWith(beforeText)` comparison over-match: the second mention's
    // before-text ("cc @adam and cc ") ends with the recorded "cc ".
    const onSend = vi.fn()
    const autocomplete = vi.spyOn(api, 'autocomplete')
    autocomplete.mockImplementation(async (_trigger, query) => {
      if (query === 'ad') return [{ kind: 'user', id: 'U1', label: 'ad-user', token: '<@U1>' }]
      if (query === 'bo') return [{ kind: 'user', id: 'U2', label: 'bo-user', token: '<@U2>' }]
      return []
    })
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    await waitFor(() => getEditor())

    setEditorText(getEditor(), 'cc @ad')
    await findByText('ad-user', undefined, MENU_WAIT)
    fireEvent.keyDown(getByRole('textbox'), { key: 'Escape' })

    appendEditorText(getEditor(), 'am and cc @bo')
    await findByText('bo-user', undefined, MENU_WAIT) // must open — a different occurrence entirely
  })

  it('stays closed while the user keeps typing INTO the same escaped occurrence (round-4)', async () => {
    // The other side of the coin: extending "@ad" to "@ada" is the SAME
    // occurrence, so the dismissed menu must stay dismissed and Enter must
    // send the literal text rather than inserting a pill.
    const onSend = vi.fn()
    const autocomplete = vi.spyOn(api, 'autocomplete')
    autocomplete.mockImplementation(async (_trigger, query) => {
      if (query === 'ad') return [{ kind: 'user', id: 'U1', label: 'ad-user', token: '<@U1>' }]
      if (query === 'ada') return [{ kind: 'user', id: 'U2', label: 'ada-user', token: '<@U2>' }]
      return []
    })
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText, queryByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())

    setEditorText(getEditor(), 'hello @ad')
    await findByText('ad-user', undefined, MENU_WAIT)
    fireEvent.keyDown(editorEl, { key: 'Escape' })

    appendEditorText(getEditor(), 'a') // "hello @ada" — same occurrence, longer query
    await sleep(400) // see the settle-not-poll comment above
    expect(queryByText('ada-user')).toBeNull() // must NOT have reopened

    fireEvent.keyDown(editorEl, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hello @ada')
  })

  it('opens the menu for a trigger typed directly BEFORE an escaped one (round-6)', async () => {
    // Round 5 pinned the opposite of this as an accepted limitation: the
    // prefix branch of the diff won every ambiguous re-anchor, so inserting
    // "@bo" immediately in front of an escaped "@ad" moved the suppression
    // onto the NEWLY TYPED '@' and the menu stayed shut for "@bo" while the
    // old "@ad" went live. Round 6 breaks the tie with the anchored
    // occurrence's own text ("@ad" is still found at offset 6, not at 3), so
    // the escaped occurrence moves right and "@bo" opens normally.
    // `reanchorOffset('hi @ad', 'hi @bo@ad', 3) === 6` is the same fact at
    // the unit level (pinned in suppression.test.ts).
    const onSend = vi.fn()
    const autocomplete = vi.spyOn(api, 'autocomplete')
    autocomplete.mockImplementation(async (_trigger, query) => {
      if (query === 'ad') return [{ kind: 'user', id: 'U1', label: 'ad-user', token: '<@U1>' }]
      if (query === 'bo') return [{ kind: 'user', id: 'U2', label: 'bo-user', token: '<@U2>' }]
      return []
    })
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())

    setEditorText(getEditor(), 'hi @ad')
    await findByText('ad-user', undefined, MENU_WAIT)
    fireEvent.keyDown(editorEl, { key: 'Escape' })

    // Type "@bo" at offset 3 — directly in front of the escaped "@ad".
    insertTextAt(getEditor(), 3, '@bo') // -> "hi @bo@ad", caret after "@bo"
    await sleep(400) // see the settle-not-poll comment above
    expect(await findByText('bo-user', undefined, MENU_WAIT)).toBeInTheDocument() // opens for the newly typed trigger
  })
})
