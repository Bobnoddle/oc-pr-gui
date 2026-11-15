// Covers the check-summary rules that drive prTone, the titlebar chip and the
// auto-fix trigger. Every case below mirrors a rule stated in pure.ts: failing
// outranks pending, pending outranks unknown, and an unrecognized state is
// never green. Summaries are text-free (`kind` + `labelKey` + counts); the
// visible wording is built at the call site, so these tests pin the rule and
// the key, never an English sentence.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { en } from "../i18n"
import { checkLine, summarizeChecks, type Check } from "../pure"

const at = (state: string, name = "ci"): Check => ({ name, state })

describe("summarizeChecks", () => {
  test("no checks at all is an explicit empty summary, not green", () => {
    expect(summarizeChecks(undefined)).toEqual({
      kind: "none",
      labelKey: "panel.checksNone",
      failing: false,
      failingCount: 0,
      pending: 0,
      unknown: false,
    })
    expect(summarizeChecks([])).toEqual({
      kind: "none",
      labelKey: "panel.checksNone",
      failing: false,
      failingCount: 0,
      pending: 0,
      unknown: false,
    })
  })

  test("one failure picks the singular key and carries the count", () => {
    const summary = summarizeChecks([at("FAILURE")])
    expect(summary.kind).toBe("failing")
    expect(summary.labelKey).toBe("panel.checksFailingOne")
    expect(summary.failing).toBe(true)
    expect(summary.failingCount).toBe(1)
    expect(summary.pending).toBe(0)
    expect(summary.unknown).toBe(false)
  })

  test("several failures count every failing spelling", () => {
    const summary = summarizeChecks([at("FAILURE"), at("ERROR"), at("TIMED_OUT"), at("SUCCESS")])
    expect(summary.kind).toBe("failing")
    expect(summary.labelKey).toBe("panel.checksFailing")
    expect(summary.failingCount).toBe(3)
  })

  test("failing outranks pending even when pending comes first", () => {
    const summary = summarizeChecks([at("IN_PROGRESS"), at("CANCELLED")])
    expect(summary.kind).toBe("failing")
    expect(summary.failing).toBe(true)
    expect(summary.failingCount).toBe(1)
    expect(summary.pending).toBe(0)
  })

  test("pending is reported with a count and blocks green", () => {
    const summary = summarizeChecks([at("QUEUED"), at("IN_PROGRESS"), at("SUCCESS")])
    expect(summary).toEqual({
      kind: "pending",
      labelKey: "panel.checksPending",
      failing: false,
      failingCount: 0,
      pending: 2,
      unknown: false,
    })
  })

  test("pending outranks unknown", () => {
    const summary = summarizeChecks([at("PENDING"), at("SOMETHING_NEW")])
    expect(summary.kind).toBe("pending")
    expect(summary.pending).toBe(1)
    expect(summary.unknown).toBe(false)
    expect(summary.labelKey).toBe("panel.checksPending")
  })

  test("an unrecognized state is unknown, never green", () => {
    const summary = summarizeChecks([at("SUCCESS"), at("MYSTERY")])
    expect(summary).toEqual({
      kind: "unknown",
      labelKey: "panel.checksUnknown",
      failing: false,
      failingCount: 0,
      pending: 0,
      unknown: true,
    })
  })

  test("all PASS_STATES spellings are green, including lowercase input", () => {
    for (const state of ["SUCCESS", "NEUTRAL", "SKIPPED", "OK", "success", "Ok"]) {
      expect(summarizeChecks([at(state)]).kind).toBe("green")
      expect(summarizeChecks([at(state)]).labelKey).toBe("panel.checksGreen")
      expect(summarizeChecks([at(state)]).unknown).toBe(false)
    }
  })

  test("state matching is case-insensitive but not whitespace-tolerant", () => {
    expect(summarizeChecks([at("failure")]).failing).toBe(true)
    // checkLine trims; summarizeChecks itself does not, so a padded state is
    // unknown rather than silently promoted.
    expect(summarizeChecks([at(" SUCCESS ")]).unknown).toBe(true)
  })

  test("the same checks array is summarised once (WeakMap cache)", () => {
    const checks = [at("FAILURE")]
    const first = summarizeChecks(checks)
    // Same array => same summary object, so one render cannot re-walk it.
    expect(summarizeChecks(checks)).toBe(first)
    // A different array with identical contents is a separate input.
    expect(summarizeChecks([at("FAILURE")])).not.toBe(first)
    // Undefined is the shared empty summary.
    expect(summarizeChecks(undefined)).toBe(summarizeChecks(undefined))
  })

  test("every label key is present in the plugin's en dictionary", () => {
    // summarizeChecks returns keys owned by ./i18n; a key that is missing there
    // renders as the raw key, so pin the pairing here. The dictionary is imported
    // rather than scraped out of gui.tsx's source text: it lives in its own module
    // now, so this is a real lookup instead of a string match on the bundle.
    for (const key of [
      "panel.checksFailingOne",
      "panel.checksFailing",
      "panel.checksPending",
      "panel.checksNone",
      "panel.checksUnknown",
      "panel.checksGreen",
    ]) {
      expect(Object.hasOwn(en, key)).toBe(true)
    }
  })
})

describe("checkLine", () => {
  test("prefers state, then conclusion, then status", () => {
    expect(checkLine({ name: "a", state: "SUCCESS", conclusion: "FAILURE", status: "X" })).toEqual({
      name: "a",
      state: "SUCCESS",
    })
    expect(checkLine({ name: "b", conclusion: "FAILURE" }).state).toBe("FAILURE")
    expect(checkLine({ name: "c", status: "IN_PROGRESS" }).state).toBe("IN_PROGRESS")
  })

  test("a blank conclusion does not shadow a live status (the queued-run bug)", () => {
    // gh reports a running CheckRun as conclusion:"" + status:"IN_PROGRESS";
    // `??` would keep the blank and report unknown instead of pending.
    expect(checkLine({ name: "build", conclusion: "", status: "IN_PROGRESS" })).toEqual({
      name: "build",
      state: "IN_PROGRESS",
    })
  })

  test("missing anything falls back to unknown", () => {
    expect(checkLine({ name: "x" })).toEqual({ name: "x", state: "unknown" })
    expect(checkLine({})).toEqual({ name: "check", state: "unknown" })
    expect(checkLine(undefined)).toEqual({ name: "check", state: "unknown" })
  })

  test("names fall back to context and then to the literal check", () => {
    expect(checkLine({ context: "ci/lint", state: "SUCCESS" }).name).toBe("ci/lint")
    expect(checkLine({ name: "", context: "ci/test", state: "SUCCESS" }).name).toBe("")
  })

  test("values are trimmed, so padded states still classify", () => {
    expect(checkLine({ name: "  build ", state: "  SUCCESS  " })).toEqual({
      name: "  build ",
      state: "SUCCESS",
    })
  })
})
