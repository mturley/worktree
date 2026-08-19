import { afterEach, describe, it, expect } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { FileAttachments } from './FileAttachments'
import type { File } from '../../api/slackApi'

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

const img: File = {
  ID: 'F1',
  Name: 'diagram.png',
  Title: 'diagram.png',
  Mimetype: 'image/png',
  Filetype: 'png',
  PrettyType: 'PNG',
  Size: 12345,
  Permalink: 'https://x.slack.com/files/U0/F1/diagram.png',
  URLPrivate: 'https://files.slack.com/files-pri/T0-F1/diagram.png',
  Thumb360: 'https://files.slack.com/files-tmb/T0-F1/d_360.png',
  Thumb360W: 360,
  Thumb360H: 200,
  Thumb720: '',
  OriginalW: 1200,
  OriginalH: 667,
  IsImage: true,
}

const doc: File = {
  ID: 'F2',
  Name: 'notes.pdf',
  Title: 'notes.pdf',
  Mimetype: 'application/pdf',
  Filetype: 'pdf',
  PrettyType: 'PDF',
  Size: 67890,
  Permalink: 'https://x.slack.com/files/U0/F2/notes.pdf',
  URLPrivate: '',
  Thumb360: '',
  Thumb360W: 0,
  Thumb360H: 0,
  Thumb720: '',
  OriginalW: 0,
  OriginalH: 0,
  IsImage: false,
}

describe('FileAttachments', () => {
  it('renders an image file as a proxied thumbnail', () => {
    const { container } = renderWithProvider(<FileAttachments files={[img]} />)
    const el = container.querySelector('img')
    expect(el?.getAttribute('src')).toContain('/api/slack-file?url=')
    expect(el?.getAttribute('src')).toContain(encodeURIComponent(img.Thumb360))
  })

  it('opens a modal with the full image when the thumbnail is clicked', async () => {
    const { container } = renderWithProvider(<FileAttachments files={[img]} />)
    fireEvent.click(container.querySelector('img')!)
    // Mantine's Modal mounts its content asynchronously (transition-driven),
    // so wait for the modal body's image to appear.
    await waitFor(() => expect(document.querySelectorAll('img').length).toBe(2))
    const modalImg = document.querySelector('.mantine-Modal-body img')
    expect(modalImg?.getAttribute('alt')).toBe('diagram.png')
    expect(modalImg?.getAttribute('src')).toContain(encodeURIComponent(img.URLPrivate))
  })

  it('renders a non-image file as a card linking to the permalink', () => {
    const { getByText, container } = renderWithProvider(<FileAttachments files={[doc]} />)
    expect(getByText('notes.pdf')).toBeTruthy()
    const link = container.querySelector('a[href="' + doc.Permalink + '"]')
    expect(link).not.toBeNull()
  })

  it('falls back to the non-image card when the image fails to load', () => {
    const { container } = renderWithProvider(<FileAttachments files={[img]} />)
    const el = container.querySelector('img')!
    fireEvent.error(el)
    expect(container.querySelector('img')).toBeNull()
    const link = container.querySelector('a[href="' + img.Permalink + '"]')
    expect(link).not.toBeNull()
  })
})
