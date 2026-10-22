import { describe, expect, it } from "vitest"
import { mrkdwnToPlain } from "./mrkdwnPlain"

describe("mrkdwnToPlain", () => {
  it.each([
    ["plain", "plain"],
    ["<@U123>", "@user"],
    ["<@U123|bob>", "@bob"],
    ["<#C123|general>", "#general"],
    ["<#C123>", "#channel"],
    ["<https://x.io|label>", "label"],
    ["<https://x.io>", "https://x.io"],
    ["<mailto:a@b.c|a@b.c>", "a@b.c"],
    ["<!here>", "@here"],
    ["<!subteam^S1|@team>", "@team"],
    ["a &lt;b&gt; &amp;lt;", "a <b> &lt;"],
    ["x < y", "x < y"],
    ["<@U1> see <https://x.io/a|the doc> in <#C9|general> &amp; <https://y.io>", "@user see the doc in #general & https://y.io"],
  ])("%s → %s", (input, want) => {
    expect(mrkdwnToPlain(input)).toBe(want)
  })

  it("names a mention by its display name when the user is known", () => {
    expect(mrkdwnToPlain("hi <@U1> and <@U2>", { U1: { DisplayName: "Ann", RealName: "Ann A" } })).toBe("hi @Ann and @user")
    expect(mrkdwnToPlain("<@U1>", { U1: { DisplayName: "", RealName: "Real Name" } })).toBe("@Real Name")
  })
})
