import { useEffect, useSyncExternalStore } from "react"

/**
 * Where the Esc hint for "leave this page" goes, decided between two
 * components that cannot see each other: the worktree page, which knows when
 * Esc's next step is to leave (nothing to clear, nothing selected), and the
 * app-level HomeWorktreeBanner, which knows whether it is showing. With the
 * banner up, the hint is the banner's — it names where Esc goes; without it,
 * the page puts the hint on its own back link.
 */
const state = { leaving: false, banner: false }
const listeners = new Set<() => void>()

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

function set(key: keyof typeof state, value: boolean): void {
  if (state[key] === value) return
  state[key] = value
  listeners.forEach((l) => l())
}

function usePublish(key: keyof typeof state, value: boolean): void {
  useEffect(() => {
    set(key, value)
    return () => set(key, false)
  }, [key, value])
}

/** The page says whether Esc's next step is to leave it. */
export const usePublishEscLeaves = (leaving: boolean) => usePublish("leaving", leaving)
/** The banner says whether it is showing. */
export const usePublishBannerShown = (shown: boolean) => usePublish("banner", shown)

export const useEscLeaves = () => useSyncExternalStore(subscribe, () => state.leaving)
export const useBannerShown = () => useSyncExternalStore(subscribe, () => state.banner)
