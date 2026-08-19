import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { Attachments, borderColor } from './Attachments'
import type { Attachment } from '../../api/slackApi'

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

const web: Attachment = {
  Title: '#123 Example PR',
  TitleLink: 'https://github.com/example/repo/pull/123',
  Text: 'body &amp; more',
  ServiceName: 'GitHub',
  ServiceIcon: 'https://ex.com/gh.png',
  Footer: 'example/repo',
  FooterIcon: '',
  Color: '36a64f',
  ImageURL: 'https://ex.com/preview.png',
  ThumbURL: '',
  ImageWidth: 571,
  ImageHeight: 243,
  AuthorName: '',
  IsMsgUnfurl: false,
  IsReplyUnfurl: false,
  FromURL: '',
  ChannelID: '',
  IsThreadUnfurl: false,
  Blocks: null,
}

const webNoIcon: Attachment = {
  ...web,
  ServiceIcon: '',
  FooterIcon: '',
}

const thread: Attachment = {
  Title: '',
  TitleLink: '',
  Text: 'preview text',
  ServiceName: '',
  ServiceIcon: '',
  Footer: 'Thread in Slack Conversation',
  FooterIcon: '',
  Color: '',
  ImageURL: '',
  ThumbURL: '',
  ImageWidth: 0,
  ImageHeight: 0,
  AuthorName: 'Test Person',
  IsMsgUnfurl: true,
  IsReplyUnfurl: true,
  FromURL: 'https://x.slack.com/archives/C1/p1700000000000001?thread_ts=1700000000.000001&cid=C1',
  ChannelID: 'C1',
  IsThreadUnfurl: true,
  Blocks: null,
}

const unparseableThread: Attachment = {
  ...thread,
  FromURL: 'https://x.slack.com/not-a-thread-link',
}

describe('borderColor', () => {
  it('leaves an already-hash-prefixed color alone', () => {
    expect(borderColor('#7c0a02')).toBe('#7c0a02')
  })

  it('adds a leading hash to a bare hex color', () => {
    expect(borderColor('36a64f')).toBe('#36a64f')
  })

  it('falls back to a neutral gray for an empty color', () => {
    expect(borderColor('')).toBe('#888')
  })
})

describe('Attachments', () => {
  it('web unfurl: title links to TitleLink and preview image uses the raw external src', () => {
    const { container } = renderWithProvider(<Attachments attachments={[web]} users={{}} emoji={{}} onOpenThread={() => {}} />)
    const link = container.querySelector('a[href="https://github.com/example/repo/pull/123"]')
    expect(link).not.toBeNull()
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://ex.com/preview.png') // direct, NOT /api/file
  })

  it('web unfurl: a javascript: TitleLink renders the title as plain text, not a link', () => {
    // TitleLink comes from Slack's unfurl of a posted URL (attacker-influenceable),
    // so an unsafe scheme must never become a clickable href.
    const unsafe: Attachment = { ...web, TitleLink: 'javascript:alert(1)' }
    const { container, getByText } = renderWithProvider(
      <Attachments attachments={[unsafe]} users={{}} emoji={{}} onOpenThread={() => {}} />,
    )
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(getByText('#123 Example PR')).toBeTruthy()
  })

  it('web unfurl: preview image hides on error', () => {
    // Fixture has only a preview image (no service/footer icons), so there's
    // exactly one <img> to target.
    const { container } = renderWithProvider(<Attachments attachments={[webNoIcon]} users={{}} emoji={{}} onOpenThread={() => {}} />)
    const img = container.querySelector('img')!
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
  })

  it('web unfurl: a broken preview image does not hide a working service favicon', () => {
    // Regression guard: image error state must be per-image, not shared
    // across the whole attachment card.
    const { container } = renderWithProvider(<Attachments attachments={[web]} users={{}} emoji={{}} onOpenThread={() => {}} />)
    const preview = container.querySelector('img[src="https://ex.com/preview.png"]')!
    fireEvent.error(preview)
    expect(container.querySelector('img[src="https://ex.com/preview.png"]')).toBeNull()
    expect(container.querySelector('img[src="https://ex.com/gh.png"]')).not.toBeNull()
  })

  it('renders nothing for an app unfurl with no title/text/service/footer/image', () => {
    // Confluence/Jira app unfurls (is_app_unfurl) put their content in Block
    // Kit `blocks` (rendered in v3d), not the title/text fields, so all the
    // fields our web card reads are empty. It must render nothing rather than
    // an empty bordered card.
    const empty: Attachment = {
      ...web,
      Title: '',
      TitleLink: '',
      Text: '',
      ServiceName: '',
      ServiceIcon: '',
      Footer: '',
      FooterIcon: '',
      ImageURL: '',
      ThumbURL: '',
      Color: '#2684ff',
    }
    const { container } = renderWithProvider(<Attachments attachments={[empty]} users={{}} emoji={{}} onOpenThread={() => {}} />)
    expect(container.querySelector('.mantine-Paper-root')).toBeNull()
  })

  it('app unfurl with only blocks renders the block content (not hidden)', () => {
    const appUnfurl: Attachment = {
      ...web,
      Title: '', TitleLink: '', Text: '', ServiceName: '', ServiceIcon: '',
      Footer: '', FooterIcon: '', ImageURL: '', ThumbURL: '', Color: '#2684ff',
      Blocks: [
        { Type: 'section', Text: { Type: 'mrkdwn', Text: 'Confluence page summary' },
          Elements: null, Accessory: null, ImageURL: '', AltText: '', RichText: null },
      ],
    }
    const { getByText } = renderWithProvider(
      <Attachments attachments={[appUnfurl]} users={{}} emoji={{}} onOpenThread={() => {}} />,
    )
    expect(getByText('Confluence page summary')).toBeTruthy()
  })

  it('app unfurl with only unsupported blocks stays hidden', () => {
    const appUnfurl: Attachment = {
      ...web,
      Title: '', TitleLink: '', Text: '', ServiceName: '', ServiceIcon: '',
      Footer: '', FooterIcon: '', ImageURL: '', ThumbURL: '', Color: '#2684ff',
      Blocks: [
        { Type: 'unsupported', Text: null, Elements: null, Accessory: null, ImageURL: '', AltText: '', RichText: null },
      ],
    }
    const { container } = renderWithProvider(
      <Attachments attachments={[appUnfurl]} users={{}} emoji={{}} onOpenThread={() => {}} />,
    )
    expect(container.querySelector('.mantine-Paper-root')).toBeNull()
  })

  it('thread unfurl: Open thread click calls onOpenThread foreground; Cmd+click background', () => {
    const onOpenThread = vi.fn()
    const { getByRole } = renderWithProvider(<Attachments attachments={[thread]} users={{}} emoji={{}} onOpenThread={onOpenThread} />)
    const btn = getByRole('button', { name: /open thread/i })
    fireEvent.click(btn)
    expect(onOpenThread).toHaveBeenLastCalledWith(thread.FromURL, { background: false })
    fireEvent.click(btn, { metaKey: true })
    expect(onOpenThread).toHaveBeenLastCalledWith(thread.FromURL, { background: true })
  })

  it('thread unfurl with unparseable FromURL renders the card but omits the Open thread button', () => {
    const { getByText, queryByRole } = renderWithProvider(
      <Attachments attachments={[unparseableThread]} users={{}} emoji={{}} onOpenThread={() => {}} />,
    )
    expect(getByText('preview text')).toBeTruthy()
    expect(queryByRole('button', { name: /open thread/i })).toBeNull()
  })
})
