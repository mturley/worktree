import React from "react"
import ReactDOM from "react-dom/client"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@mantine/core/styles.css"
import "./styles/cards.css"
import { theme } from "./theme"
import { App } from "./App"

const qc = new QueryClient()
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/*
      forceColorScheme, not defaultColorScheme: the app is dark-only by
      design (see theme.ts), so there is no switcher and the OS preference
      must not flip it into a light mode nothing is styled for.
    */}
    <MantineProvider theme={theme} forceColorScheme="dark">
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    </MantineProvider>
  </React.StrictMode>,
)
