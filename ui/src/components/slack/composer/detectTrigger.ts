/** A live autocomplete trigger found immediately before the caret. */
export interface TriggerMatch {
  trigger: '@' | ':' | '#'
  /** The text typed after the trigger character, without it. */
  query: string
  /** Index of the trigger character itself, for replacing on selection. */
  start: number
}

// A trigger counts at the start of the text, after whitespace, or directly
// after a ">" or ":" — this is what keeps "ada@example.com" from opening a
// mention menu while still opening one typed straight after a PILL, whose
// text content is its mrkdwn token and so ends in ">" (users, groups,
// specials, channels) or ":" (emoji). Slack's own composer opens there too;
// requiring a space first was a papercut, and neither character can occur
// inside a handle or an ordinary word, so the email case is untouched.
// The query runs to the caret and may not contain whitespace or another
// trigger character.
const TRIGGER_RE = /(?:^|[\s>:])([@:#])([^\s@:#]*)$/

/**
 * Decides whether an autocomplete menu should be open, given the text between
 * the start of the block and the caret.
 *
 * Pure by design: jsdom has no real Selection or contenteditable behaviour,
 * so trigger logic buried in a DOM handler would be untestable.
 */
export function detectTrigger(textBeforeCaret: string): TriggerMatch | null {
  const m = TRIGGER_RE.exec(textBeforeCaret)
  if (!m) {
    return null
  }
  const [, trigger, query] = m
  return {
    trigger: trigger as '@' | ':' | '#',
    query,
    start: textBeforeCaret.length - query.length - 1,
  }
}
