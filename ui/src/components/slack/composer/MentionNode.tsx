import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from 'lexical'
import type { JSX } from 'react'
import type { AutocompleteItem, AutocompleteKind } from '../../../api/slackApi'
import { Mention } from '../Mention'

export type SerializedMentionNode = Spread<
  { mentionKind: AutocompleteKind; mentionId: string; label: string; token: string },
  SerializedLexicalNode
>

/**
 * An atomic pill in the composer: one mention, one emoji or one channel
 * reference, held as an object rather than as characters so it cannot be
 * half-deleted into malformed mrkdwn.
 *
 * getTextContent() returns the mrkdwn TOKEN. That is deliberate and
 * load-bearing: it makes `$getRoot().getTextContent()` the serialized message,
 * so there is no separate serializer to drift out of sync with the pills.
 */
export class MentionNode extends DecoratorNode<JSX.Element> {
  __mentionKind: AutocompleteKind
  __mentionId: string
  __label: string
  __token: string

  static getType(): string {
    return 'mention'
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__mentionKind, node.__mentionId, node.__label, node.__token, node.__key)
  }

  constructor(kind: AutocompleteKind, id: string, label: string, token: string, key?: NodeKey) {
    super(key)
    this.__mentionKind = kind
    this.__mentionId = id
    this.__label = label
    this.__token = token
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span')
    span.style.display = 'inline-block'
    return span
  }

  updateDOM(): false {
    return false
  }

  getTextContent(): string {
    return this.__token
  }

  isInline(): true {
    return true
  }

  exportJSON(): SerializedMentionNode {
    return {
      type: 'mention',
      version: 1,
      mentionKind: this.__mentionKind,
      mentionId: this.__mentionId,
      label: this.__label,
      token: this.__token,
    }
  }

  static importJSON(json: SerializedMentionNode): MentionNode {
    return new MentionNode(json.mentionKind, json.mentionId, json.label, json.token)
  }

  decorate(): JSX.Element {
    // Reuses the same pill the rendered thread uses, so a pending mention in
    // the composer looks like the mention it is about to become.
    return <Mention>{this.__label}</Mention>
  }
}

export function $createMentionNode(item: AutocompleteItem): MentionNode {
  return new MentionNode(item.kind, item.id, item.label, item.token)
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode
}
