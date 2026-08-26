/**
 * Geometry shared by the timeline rail and its rows.
 *
 * The rail line and the dots are drawn by different components, so their
 * alignment depends on both agreeing about where a dot's centre falls. When
 * these were separate magic numbers the line ran down the dots' left edge:
 * the row's own horizontal padding shifted every dot right of the line.
 */
export const DOT_SIZE = 22
/** Horizontal padding inside a row, before the dot starts. */
export const ROW_PAD_X = 8
/** Distance from a row's left edge to the centre of its dot. */
export const DOT_CENTER = ROW_PAD_X + DOT_SIZE / 2
export const RAIL_WIDTH = 2
