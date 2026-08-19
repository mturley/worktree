import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { Composer } from './Composer'

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

describe('Composer', () => {
  it('sends on Enter and clears; Shift+Enter inserts a newline', () => {
    const onSend = vi.fn()
    const { getByRole } = renderWithProvider(<Composer onSend={onSend} />)
    const ta = getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled() // shift+enter = newline
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hello')
    expect(ta.value).toBe('')
  })

  it('disables Send for empty/whitespace text', () => {
    const onSend = vi.fn()
    const { getByRole } = renderWithProvider(<Composer onSend={onSend} />)
    const send = getByRole('button', { name: /send/i }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(getByRole('textbox'), { target: { value: '   ' } })
    expect(send.disabled).toBe(true)
  })

  it('does not send when text is only whitespace and Enter is pressed', () => {
    const onSend = vi.fn()
    const { getByRole } = renderWithProvider(<Composer onSend={onSend} />)
    const ta = getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '   ' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('disables Send when disabled prop is true even with text', () => {
    const onSend = vi.fn()
    const { getByRole } = renderWithProvider(<Composer onSend={onSend} disabled />)
    fireEvent.change(getByRole('textbox'), { target: { value: 'hello' } })
    const send = getByRole('button', { name: /send/i }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
  })

  it('bold toolbar wraps the selection in *asterisks*', () => {
    const { getByRole, getByLabelText } = renderWithProvider(<Composer onSend={() => {}} />)
    const ta = getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'word' } })
    ta.setSelectionRange(0, 4)
    fireEvent.click(getByLabelText('Bold'))
    expect(ta.value).toBe('*word*')
  })

  it('strikethrough toolbar wraps the selection in ~tildes~', () => {
    const { getByRole, getByLabelText } = renderWithProvider(<Composer onSend={() => {}} />)
    const ta = getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'word' } })
    ta.setSelectionRange(0, 4)
    fireEvent.click(getByLabelText('Strikethrough'))
    expect(ta.value).toBe('~word~')
  })
})
