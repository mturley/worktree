import type { AutocompleteKind } from '../../../api/slackApi'

export interface LocalCandidateSeed {
  kind: AutocompleteKind
  id: string
  /** Required for channels — "<#C1|name>" carries the name inline. */
  name?: string
}

/**
 * Builds the mrkdwn token for a candidate derived LOCALLY (thread
 * participants, loaded groups, the @here/@channel/@everyone specials), which
 * never round-trips through the server.
 *
 * Everything the server returns already carries its own `token`; use that.
 * This is the only place in the frontend that constructs mention syntax, and
 * it deliberately mirrors the builders in internal/webui/autocomplete.go —
 * its test table mirrors that file's table case for case. Change both.
 */
export function tokenFor(seed: LocalCandidateSeed): string {
  switch (seed.kind) {
    case 'user':
      return `<@${seed.id}>`
    case 'group':
      return `<!subteam^${seed.id}>`
    case 'special':
      return `<!${seed.id}>`
    case 'channel':
      return `<#${seed.id}|${seed.name ?? ''}>`
    case 'emoji':
      return `:${seed.id}:`
  }
}
