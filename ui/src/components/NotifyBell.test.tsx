import { afterEach, describe, expect, it } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { NotifyBell } from "./NotifyBell"

const wrap = (ui: React.ReactNode, notificationsEnabled = true) => {
  const qc = new QueryClient()
  qc.setQueryData(["session"], { handle: "h", label: "", created_at: "", last_seen_at: "", current: true, notifications_enabled: notificationsEnabled })
  return render(<QueryClientProvider client={qc}><MantineProvider>{ui}</MantineProvider></QueryClientProvider>)
}
afterEach(cleanup)

describe("NotifyBell", () => {
  it("explicit: filled bell with its tooltip", async () => {
    wrap(<NotifyBell kind="explicit" />)
    const bell = screen.getByRole("img", { name: "Notifications on" })
    expect(bell.getAttribute("data-kind")).toBe("explicit")
    await userEvent.hover(bell)
    await waitFor(() => expect(document.body.textContent).toContain("Notifications are on for this resource"))
  })
  it("implicit: says where to turn it off", async () => {
    wrap(<NotifyBell kind="implicit" />)
    const bell = screen.getByRole("img", { name: "Notifications on for the whole worktree" })
    expect(bell.getAttribute("data-kind")).toBe("implicit")
    await userEvent.hover(bell)
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Notifications are on for all resources in this worktree. Turn off 'Notify on all' at the top of this page to change it",
      ),
    )
  })
  it("renders nothing while notifications are disabled in settings", () => {
    wrap(<NotifyBell kind="explicit" />, false)
    expect(screen.queryByRole("img")).toBeNull()
  })
})
