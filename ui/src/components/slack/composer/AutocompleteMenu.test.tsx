import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { AutocompleteMenu } from './AutocompleteMenu'
import type { AutocompleteItem } from '../../../api/slackApi'

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

afterEach(cleanup)

const items: AutocompleteItem[] = [
  { kind: 'user', id: 'U1', label: 'ada', detail: 'aroberts', token: '<@U1>' },
  { kind: 'special', id: 'here', label: '@here', detail: 'Notify everyone online', token: '<!here>' },
]

function renderMenu(props: Partial<React.ComponentProps<typeof AutocompleteMenu>> = {}) {
  return render(
    <MantineProvider>
      <AutocompleteMenu items={items} highlightedId="user:U1" onSelect={() => {}} {...props} />
    </MantineProvider>,
  )
}

describe('AutocompleteMenu', () => {
  it('renders every candidate with its label and detail', () => {
    const { getByText } = renderMenu()
    expect(getByText('ada')).toBeInTheDocument()
    expect(getByText('aroberts')).toBeInTheDocument()
    expect(getByText('@here')).toBeInTheDocument()
  })

  it('marks the highlighted row for assistive tech', () => {
    const { getAllByRole } = renderMenu()
    const options = getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
  })

  it('calls onSelect with the item when a row is clicked', () => {
    const onSelect = vi.fn()
    const { getByText } = renderMenu({ onSelect })
    // AutocompleteMenu handles onMouseDown (not onClick) so the editor never
    // loses the caret to a focus change before the insertion runs; fireEvent
    // .click does not synthesize a mousedown in this Testing Library version,
    // so exercise the handler directly per the task brief's fallback.
    fireEvent.mouseDown(getByText('@here'))
    expect(onSelect).toHaveBeenCalledWith(items[1])
  })

  it('prevents the mousedown default so the editor keeps its caret focus', () => {
    // This is the entire reason mousedown is used over click: without
    // preventDefault, clicking a row would blur the editor before the
    // insertion runs. Dispatch a real event and inspect it directly, so the
    // test fails if the handler stops calling preventDefault — asserting
    // only that onSelect fired (as the previous test does) would not catch
    // that regression, since removing preventDefault leaves onSelect intact.
    const { getByText } = renderMenu()
    const row = getByText('@here')
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    row.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('routes avatars and custom-emoji images through the app proxies', () => {
    // Direct slack-edge.com hotlinks are blocked/403 from the browser — every
    // other call site (Message.tsx, renderEmoji.tsx, ReactionPill.tsx) proxies
    // them, and the menu must too or its images are simply broken.
    const { container } = renderMenu({
      items: [
        { kind: 'user', id: 'U1', label: 'ada', avatar: 'https://avatars.slack-edge.com/a.png', token: '<@U1>' },
        {
          kind: 'emoji',
          id: 'smile-cry',
          label: ':smile-cry:',
          imageUrl: 'https://emoji.slack-edge.com/y.png',
          token: ':smile-cry:',
        },
      ],
      highlightedId: 'user:U1',
    })
    const srcs = Array.from(container.querySelectorAll('img')).map((i) => i.getAttribute('src'))
    expect(srcs).toContain(`/api/slack-avatar?url=${encodeURIComponent('https://avatars.slack-edge.com/a.png')}`)
    expect(srcs).toContain(`/api/slack-emoji?url=${encodeURIComponent('https://emoji.slack-edge.com/y.png')}`)
  })

  it('renders a standard Unicode emoji as the character itself', () => {
    const { getByText } = renderMenu({
      items: [{ kind: 'emoji', id: 'smile', label: ':smile:', token: ':smile:' }],
      highlightedId: 'emoji:smile',
    })
    expect(getByText('\u{1F604}')).toBeInTheDocument()
  })

  it('renders nothing when there are no items', () => {
    // Not toBeEmptyDOMElement(container): MantineProvider itself injects a
    // <style> tag into the render container in this Mantine version, so the
    // container is never literally empty regardless of what this component
    // renders. Assert on the component's own output — no listbox — instead.
    // (The component's only caller, Composer.tsx, never actually renders it
    // with an empty list — see fix-round-3's `menuVisible` — but this guard
    // is retained as cheap defensive insurance for the component itself.)
    const { queryByRole } = renderMenu({ items: [] })
    expect(queryByRole('listbox')).not.toBeInTheDocument()
  })
})
