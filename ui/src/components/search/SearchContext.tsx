import { createContext, useContext } from "react"
import type { ResourceDTO } from "../../api/types"

/**
 * The active search, for components that highlight or explain matches. Each
 * page that has a search bar provides it; with no provider there are no
 * terms and everything renders as before.
 */
export interface SearchContextValue {
  terms: string[]
  /** Home page: every resource each worktree follows (related included), for "via" matches. */
  resourcesByPath?: Map<string, ResourceDTO[]>
}

export const SearchContext = createContext<SearchContextValue>({ terms: [] })

export function useSearchContext(): SearchContextValue {
  return useContext(SearchContext)
}
