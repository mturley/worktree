import { describe, it, expect } from 'vitest'
import { createEditor, $getRoot, $createParagraphNode, $createTextNode } from 'lexical'
import { MentionNode, $createMentionNode, $isMentionNode } from './MentionNode'

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
})
