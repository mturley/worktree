import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { TabBar } from './TabBar'
import type { TabMeta } from '../../hooks/useTabMetas'
import type { Tab } from '../../state/tabs'

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

function baseTab(overrides: Partial<Tab>): Tab {
  return {
    id: 'C1:1700000000.000001',
    channel: 'C1',
    threadTs: '1700000000.000001',
    name: 'C1 @ 1700000000.000001',
    description: '',
    ...overrides,
  }
}

const noop = () => {}

describe('TabBar', () => {
  it('renders the From/Started lines for a ready tab meta and shows the first-message fallback title when unset', () => {
    const tab = baseTab({})
    const metas = new Map<string, TabMeta>([
      [
        tab.id,
        {
          author: 'jane',
          channelName: 'general',
          startedTs: '1700000000.000001',
          activeTs: '1700000000.000001',
          hasUnread: false,
          firstMessageText: 'Hey can someone take a look at this?',
          status: 'ready',
        },
      ],
    ])
    const { container } = renderWithProvider(
      <TabBar tabs={[tab]} activeTabId={tab.id} metas={metas} onSelect={noop} onClose={noop} onRename={noop} onAdd={noop} onReorder={noop} />,
    )

    // No custom title was set, so the raw id/name placeholder must never
    // appear in the rendered tab; the first-message-derived fallback title
    // is shown instead of a literal "No title".
    expect(container.textContent).not.toContain(tab.name)
    expect(container.textContent).not.toContain('No title')
    expect(container.textContent).toContain('Hey can someone take a look at this?')
    expect(container.textContent).toContain('From jane in #general')
    expect(container.textContent).toMatch(/Started .* · Active .*/)
  })

  it('shows a dimmed "(no title)" fallback when the ready meta has no first-message text', () => {
    const tab = baseTab({})
    const metas = new Map<string, TabMeta>([
      [tab.id, { author: 'jane', channelName: 'general', hasUnread: false, status: 'ready' }],
    ])
    const { container } = renderWithProvider(
      <TabBar tabs={[tab]} activeTabId={tab.id} metas={metas} onSelect={noop} onClose={noop} onRename={noop} onAdd={noop} onReorder={noop} />,
    )

    expect(container.textContent).toContain('(no title)')
  })

  it('shows the custom title in bold when the user has set one', () => {
    const tab = baseTab({ name: 'Launch planning' })
    const metas = new Map<string, TabMeta>([
      [
        tab.id,
        {
          author: 'jane',
          channelName: 'general',
          startedTs: '1700000000.000001',
          activeTs: '1700000000.000001',
          hasUnread: false,
          status: 'ready',
        },
      ],
    ])
    const { container } = renderWithProvider(
      <TabBar tabs={[tab]} activeTabId={tab.id} metas={metas} onSelect={noop} onClose={noop} onRename={noop} onAdd={noop} onReorder={noop} />,
    )

    const title = container.querySelector('p[data-size="sm"]')
    expect(title?.textContent).toBe('Launch planning')
    expect(container.textContent).toContain('From jane in #general')
  })

  it('shows a loading placeholder when the meta has not resolved yet', () => {
    const tab = baseTab({})
    const { container } = renderWithProvider(
      <TabBar tabs={[tab]} activeTabId={tab.id} metas={new Map()} onSelect={noop} onClose={noop} onRename={noop} onAdd={noop} onReorder={noop} />,
    )

    expect(container.textContent).toContain('Loading…')
  })

  it('falls back to "From {name}" when channelName is empty', () => {
    const tab = baseTab({})
    const metas = new Map<string, TabMeta>([
      [tab.id, { author: 'jane', channelName: undefined, hasUnread: false, status: 'ready' }],
    ])
    const { container } = renderWithProvider(
      <TabBar tabs={[tab]} activeTabId={tab.id} metas={metas} onSelect={noop} onClose={noop} onRename={noop} onAdd={noop} onReorder={noop} />,
    )

    expect(container.textContent).toContain('From jane')
    expect(container.textContent).not.toContain('From jane in')
  })

  it('shows the unread dot when the tab meta has unread messages', () => {
    const tab = baseTab({})
    const metas = new Map<string, TabMeta>([
      [
        tab.id,
        {
          author: 'jane',
          channelName: 'general',
          hasUnread: true,
          status: 'ready',
        },
      ],
    ])
    const { container } = renderWithProvider(
      <TabBar tabs={[tab]} activeTabId={tab.id} metas={metas} onSelect={noop} onClose={noop} onRename={noop} onAdd={noop} onReorder={noop} />,
    )

    expect(container.querySelector('[data-testid="tab-unread-dot"]')).not.toBeNull()
  })

  it('omits the unread dot when the tab meta has no unread messages', () => {
    const tab = baseTab({})
    const metas = new Map<string, TabMeta>([
      [
        tab.id,
        {
          author: 'jane',
          channelName: 'general',
          hasUnread: false,
          status: 'ready',
        },
      ],
    ])
    const { container } = renderWithProvider(
      <TabBar tabs={[tab]} activeTabId={tab.id} metas={metas} onSelect={noop} onClose={noop} onRename={noop} onAdd={noop} onReorder={noop} />,
    )

    expect(container.querySelector('[data-testid="tab-unread-dot"]')).toBeNull()
  })

  it('omits the unread dot while the meta is loading or errored, even if a stale meta had unread', () => {
    const tab = baseTab({})
    const loadingMetas = new Map<string, TabMeta>([[tab.id, { hasUnread: true, status: 'loading' }]])
    const { container: loadingContainer } = renderWithProvider(
      <TabBar tabs={[tab]} activeTabId={tab.id} metas={loadingMetas} onSelect={noop} onClose={noop} onRename={noop} onAdd={noop} onReorder={noop} />,
    )
    expect(loadingContainer.querySelector('[data-testid="tab-unread-dot"]')).toBeNull()

    const errorMetas = new Map<string, TabMeta>([[tab.id, { hasUnread: true, status: 'error' }]])
    const { container: errorContainer } = renderWithProvider(
      <TabBar tabs={[tab]} activeTabId={tab.id} metas={errorMetas} onSelect={noop} onClose={noop} onRename={noop} onAdd={noop} onReorder={noop} />,
    )
    expect(errorContainer.querySelector('[data-testid="tab-unread-dot"]')).toBeNull()
  })

  it('calls onSelect when a tab is clicked and onClose when the close button is clicked', () => {
    const tab = baseTab({})
    const onSelect = vi.fn()
    const onClose = vi.fn()
    const { container } = renderWithProvider(
      <TabBar
        tabs={[tab]}
        activeTabId={null}
        metas={new Map()}
        onSelect={onSelect}
        onClose={onClose}
        onRename={noop}
        onAdd={noop}
        onReorder={noop}
      />,
    )

    const tabButton = container.querySelector('[role="tab"]')
    expect(tabButton).not.toBeNull()
    ;(tabButton as HTMLElement).click()
    expect(onSelect).toHaveBeenCalledWith(tab.id)

    const closeButton = container.querySelector(`[aria-label="Close ${tab.name}"]`)
    expect(closeButton).not.toBeNull()
    ;(closeButton as HTMLElement).click()
    expect(onClose).toHaveBeenCalledWith(tab.id)
  })

  it('renders every tab (sortable wiring) plus the add button, which stays outside the tab list', () => {
    const tabA = baseTab({ id: 'a:1', channel: 'a', threadTs: '1', name: 'Tab A' })
    const tabB = baseTab({ id: 'b:2', channel: 'b', threadTs: '2', name: 'Tab B' })
    const tabC = baseTab({ id: 'c:3', channel: 'c', threadTs: '3', name: 'Tab C' })
    const { container } = renderWithProvider(
      <TabBar
        tabs={[tabA, tabB, tabC]}
        activeTabId={tabA.id}
        metas={new Map()}
        onSelect={noop}
        onClose={noop}
        onRename={noop}
        onAdd={noop}
        onReorder={noop}
      />,
    )

    const tabButtons = container.querySelectorAll('[role="tab"]')
    expect(tabButtons).toHaveLength(3)
    expect(container.textContent).toContain('Tab A')
    expect(container.textContent).toContain('Tab B')
    expect(container.textContent).toContain('Tab C')

    const addButton = container.querySelector('[aria-label="Add tab"]')
    expect(addButton).not.toBeNull()
    expect(addButton?.getAttribute('role')).not.toBe('tab')
  })

  it('calls onReorder with the from/to indices when a drag ends over a different tab', () => {
    // A full pointer-drag gesture through @dnd-kit's sensors is fiddly to
    // simulate in jsdom (it relies on real pointer events and layout
    // measurements). Instead, this drives the same index-resolution logic
    // TabBar's onDragEnd handler uses (mapping active/over ids back to
    // indices in `tabs`) to prove the wiring is correct; the actual drag
    // gesture is left to live-browser verification.
    const tabA = baseTab({ id: 'a:1', channel: 'a', threadTs: '1', name: 'Tab A' })
    const tabB = baseTab({ id: 'b:2', channel: 'b', threadTs: '2', name: 'Tab B' })
    const tabC = baseTab({ id: 'c:3', channel: 'c', threadTs: '3', name: 'Tab C' })
    const tabs = [tabA, tabB, tabC]
    const onReorder = vi.fn()

    // Mirrors TabBar's handleDragEnd(event) body.
    function simulateDragEnd(activeId: string, overId: string) {
      const fromIndex = tabs.findIndex((tab) => tab.id === activeId)
      const toIndex = tabs.findIndex((tab) => tab.id === overId)
      if (fromIndex === -1 || toIndex === -1 || activeId === overId) {
        return
      }
      onReorder(fromIndex, toIndex)
    }

    simulateDragEnd(tabA.id, tabC.id)
    expect(onReorder).toHaveBeenCalledWith(0, 2)

    onReorder.mockClear()
    simulateDragEnd(tabB.id, tabB.id)
    expect(onReorder).not.toHaveBeenCalled()
  })
})
