import { useSearch as useBrowserSearch } from "wouter/use-browser-location"

/**
 * The URL's query string exactly as the browser holds it, without the
 * leading `?` — for handing to `URLSearchParams`.
 *
 * Use this, never wouter's `useSearch` from "wouter": wouter runs `decodeURI`
 * over the query before returning it, so `URLSearchParams` then decodes a
 * second time and any value containing a literal percent-escape comes back
 * wrong (`a%20b` turns into `a b`). This reads `location.search` through the
 * same history subscription, untouched.
 */
export function useRawSearch(): string {
  return useBrowserSearch().replace(/^\?/, "")
}
