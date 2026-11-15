// Pins the poll cadence rule that Phase 1 moved out of gui.tsx's setTimeout.
// The poll never stops while a poll-worthy result exists; `pollDelay` only picks
// how long the next tick waits: fast while the side region is visible OR the
// PrActions dialog is mounted (the dialog has no timer of its own), slow while
// both are closed and only the titlebar chip reads the result.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { POLL_MS_FAST, POLL_MS_SLOW, pollDelay } from "../pure"

describe("pollDelay", () => {
  test("the two cadences are the approved values", () => {
    expect(POLL_MS_FAST).toBe(18_000)
    expect(POLL_MS_SLOW).toBe(60_000)
    // Slow only ever stretches the fast tick; a slower "fast" would invert the
    // rule the comments describe.
    expect(POLL_MS_SLOW).toBeGreaterThan(POLL_MS_FAST)
  })

  test("visible region is fast even with no dialog", () => {
    expect(pollDelay(true, false)).toBe(POLL_MS_FAST)
  })

  test("an open dialog is fast even while the region is hidden", () => {
    expect(pollDelay(false, true)).toBe(POLL_MS_FAST)
  })

  test("both watching means fast", () => {
    expect(pollDelay(true, true)).toBe(POLL_MS_FAST)
  })

  test("hidden with no dialog is the slow tick, never a stopped poll", () => {
    const delay = pollDelay(false, false)
    expect(delay).toBe(POLL_MS_SLOW)
    // A zero (or negative) delay would turn the "slow" branch into a busy loop:
    // the poll is supposed to keep running, just less often.
    expect(delay).toBeGreaterThan(0)
    expect(Number.isFinite(delay)).toBe(true)
  })
})
