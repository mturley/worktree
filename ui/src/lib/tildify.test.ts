import { describe, expect, it } from "vitest"
import { tildify } from "./tildify"

describe("tildify", () => {
  it("shortens the home directory and paths under it", () => {
    expect(tildify("/Users/me", "/Users/me")).toBe("~")
    expect(tildify("/Users/me/.worktrees/repo/fix", "/Users/me")).toBe("~/.worktrees/repo/fix")
    expect(tildify("/Users/me/x", "/Users/me/")).toBe("~/x")
  })

  it("leaves a sibling that only shares the prefix, and any path without a home", () => {
    expect(tildify("/Users/me2/x", "/Users/me")).toBe("/Users/me2/x")
    expect(tildify("/Users/me/x", undefined)).toBe("/Users/me/x")
    expect(tildify("/Users/me/x", "")).toBe("/Users/me/x")
  })
})
