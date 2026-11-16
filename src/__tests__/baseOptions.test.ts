// The on-base option swaps, pinned on gui.tsx's source text.
//
// gui.tsx cannot be rendered under `bun test` (Solid JSX + the plugin host), so —
// like promptText.test.ts and split.test.ts — these assertions slice the source
// and read the exact arms. Each on-base primary is split from its off-base
// fallback, so a swap cannot be "proven" by the fallback sentence that still
// offers the old action; the predicate that gates every swap is pinned too, so
// the file goes red if `onBase()` stops being a real comparison.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { en } from "../i18n"

const gui = readFileSync(new URL("../gui.tsx", import.meta.url), "utf8")

function slice(start: string, end: string): string {
  const from = gui.indexOf(start)
  const to = gui.indexOf(end, from + 1)
  expect(from).toBeGreaterThan(-1)
  expect(to).toBeGreaterThan(from)
  return gui.slice(from, to)
}

// Index of the `}` that closes the `{` at `open`, counting nested literals.
function matchingBrace(source: string, open: number): number {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// One `case "kind":` arm of a switch body, up to the next label.
function arm(body: string, kind: string, nextLabel: string): string {
  const from = body.indexOf(`case "${kind}":`)
  const to = body.indexOf(nextLabel, from + 1)
  expect(from).toBeGreaterThan(-1)
  expect(to).toBeGreaterThan(from)
  return body.slice(from, to)
}

// `onBase() ? { primary } : { fallback }` -> both halves. The on-base primary
// must not be satisfied by the fallback that still names the old action.
function ternary(source: string): { on: string; off: string } {
  const at = source.indexOf("onBase()")
  expect(at).toBeGreaterThan(-1)
  const question = source.indexOf("?", at)
  expect(question).toBeGreaterThan(at)
  const open = source.indexOf("{", question)
  const close = matchingBrace(source, open)
  expect(close).toBeGreaterThan(open)
  const colon = source.indexOf(":", close)
  expect(colon).toBeGreaterThan(close)
  return { on: source.slice(open, close + 1), off: source.slice(colon + 1) }
}

// `if (onBase()) { … }` -> the guarded body and everything after it.
function ifBlock(source: string, condition: string): { body: string; rest: string } {
  const at = source.indexOf(condition)
  expect(at).toBeGreaterThan(-1)
  const open = source.indexOf("{", at)
  const close = matchingBrace(source, open)
  expect(close).toBeGreaterThan(open)
  return { body: source.slice(open, close + 1), rest: source.slice(close + 1) }
}

const option1 = slice("const option1 = (): Option | undefined => {", "// Only the non-open states")
const option2 = slice("const option2 = (): Option | undefined => {", "// ---- Confirm restructure")

describe("onBase — the gate is a real comparison, not a constant", () => {
  test("a resolved, non-empty base equal to the current branch is the only on-base state", () => {
    // Fail closed: an unresolved or empty base, or a detached/no-branch read,
    // must never count as "on base" — those states keep the old options.
    const predicate = slice("const onBase = () => {", "const branchLabel = ")
    expect(predicate).toContain("const current = base()")
    expect(predicate).toContain("current !== undefined")
    expect(predicate).toContain('current !== ""')
    expect(predicate).toContain("current === plainBranch()")
    expect(predicate).not.toContain("return true")
  })
})

describe("option1 — the on-base primary is split from the off-base fallback", () => {
  test("dirty: on base the filled action moves the work to a new branch", () => {
    const dirty = ternary(arm(option1, "dirty", `case "push":`))
    expect(dirty.on).toContain('ctx.t("dialog.moveToNewBranch")')
    expect(dirty.on).toContain("doStashCreate")
    expect(dirty.on).not.toContain("doCommitPush")
    // Off base, committing here stays the primary exactly as before.
    expect(dirty.off).toContain('ctx.t("dialog.commitPush")')
    expect(dirty.off).toContain("doCommitPush")
  })

  test("push: on base the row pushes, with no PR to open afterwards", () => {
    const push = ternary(arm(option1, "push", `case "create":`))
    expect(push.on).toContain('ctx.t("dialog.pushToBase"')
    expect(push.on).toContain("doPush")
    expect(push.on).not.toContain('ctx.t("confirm.pushThenCreate")')
    // Off base, push-then-create is still the primary.
    expect(push.off).toContain('ctx.t("confirm.pushThenCreate")')
    expect(push.off).toContain("doPushThenCreate")
  })

  test("create: on base the row creates the branch a PR would need", () => {
    const create = ternary(arm(option1, "create", `case "error":`))
    expect(create.on).toContain('ctx.t("dialog.createBranch")')
    expect(create.on).toContain("doCreateBranch")
    expect(create.on).not.toContain('ctx.t("dialog.create")')
    // Off base, Create PR is still the primary.
    expect(create.off).toContain('ctx.t("dialog.create")')
    expect(create.off).toContain("doCreate")
  })
})

describe("option2 — the on-base ghosts are guarded, the off-base ghost survives", () => {
  test("dirty: the commit-onto-base ghost exists only under onBase()", () => {
    const dirty = arm(option2, "dirty", `case "push":`)
    const guarded = ifBlock(dirty, "if (onBase())")
    expect(guarded.body).toContain('ctx.t("dialog.commitPushToBase"')
    expect(guarded.body).toContain("doCommitPush")
    // Off base the ghost stays the push-only escape, never the base wording.
    expect(guarded.body).not.toContain('ctx.t("confirm.pushOnly")')
    expect(guarded.rest).toContain('ctx.t("confirm.pushOnly")')
  })

  test("push: on base there is no ghost, because the primary is already the push", () => {
    const push = arm(option2, "push", "default:")
    // `onBase() ? undefined : { push only }`
    expect(push).toMatch(/onBase\(\)\s*\?\s*undefined/)
    expect(push).toContain('ctx.t("confirm.pushOnly")')
  })
})

describe("the on-base labels exist in the catalog", () => {
  test("a typo in a swap would render a raw key, so the five keys are named here", () => {
    for (const key of [
      "dialog.moveToNewBranch",
      "dialog.commitPushToBase",
      "dialog.pushToBase",
      "confirm.moveToNewBranchTitle",
      "confirm.pushToBaseTitle",
    ]) {
      expect(Object.hasOwn(en, key)).toBe(true)
    }
    // The two that name the branch interpolate it at the call site.
    expect(en["dialog.commitPushToBase"]).toContain("{{base}}")
    expect(en["dialog.pushToBase"]).toContain("{{base}}")
  })
})
