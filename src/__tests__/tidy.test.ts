// Covers the reaper's window-side half: when a tidy pass is due, and the
// source shape that makes the automatic model true.
//
// The pass itself (candidate table, tip equality, current/held/protected
// branches, cap) is pinned in reaper.test.ts. This file answers the two
// questions that live in gui.tsx and cannot be exercised headlessly:
//   - the cooldown boundary (`tidyDue`, extracted into ./pure on purpose);
//   - that no layout offers the old "Back to main" ghost any more, while the
//     consent moments it was adjacent to — the Merge-state switch and the
//     guarded `doResetWorkspace` function — survive.
//
// The source assertions are shape checks, not runtime proof: the desktop GUI
// cannot be rendered by `bun test`. They fail when the wiring is removed or the
// ghost is revived, which is the regression this wave is about.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { TIDY_COOLDOWN_MS, tidyDue, tidyNote, tidyToggleOutcome } from "../pure"
import { en } from "../i18n"

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")

const gui = read("gui.tsx")

// The `secondary()` builder region: from its declaration to the next top-level
// helper in PrActions. Sliced rather than grepped globally so a reference in
// another state's layout cannot hide a revived merged-state ghost.
function secondaryRegion(source: string): string {
  const start = source.indexOf("const secondary = (): Option | undefined => {")
  const end = source.indexOf("\n      const files = () =>", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("tidyDue — the ten-minute cooldown", () => {
  test("the cooldown is ten minutes", () => {
    expect(TIDY_COOLDOWN_MS).toBe(600_000)
  })

  test("no recorded pass means due (a fresh window tidies immediately)", () => {
    expect(tidyDue(undefined, 1_000_000, TIDY_COOLDOWN_MS)).toBe(true)
  })

  test("the boundary is due and one millisecond earlier is not", () => {
    const last = 1_000_000
    expect(tidyDue(last, last + TIDY_COOLDOWN_MS - 1, TIDY_COOLDOWN_MS)).toBe(false)
    expect(tidyDue(last, last + TIDY_COOLDOWN_MS, TIDY_COOLDOWN_MS)).toBe(true)
    expect(tidyDue(last, last + TIDY_COOLDOWN_MS + 1, TIDY_COOLDOWN_MS)).toBe(true)
  })

  test("a timestamp from the future is not due, so clock skew cannot retry-loop", () => {
    expect(tidyDue(5_000, 1_000, TIDY_COOLDOWN_MS)).toBe(false)
  })
})

describe("tidyNote — one summary for the last pass", () => {
  test("an unreadable reply is undefined, so the previous note is kept", () => {
    expect(tidyNote(undefined)).toBeUndefined()
    expect(tidyNote("no")).toBeUndefined()
    expect(tidyNote([])).toBeUndefined()
    expect(tidyNote({})).toEqual({ branches: [], restores: [], failed: false })
  })

  test("reaped branches and a failure are kept together", () => {
    // A pass can delete and then fail at `git worktree prune`. The restore
    // commands are the undo the user was promised, so they must survive the
    // error instead of being replaced by a bare failure line.
    const note = tidyNote({
      reaped: [
        { branch: "feat/a", number: 7, oid: "abc", restore: "git branch 'feat/a' abc" },
        { branch: "feat/b", number: 8, oid: "def", restore: "git branch 'feat/b' def" },
      ],
      skipped: [{ branch: "main", reason: "protected" }],
      truncated: true,
      error: "Reaper: `git worktree prune` failed (boom); the deleted branches are logged above and still restorable.",
    })
    expect(note).toEqual({
      branches: ["feat/a", "feat/b"],
      restores: ["git branch 'feat/a' abc", "git branch 'feat/b' def"],
      failed: true,
    })
  })

  test("an empty pass is not a failure", () => {
    expect(tidyNote({ reaped: [], skipped: [], truncated: false })).toEqual({
      branches: [],
      restores: [],
      failed: false,
    })
  })
})

describe("tidyToggleOutcome — the switch may only stay On with authority", () => {
  test("a proven readable On reply leaves the switch On", () => {
    expect(tidyToggleOutcome({ known: true, enabled: true }, false)).toEqual({
      enabled: true,
      known: true,
    })
  })

  test("an error reply fails closed to Off", () => {
    // The write was refused, so the optimistic paint must be undone: Off is the
    // refusal's visible consequence, and the message says why.
    const outcome = tidyToggleOutcome({ known: false, enabled: false, error: "EACCES" }, false)
    expect(outcome).toEqual({ enabled: false, known: false, error: "EACCES" })
  })

  test("a thrown IPC fails closed to Off", () => {
    // The catch arm has no reply at all; the switch must not keep the click.
    expect(tidyToggleOutcome(undefined, true)).toEqual({ enabled: false, known: false })
  })

  test("known: false fails closed to Off even if `enabled` says true", () => {
    // An unreadable preference file may hold this directory's opt-out. `enabled`
    // alone is not proof, so the pair must not paint On.
    expect(tidyToggleOutcome({ known: false, enabled: true }, false)).toEqual({
      enabled: false,
      known: false,
    })
  })

  test("an authoritative Off reply is Off (known, not guessed)", () => {
    expect(tidyToggleOutcome({ known: true, enabled: false }, false)).toEqual({
      enabled: false,
      known: true,
    })
  })

  test("an unreadable or unknown reply fails closed to Off", () => {
    expect(tidyToggleOutcome(undefined, false)).toEqual({ enabled: false, known: false })
    expect(tidyToggleOutcome("no", false)).toEqual({ enabled: false, known: false })
    expect(tidyToggleOutcome([], false)).toEqual({ enabled: false, known: false })
    expect(tidyToggleOutcome({}, false)).toEqual({ enabled: false, known: false })
  })
})

describe("merged-state layout — the ghost is gone, the consent moment stays", () => {
  test("secondary() has no merged arm and no dialog.resetWorkspace reference", () => {
    const region = secondaryRegion(gui)
    expect(region).not.toContain("dialog.resetWorkspace")
    expect(region).not.toContain("doResetWorkspace")
    // The merged kind returns no ghost at all; a clean and a dirty merged row
    // therefore render Cancel + Sign off + the primary.
    expect(region).toContain('if (kind === "merged") return undefined')
  })

  test("the key is deleted everywhere, not just unhooked from the layout", () => {
    expect(gui).not.toContain("dialog.resetWorkspace")
    expect(Object.hasOwn(en, "dialog.resetWorkspace")).toBe(false)
  })

  test("the Merge-state switch and the guarded reset handler survive", () => {
    // Consent moments stay: the switch copy, the switch's handler and the
    // dialog action behind Merge & Reset are all still wired.
    expect(gui).toContain('ctx.t("dialog.mergeResetAsk")')
    expect(gui).toContain("const doResetWorkspace = async () => {")
    expect(gui).toContain('ctx.t("dialog.mergeReset")')
    expect(gui).toContain("ctx.main(PrPanel).resetWorkspace(")
  })
})

describe("window wiring — slow tick, preference, toggle, note", () => {
  test("the pass fires only on the slow poll tick", () => {
    expect(gui).toContain("if (delay === POLL_MS_SLOW) void maybeTidy(dir)")
    // Exactly one call site, and it is guarded by the slow delay: the fast tick
    // must never carry the reaper, or a pass would run every 18 s while the
    // panel is open.
    expect(gui.match(/void maybeTidy\(dir\)/g) ?? []).toHaveLength(1)
  })

  test("the preference is read and saved through the reaper IPC", () => {
    expect(gui).toContain("ctx.main(PrPanel).reaper({ directory: dir })")
    expect(gui).toContain("ctx.main(PrPanel).reaper({ directory: dir, enabled: next })")
    // An unreadable preference file fails CLOSED (it may hold the opt-out), so
    // the cached answer must be false, never true.
    expect(gui).toContain("reaperEnabled.set(dir, false)")
    expect(gui).not.toContain("reaperEnabled.set(dir, true)")
  })

  test("the toggle settles from the reply's authority, never from the click", () => {
    const start = gui.indexOf("const togglePanelTidy = async () => {")
    const end = gui.indexOf("\n    const visibleResult", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const region = gui.slice(start, end)
    // Both arms — a resolved reply and a throw — go through the same settle,
    // which paints Off unless the helper returned an authoritative On.
    expect(region).toContain("settle(tidyToggleOutcome(parseJson<unknown>(raw), false))")
    expect(region).toContain("settle(tidyToggleOutcome(undefined, true))")
    expect(region).toContain("setPanelTidy(outcome.enabled)")
    expect(region).toContain("reaperEnabled.set(dir, outcome.enabled)")
    // The only early exit is the missing-directory guard. An early return after
    // an error reply is exactly the bug that kept the optimistic On on screen.
    expect(region.match(/\breturn\b/g) ?? []).toHaveLength(1)
    expect(region).not.toContain("const saved =")
  })

  test("one pass per directory: cooldown and in-flight guards exist", () => {
    expect(gui).toContain("tidyDue(tidyLast.get(dir), now, TIDY_COOLDOWN_MS)")
    expect(gui).toContain("if (tidyInFlight.has(dir)) return")
    expect(gui).toContain("tidyLast.set(dir, now)")
    expect(gui).toContain("tidyInFlight.delete(dir)")
  })

  test("the reply is parsed and skips/truncation stay off the panel", () => {
    expect(gui).toContain("ctx.main(PrPanel).reap({ directory: dir })")
    expect(gui).toContain("parseJson<")
    // Only `reaped` and `error` are read from the reply; no panel line reads
    // `skipped` or `truncated`.
    expect(gui).not.toContain("reply.skipped")
    expect(gui).not.toContain("reply.truncated")
    // One summary object carries the reaped list and the failure flag together,
    // so a pass that deleted and then failed keeps its restore commands.
    expect(gui).toContain("const note = tidyNote(reply)")
    expect(gui).toContain("if (note === undefined) return")
    expect(gui).toContain("setTidySummary({ directory: dir, ...note })")
  })

  test("a reap-then-fail note keeps the restores and appends the failure", () => {
    const start = gui.indexOf("const visibleTidyNote = (dir = directory()) => {")
    const end = gui.indexOf("\n    const tidyRestoreTitle", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const region = gui.slice(start, end)
    // Branches present: the tidied line is rendered whatever else is true, and
    // the failure rides as a suffix on that one line.
    expect(region).toContain('const failed = current.failed ? ctx.t("panel.tidyFailed") : undefined')
    expect(region).toContain("return failed === undefined ? tidied : `${tidied} · ${failed}`")
    // No branches: only the failure line (or nothing).
    expect(region).toContain("if (current.branches.length === 0) return failed")
  })
})

describe("tidy copy", () => {
  test("the toggle, summary and failure line are pinned", () => {
    expect(en["panel.tidy"]).toBe("Auto-tidy merged branches")
    expect(en["panel.tidied"]).toBe("Tidied merged branches: {{list}}")
    // The one visible failure line makes no claim beyond a retry.
    expect(en["panel.tidyFailed"]).toBe("Tidy pass failed — will retry")
    // Restore commands are the undo contract, so they must name the template.
    expect(en["panel.tidyRestore"]).toBe("Restore: {{cmds}}")
  })
})
