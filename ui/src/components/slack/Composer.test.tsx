import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
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
    fireEvent.mouseDown(await findByText('ada'))
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
    await findByText('ada') // menu is open
    fireEvent.keyDown(editorEl, { key: 'Enter' })
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
    await findByText('ada') // menu is open
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
    vi.spyOn(api, 'autocomplete').mockResolvedValue([])
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole, findByText, queryByRole } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())
    setEditorText(getEditor(), 'hi @zo')
    // No local candidates (users={}) and the mocked server also returns [],
    // so there is nothing to select — the degraded hint appears as inline
    // text, but no popup (no listbox) is rendered for it.
    await findByText(/workspace search unavailable/i)
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
    await findByText('ada') // menu open at the first "@" occurrence
    fireEvent.keyDown(editorEl, { key: 'Escape' })

    // Select-all + retype: a brand-new occurrence at the same block offset,
    // not a continuation of the dismissed one.
    autocomplete.mockResolvedValueOnce([{ kind: 'user', id: 'U2', label: 'bo', token: '<@U2>' }])
    setEditorText(getEditor(), '@bo')
    await findByText('bo') // must reopen, not stay suppressed
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
    await findByText('ada') // menu open, backed by the debounced fetch resolving
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
    await findByText('ada') // menu open, backed by the debounced fetch resolving
    fireEvent.keyDown(editorEl, { key: 'Escape' })
    expect(queryByText('ada')).toBeNull()

    insertTextAt(getEditor(), 0, 'x ') // edit BEFORE the trigger, same text node
    moveCaretTo(getEditor(), 'x hello @ad'.length) // click back after the "d"
    await sleep(400) // see the settle-not-poll comment in the test above
    expect(queryByText('ada')).toBeNull() // must NOT have reopened

    fireEvent.keyDown(editorEl, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('x hello @ad')
  })
})
