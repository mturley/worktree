import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { ActionBar } from './ActionBar'

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

const noop = () => {}

function baseProps() {
  return {
    onMarkRead: noop,
    markReadLoading: false,
    markReadDisabled: false,
    onOpenInSlack: noop,
    openInSlackDisabled: false,
    onCopyLink: noop,
    onRefresh: noop,
    lastUpdated: null,
    now: new Date(),
  }
}

describe('ActionBar', () => {
  it('renders both segments of the Open in Slack split button', () => {
    const { container } = renderWithProvider(<ActionBar {...baseProps()} />)

    expect(container.textContent).toContain('Open in Slack')
    expect(container.querySelector('[aria-label="Copy link to thread"]')).not.toBeNull()
  })

  it('disables the copy segment when openInSlackDisabled is true', () => {
    const { container } = renderWithProvider(<ActionBar {...baseProps()} openInSlackDisabled />)

    const copyButton = container.querySelector('[aria-label="Copy link to thread"]')
    expect(copyButton).not.toBeNull()
    expect((copyButton as HTMLButtonElement).disabled).toBe(true)

    const openButton = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Open in Slack',
    )
    expect(openButton?.disabled).toBe(true)
  })

  it('calls onCopyLink when the copy segment is clicked', () => {
    const onCopyLink = vi.fn()
    const { container } = renderWithProvider(<ActionBar {...baseProps()} onCopyLink={onCopyLink} />)

    const copyButton = container.querySelector('[aria-label="Copy link to thread"]') as HTMLButtonElement
    copyButton.click()

    expect(onCopyLink).toHaveBeenCalledTimes(1)
  })

  it('does not call onCopyLink when the copy segment is disabled', () => {
    const onCopyLink = vi.fn()
    const { container } = renderWithProvider(
      <ActionBar {...baseProps()} onCopyLink={onCopyLink} openInSlackDisabled />,
    )

    const copyButton = container.querySelector('[aria-label="Copy link to thread"]') as HTMLButtonElement
    copyButton.click()

    expect(onCopyLink).not.toHaveBeenCalled()
  })
})
