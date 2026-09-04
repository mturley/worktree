/**
 * Geometry shared by the timeline rail and its rows.
 *
 * The rail line and the dots are drawn by different components, so their
 * alignment depends on both agreeing about where a dot's centre falls. When
 * these were separate magic numbers the line ran down the dots' left edge:
 * the row's own horizontal padding shifted every dot right of the line.
 */
import { UNREAD_BORDER_WIDTH } from "../lib/unread"

export const DOT_SIZE = 22
/** Horizontal padding inside a row, before the dot starts. */
export const ROW_PAD_X = 8
/**
 * Distance from a row's left edge to the centre of its dot.
 *
 * The row's unread border counts. Every row reserves it whether or not the
 * event is unread (see READ_BOX_BORDER), so it is a constant offset, not a
 * per-row one — but leaving it out is what knocked the rail off centre when
 * the unread box arrived: the border pushed every dot right while the line
 * stayed put.
 */
export const DOT_CENTER = UNREAD_BORDER_WIDTH + ROW_PAD_X + DOT_SIZE / 2
export const RAIL_WIDTH = 2
