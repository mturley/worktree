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
 * The accent ramp is a custom indigo-leaning blue rather than a stock Mantine
 * hue, so the chrome stays distinct from the event colours, which use stock
 * hues to separate sources.
 */
const accent: MantineColorsTuple = [
  "#eef2ff",
  "#dbe2ff",
  "#b3c1ff",
  "#889dff",
  "#647fff",
  "#4d6dff",
  "#3f63ff",
  "#3053e4",
  "#2749cc",
  "#173db4",
]

/**
 * Surface ramp. Mantine's stock `dark` runs fairly blue; these are slightly
 * desaturated so the coloured event dots read as the only saturated thing on
 * the page.
 */
const surface: MantineColorsTuple = [
  "#c9c9d4",
  "#b8b8c2",
  "#9a9aa6",
  "#7b7b88",
  "#5f5f6b",
  "#4a4a55",
  "#3a3a44",
  "#2b2b33",
  "#1f1f26",
  "#15151a",
]

export const theme = createTheme({
  fontSizes: { md: "0.9375rem" },
  primaryColor: "accent",
  colors: { accent, dark: surface },
})
