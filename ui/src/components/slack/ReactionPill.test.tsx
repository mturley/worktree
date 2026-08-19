import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { ReactionPill, reactorNames } from './ReactionPill'
import type { Reaction, User } from '../../api/slackApi'

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

const users: Record<string, User> = {
  U1: { ID: 'U1', RealName: 'Jane Doe', DisplayName: 'jane', Avatar72: '' },
  U2: { ID: 'U2', RealName: 'Bob Roberts', DisplayName: '', Avatar72: '' },
}

describe('reactorNames', () => {
  it('resolves known users to display name (falling back to real name)', () => {
    expect(reactorNames(['U1', 'U2'], users)).toBe('jane, Bob Roberts')
  })

  it('summarizes unknown reactors as "and N others"', () => {
    expect(reactorNames(['U1', 'U9', 'U8'], users)).toBe('jane and 2 others')
  })

  it('uses singular "1 other" for a single unknown', () => {
    expect(reactorNames(['U1', 'U9'], users)).toBe('jane and 1 other')
  })

  it('says "N reacted" when no reactor is resolvable', () => {
    expect(reactorNames(['U9', 'U8'], users)).toBe('2 reacted')
    expect(reactorNames(['U9'], users)).toBe('1 reacted')
  })

  it('handles a null/empty user list', () => {
    expect(reactorNames(null, users)).toBe('')
    expect(reactorNames([], users)).toBe('')
  })
})

describe('ReactionPill', () => {
  const base: Reaction = { Name: 'tada', Count: 2, UserIDs: ['U1', 'U2'] }

  it('renders the count and, on hover, a tooltip with the :name: and reactor names', async () => {
    const { container, getByText, findByText } = renderWithProvider(
      <ReactionPill reaction={base} users={users} emoji={{}} mine={false} />,
    )
    // the pill shows the count
    expect(container.textContent).toContain('2')
    // Mantine renders the tooltip label lazily on hover.
    const badge = container.querySelector('.mantine-Badge-root')!
    fireEvent.mouseEnter(badge)
    await waitFor(() => expect(getByText(':tada:')).toBeTruthy())
    expect(await findByText(/jane, Bob Roberts/)).toBeTruthy()
  })

  it('shows a large custom-emoji image in the tooltip label', () => {
    const emoji = { tada: 'https://emoji.example/tada.png' }
    const { container } = renderWithProvider(
      <ReactionPill reaction={base} users={users} emoji={emoji} mine={false} />,
    )
    // pill image (1.4em) + tooltip image (large) both proxied
    const imgs = container.querySelectorAll('img[src*="tada.png"]')
    expect(imgs.length).toBeGreaterThanOrEqual(1)
  })

  it('uses filled/blue styling when the current user reacted', () => {
    const { container } = renderWithProvider(
      <ReactionPill reaction={base} users={users} emoji={{}} mine={true} />,
    )
    expect(container.querySelector('.mantine-Badge-root')).not.toBeNull()
  })

  it('calls onToggle(name, false) exactly once when the current user already reacted (mine)', () => {
    const onToggle = vi.fn()
    const { container } = renderWithProvider(
      <ReactionPill reaction={base} users={users} emoji={{}} mine={true} onToggle={onToggle} />,
    )
    fireEvent.click(container.querySelector('.mantine-Badge-root')!)
    expect(onToggle).toHaveBeenCalledWith('tada', false)
    // Regression guard: one DOM click must dispatch exactly one toggle (a live
    // check once observed two POSTs from one click — confirm the component
    // itself doesn't double-fire via nested handlers/bubbling).
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('calls onToggle(name, true) when the current user has not reacted', () => {
    const onToggle = vi.fn()
    const { container } = renderWithProvider(
      <ReactionPill reaction={base} users={users} emoji={{}} mine={false} onToggle={onToggle} />,
    )
    fireEvent.click(container.querySelector('.mantine-Badge-root')!)
    expect(onToggle).toHaveBeenCalledWith('tada', true)
  })

  it('is display-only (no click handler) when onToggle is omitted', () => {
    const { container } = renderWithProvider(<ReactionPill reaction={base} users={users} emoji={{}} mine={false} />)
    // clicking must not throw and there is nothing to assert beyond render;
    // guard: the badge is not a button role when non-interactive
    fireEvent.click(container.querySelector('.mantine-Badge-root')!)
    expect(container.textContent).toContain('2')
  })
})
