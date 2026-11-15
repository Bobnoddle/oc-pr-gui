// The dual-process invariant, pinned structurally.
//
// gui.tsx is evaluated twice: every desktop window runs `setup` (Solid UI, no
// child_process) and the Electron main process runs `main`. Tier E item 29 moved
// everything that spawns a process - or holds a cache only main touches - into
// ./git, so the direction of the dependency is one-way and the window's setup
// path cannot reach the spawning layer except through `ctx.main(PrPanel)`.
//
// These assertions are source-level on purpose: the point is the shape of the
// import graph and the shape of the call sites, which type-checking alone does
// not constrain (a window component may call an imported function directly and
// still compile, because `execFile` is an inert placeholder in the window).
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")

const gui = read("gui.tsx")
const git = read("git.ts")

// Every helper that spawns git/gh, reads node:fs state for the auto-fix toggle,
// or serves the in-flight dedupe. `main` may call these; `setup` may not.
const MAIN_ONLY = [
  "run",
  "runStep",
  "readWorktree",
  "resolveBase",
  "resolveBaseRef",
  "fetchBase",
  "fetchAndResolveBase",
  "branchName",
  "stashEntries",
  "stashLookup",
  "worktreeHoldingBranch",
  "checkContinueBase",
  "createPr",
  "mergePr",
  "commitAndPush",
  "pushBranch",
  "planPush",
  "readSnapshot",
  "worktreeSnapshot",
  "readStatusViaView",
  "readFoldedStatus",
  "readStatus",
  "readDivergence",
  "countReviewThreads",
  "autoFixState",
  "autoFixFile",
  "readAutoFixMap",
  "reaperState",
  "reaperFile",
  "readReaperSettings",
  "reaperEnabled",
  "reapBranches",
  "casDeleteVerifiedBranch",
  "worktreeHolders",
  "resetWorkspace",
  "continueWork",
  "readShared",
  "mutateRead",
] as const

// `Plugin.define({ setup, main })`: the setup half, window components included,
// up to the line that opens `main`.
function setupRegion(source: string): string {
  const start = source.indexOf("\n  setup(ctx) {")
  const end = source.indexOf("\n  main(ctx) {")
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

// Code lines only, so a comment may still name `pushBranch` or `resetWorkspace`
// without being counted as a call.
const codeOnly = (source: string) =>
  source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*")
    })
    .join("\n")

// A call through the IPC bridge, not a direct one: `ctx.main(PrPanel).name(`
// is removed before looking for `name(`.
function calledDirectly(source: string, name: string): boolean {
  const bridged = source.split(`ctx.main(PrPanel).${name}(`).join("")
  return new RegExp(`\\b${name}\\s*\\(`).test(bridged)
}

describe("split — import direction", () => {
  test("git.ts never imports gui.tsx (one-way: gui -> git)", () => {
    expect(git).not.toMatch(/from\s+"\.\/gui"/)
    expect(git).not.toMatch(/require\(\s*"\.\/gui"\s*\)/)
    expect(git).not.toMatch(/import\(\s*"\.\/gui"\s*\)/)
  })

  test("gui.tsx imports the spawning layer from ./git", () => {
    expect(gui).toMatch(/from "\.\/git"/)
    // The window half must not reach for a process or the filesystem itself.
    expect(gui).not.toMatch(/from "node:child_process"/)
    expect(gui).not.toMatch(/from "node:fs"/)
    expect(gui).not.toMatch(/from "node:os"/)
    // ...and those imports must exist here, or the move deleted the spawns.
    expect(git).toMatch(/from "node:child_process"/)
    expect(git).toMatch(/from "node:fs"/)
  })
})

describe("split — main-only helpers", () => {
  test("git.ts defines every process-touching helper", () => {
    const missing = MAIN_ONLY.filter((name) => !new RegExp(`\\b(?:function|const) ${name}\\b`).test(git))
    expect(missing).toEqual([])
  })

  test("gui.tsx setup region makes no direct call into the spawning layer", () => {
    const region = codeOnly(setupRegion(gui))
    const direct = MAIN_ONLY.filter((name) => calledDirectly(region, name))
    expect(direct).toEqual([])
  })

  test("gui.tsx setup region reaches main only through declared IPC methods", () => {
    const region = setupRegion(gui)
    const used = new Set(
      Array.from(region.matchAll(/ctx\.main\(PrPanel\)\.([A-Za-z0-9_]+)\(/g), (match) => match[1]),
    )
    expect(used.size).toBeGreaterThan(0)
    const contract = read("contract.ts")
    const declared = new Set(
      Array.from(contract.matchAll(/^ {4}([A-Za-z0-9_]+): \{\n {6}input:/gm), (match) => match[1]),
    )
    expect(declared.size).toBeGreaterThan(0)
    expect([...used].filter((method) => !declared.has(method))).toEqual([])
  })

  test("main's handlers are the only callers of the helpers", () => {
    const main = codeOnly(gui.slice(gui.indexOf("\n  main(ctx) {")))
    const called = MAIN_ONLY.filter((name) => calledDirectly(main, name))
    // Every mutating handler goes through mutateRead, every read through
    // readShared, so the direct calls in main are exactly the worker functions.
    expect(called).toContain("readStatus")
    expect(called).toContain("readShared")
    expect(called).toContain("mutateRead")
    expect(called).toContain("resetWorkspace")
    expect(called).toContain("continueWork")
  })
})

// Controls for the detector itself.
//
// `calledDirectly` is the only judgement in this file, and every assertion above
// leans on it: a detector that stopped flagging direct calls, or that started
// flagging bridged ones, would keep the whole suite green on a broken tree. These
// fixtures are the same question asked of strings that cannot change, so the
// detector is pinned to its contract rather than to today's src/.
describe("split — detector controls", () => {
  test("control: a direct pushBranch call is flagged", () => {
    expect(calledDirectly(`await pushBranch(dir, confirm)`, "pushBranch")).toBe(true)
  })

  test("control: a bridged ctx.main(PrPanel) call is not flagged", () => {
    expect(calledDirectly(`await ctx.main(PrPanel).pushBranch({ confirm })`, "pushBranch")).toBe(false)
  })

  test("control: a bridged call is not flagged even beside a direct one", () => {
    // The bridge strip removes only the one bridge prefix, so a direct call on a
    // neighbouring line must still be seen.
    const src = [
      `await ctx.main(PrPanel).pushBranch({ confirm })`,
      `await pushBranch(dir, confirm)`,
    ].join("\n")
    expect(calledDirectly(src, "pushBranch")).toBe(true)
  })

  test("control: runQueuedPrompt is not mistaken for run", () => {
    expect(calledDirectly(`runQueuedPrompt(() => {})`, "run")).toBe(false)
  })

  test("control: run itself is flagged", () => {
    expect(calledDirectly(`const x = await run("git", args, cwd)`, "run")).toBe(true)
  })

  test("control: readWorktree is flagged", () => {
    expect(calledDirectly(`await readWorktree(cwd, true)`, "readWorktree")).toBe(true)
  })
})
