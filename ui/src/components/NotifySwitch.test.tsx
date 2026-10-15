import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { NotifySwitch } from "./NotifySwitch"

class FakeNotification {
  static permission: NotificationPermission = "default"
  static requestPermission = vi.fn(async () => {
    FakeNotification.permission = "granted"
    return "granted" as NotificationPermission
  })
}

const wrap = (ui: React.ReactNode, notificationsEnabled = true) => {
  const qc = new QueryClient()
  qc.setQueryData(["session"], { handle: "h", label: "", created_at: "", last_seen_at: "", current: true, notifications_enabled: notificationsEnabled })
  return render(<QueryClientProvider client={qc}><MantineProvider>{ui}</MantineProvider></QueryClientProvider>)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  FakeNotification.permission = "default"
  FakeNotification.requestPermission.mockClear()
})

describe("NotifySwitch", () => {
  it("asks for permission before turning on in browser mode", async () => {
    vi.stubGlobal("Notification", FakeNotification)
    const onToggle = vi.fn(async () => {})
    wrap(<NotifySwitch label="Notify on all" checked={false} mode="browser" onToggle={onToggle} />)
    await userEvent.click(screen.getByLabelText("Notify on all"))
    expect(FakeNotification.requestPermission).toHaveBeenCalled()
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it("never asks in cmux mode", async () => {
    vi.stubGlobal("Notification", FakeNotification)
    const onToggle = vi.fn(async () => {})
    wrap(<NotifySwitch label="Notify on all" checked={false} mode="cmux" onToggle={onToggle} />)
    await userEvent.click(screen.getByLabelText("Notify on all"))
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it("warns when on but this browser blocks notifications", () => {
    FakeNotification.permission = "denied"
    vi.stubGlobal("Notification", FakeNotification)
    wrap(<NotifySwitch label="Notify on all" checked mode="browser" onToggle={async () => {}} />)
    expect(screen.getByText("This browser is blocking notifications. Allow them in the site settings to receive them here.")).toBeTruthy()
  })

  it("offers Allow when on but permission is undecided", async () => {
    vi.stubGlobal("Notification", FakeNotification)
    wrap(<NotifySwitch label="Notify on all" checked mode="browser" onToggle={async () => {}} />)
    expect(screen.getByText("Notifications aren't enabled in this browser")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Allow" }))
    expect(FakeNotification.requestPermission).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText("Notifications aren't enabled in this browser")).toBeNull())
  })

  it("shows no warnings in cmux mode", () => {
    FakeNotification.permission = "denied"
    vi.stubGlobal("Notification", FakeNotification)
    wrap(<NotifySwitch label="Notify on all" checked mode="cmux" onToggle={async () => {}} />)
    expect(screen.queryByText(/blocking notifications/)).toBeNull()
  })

  it("is disabled with its reason as a tooltip", async () => {
    wrap(
      <NotifySwitch
        label="Notify on new events"
        checked
        mode="cmux"
        disabledReason="Notifications are enabled for all resources in the worktree"
        onToggle={async () => {}}
      />,
    )
    expect((screen.getByLabelText("Notify on new events") as HTMLInputElement).disabled).toBe(true)
    await userEvent.hover(screen.getByTestId("notify-switch-target"))
    await waitFor(() =>
      expect(document.body.textContent).toContain("Notifications are enabled for all resources in the worktree"),
    )
  })
  it("is disabled, keeping its state, while notifications are disabled in settings", async () => {
    const onToggle = vi.fn(async () => {})
    wrap(<NotifySwitch label="Notify on all" checked mode="cmux" onToggle={onToggle} />, false)
    const input = screen.getByLabelText("Notify on all") as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect(input.checked).toBe(true)
    await userEvent.hover(screen.getByTestId("notify-switch-target"))
    await waitFor(() => expect(document.body.textContent).toContain("Notifications are disabled in settings"))
  })
})
