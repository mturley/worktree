import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
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

  it('Escape closes the menu and lets Enter send again', async () => {
    const onSend = vi.fn()
    vi.spyOn(api, 'autocomplete').mockResolvedValue([])
    const { getEditor, onEditorReady } = grabEditor()
    const { getByRole } = renderWithProvider(
      <Composer onSend={onSend} channel="C1" users={{}} groups={{}} onEditorReady={onEditorReady} />,
    )
    const editorEl = getByRole('textbox')
    await waitFor(() => getEditor())
    setEditorText(getEditor(), 'plain text')
    fireEvent.keyDown(editorEl, { key: 'Escape' })
    fireEvent.keyDown(editorEl, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('plain text')
  })
})
