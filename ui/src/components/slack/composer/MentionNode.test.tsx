import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { createEditor, $getRoot, $createParagraphNode, $createTextNode } from 'lexical'
import { MentionNode, $createMentionNode, $isMentionNode } from './MentionNode'

afterEach(cleanup)

describe('MentionNode', () => {
  it('serializes as its token via getTextContent, so the root text IS the mrkdwn', () => {
    const editor = createEditor({ nodes: [MentionNode], onError: (e) => { throw e } })
    editor.update(
      () => {
        const p = $createParagraphNode()
        p.append($createTextNode('hi '))
        p.append($createMentionNode({ kind: 'user', id: 'U1', label: 'ada', token: '<@U1>' }))
        p.append($createTextNode(' there'))
        $getRoot().clear().append(p)
      },
      { discrete: true },
    )
    const text = editor.getEditorState().read(() => $getRoot().getTextContent())
    expect(text).toBe('hi <@U1> there')
  })

  it('round-trips through exportJSON/importJSON', () => {
    const editor = createEditor({ nodes: [MentionNode], onError: (e) => { throw e } })
    let json: ReturnType<MentionNode['exportJSON']> | undefined
    editor.update(
      () => {
        json = $createMentionNode({ kind: 'group', id: 'S1', label: '@platform', token: '<!subteam^S1>' }).exportJSON()
      },
      { discrete: true },
    )
    editor.update(
      () => {
        const restored = MentionNode.importJSON(json!)
        expect($isMentionNode(restored)).toBe(true)
        expect(restored.getTextContent()).toBe('<!subteam^S1>')
      },
      { discrete: true },
    )
  })

  function decorateInEditor(item: Parameters<typeof $createMentionNode>[0]) {
    const editor = createEditor({ nodes: [MentionNode], onError: (e) => { throw e } })
    let element: ReturnType<MentionNode['decorate']> | undefined
    editor.update(
      () => {
        element = $createMentionNode(item).decorate()
      },
      { discrete: true },
    )
    return element!
  }

  it('renders a user chip with the "@" prefix, since the label is bare', () => {
    const { getByText } = render(decorateInEditor({ kind: 'user', id: 'U1', label: 'Mike Turley', token: '<@U1>' }))
    expect(getByText('@Mike Turley')).toBeInTheDocument()
  })

  it('renders a group chip unchanged (label already carries its own "@")', () => {
    const { getByText } = render(
      decorateInEditor({ kind: 'group', id: 'S1', label: '@zaffre-scrum', token: '<!subteam^S1>' }),
    )
    expect(getByText('@zaffre-scrum')).toBeInTheDocument()
  })

  it('renders an emoji chip unchanged (no "@" sigil at all)', () => {
    const { getByText } = render(decorateInEditor({ kind: 'emoji', id: 'smile', label: ':smile:', token: ':smile:' }))
    expect(getByText(':smile:')).toBeInTheDocument()
  })
})
