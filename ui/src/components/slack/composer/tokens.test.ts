import { describe, it, expect } from 'vitest'
import { tokenFor } from './tokens'

// This table MIRRORS TestTokenBuilders in internal/webui/autocomplete_test.go.
// If one changes, change both.
describe('tokenFor', () => {
  it('builds the same mrkdwn the server does', () => {
    expect(tokenFor({ kind: 'user', id: 'U123' })).toBe('<@U123>')
    expect(tokenFor({ kind: 'group', id: 'S123' })).toBe('<!subteam^S123>')
    expect(tokenFor({ kind: 'special', id: 'here' })).toBe('<!here>')
    expect(tokenFor({ kind: 'special', id: 'channel' })).toBe('<!channel>')
    expect(tokenFor({ kind: 'channel', id: 'C123', name: 'odh-dashboard' })).toBe('<#C123|odh-dashboard>')
    expect(tokenFor({ kind: 'emoji', id: 'tada' })).toBe(':tada:')
  })
})
