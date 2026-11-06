import { useMediaQuery } from "@mantine/hooks"
import { isMiniRoute } from "../lib/miniMode"

/**
 * The narrowest mini view whose task and event modals open windowed rather
 * than filling it: the expanded mode's minimum dropdown width in the macOS
 * app (DropdownView.minimum in ResizeGrip.swift), so expanded always gets
 * them, and enough for the task modal (Mantine's `xl`, 780px) with margins.
 */
export const MINI_WINDOWED_MODAL_MIN_WIDTH = 840

/** Whether a task or event modal fills the viewport: only in a narrow mini view. */
export function useMiniModalFullScreen(): boolean {
  const wide = useMediaQuery(`(min-width: ${MINI_WINDOWED_MODAL_MIN_WIDTH}px)`, false, { getInitialValueInEffect: false }) ?? false
  return isMiniRoute() && !wide
}
