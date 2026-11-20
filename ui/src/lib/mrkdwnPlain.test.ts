import { describe, expect, it } from "vitest"
import { mrkdwnToPlain, slackMessageToPlain } from "./mrkdwnPlain"

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

describe("slackMessageToPlain", () => {
  it.each([
    ["see <https://x.io|the doc> *now*", "see the doc now"],
    ["_italic_ and ~gone~", "italic and gone"],
    ["set max_tokens and top_p, cc @mike_t", "set max_tokens and top_p, cc @mike_t"],
    ["a*b*c stays", "a*b*c stays"],
    ["*across\nlines*", "*across\nlines*"],
    ["run `npm_ci *now*` first", "run npm_ci *now* first"],
    ["before\n```\nfoo_bar *x*\n```\nafter", "before\nfoo_bar *x*\nafter"],
    ["a &lt;b&gt; &amp; c", "a <b> & c"],
  ])("%j → %j", (input, want) => {
    expect(slackMessageToPlain(input)).toBe(want)
  })
})
