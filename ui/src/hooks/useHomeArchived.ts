import { useState } from "react"

/**
 * The home page's "Include archived": ONE setting for the Activity panel's
 * switch and the search dropdown's, so flipping either flips both. Page
 * state, owned by HomePage and handed to both; not persisted, as the
 * Activity switch never was.
 */
export function useHomeArchived(): [boolean, (v: boolean) => void] {
  return useState(false)
}
