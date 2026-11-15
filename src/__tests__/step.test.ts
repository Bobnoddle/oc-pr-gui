// Covers `runStep`'s message plumbing only. The helper itself spawns a process
// (git.ts, Node-only), so the part that decides a sentence - a fixed string or
// a template over git/gh stderr - is the pure seam `stepText` and is tested
// here; every call site's actual wording is asserted by the before/after table
// in the Tier E phase 2 report, not by a snapshot.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { stepText } from "../pure"

describe("stepText", () => {
  test("a fixed sentence is returned verbatim, stderr ignored", () => {
    expect(stepText("Reset stopped: `git worktree prune` timed out.", "fatal: something")).toBe(
      "Reset stopped: `git worktree prune` timed out.",
    )
  })

  test("a template receives the stderr it must quote", () => {
    const template = (stderr: string) => `failed (${stderr.trim()})`
    expect(stepText(template, " fatal: bad revision\n")).toBe("failed (fatal: bad revision)")
  })

  test("an empty stderr still reaches the template", () => {
    expect(stepText((stderr) => `detail:[${stderr}]`, "")).toBe("detail:[]")
  })
})
