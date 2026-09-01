import { createTheme, type MantineColorsTuple } from "@mantine/core"

/**
 * Dark-only theme.
 *
 * The app forces the dark colour scheme (see main.tsx: MantineProvider gets
 * forceColorScheme="dark"), so there is deliberately no light palette and no
 * theme switcher. That is what lets the rest of the styling — the card
 * surfaces in styles/cards.css, the event colours in lib/eventMeta.tsx —
 * assume a dark background and pick contrast accordingly.
 *
 * The accent ramp is a deep aubergine purple, matching the favicon
 * (ui/public/favicon.svg) so the tab and the chrome read as one thing.
 *
 * It is a custom ramp rather than stock Mantine `violet` or `grape` on
 * purpose, and the reason is the same as when it was blue: the event colours
 * (lib/eventMeta.tsx) use stock hues at shade 5 to tell event types apart,
 * and two of them — violet for pr_merged, grape for jira_status_change and
 * slack_reply — sit in this hue family. Staying deep and desaturated keeps
 * the chrome off them; in OKLab the filled chrome is 0.22 from violet[5],
 * where the old blue ramp was only 0.16 from indigo[5].
 *
 * Watch the index, not the swatch: Mantine's default primaryShade is
 * { light: 6, dark: 8 } and the app forces dark, so the colour actually
 * painted on filled buttons and the selected-card outline is accent[8], NOT
 * accent[6]. Anchoring this ramp on the favicon's own #5b21b6 at index 6 was
 * rejected for that reason — it drove index 8 to a near-black #3f0388.
 */
const accent: MantineColorsTuple = [
  "#f3f0fe",
  "#e0daf6",
  "#bfb1ed",
  "#9e84e4",
  "#855ddb",
  "#7641d3",
  "#6d2ccc",
  "#5c1ab3",
  "#50119d",
  "#420087",
]

/**
 * Surface ramp. Mantine's stock `dark` runs fairly blue; these are slightly
 * desaturated so the coloured event dots read as the only saturated thing on
 * the page.
 *
 * Which index does what, since these are not arbitrary:
 *   dark[7]  the base the page background is derived from
 *   dark[6]  card surfaces (--mantine-color-default)
 *   dark[5]  card hover
 *   dark[4]  borders and the timeline rail
 * The gap between 7 and 6 is what lifts a card off the page.
 *
 * The page itself is pinned to pure black in styles/theme.css rather than by
 * setting dark[7] to #000: the ramp has to stay monotonic (8 and 9 are darker
 * still, and dark[9] is the event dots' icon colour), so forcing black here
 * would have left later indices lighter than the body they sit on.
 */
const surface: MantineColorsTuple = [
  "#c9c9d4",
  "#b8b8c2",
  "#9a9aa6",
  "#7b7b88",
  "#5f5f6b",
  "#3f3f49",
  "#2f2f38",
  "#141419",
  "#0b0b0e",
  "#000000",
]

export const theme = createTheme({
  fontSizes: { md: "0.9375rem" },
  primaryColor: "accent",
  colors: { accent, dark: surface },
})
