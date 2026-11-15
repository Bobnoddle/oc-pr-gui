// The conflicts primary is an agent handoff, pinned at the source level.
//
// gui.tsx cannot be imported by `bun test` (Solid JSX + the plugin host), so the
// wiring is asserted on its text, the same style as split.test.ts and
// createMessages.test.ts. The change being guarded: the conflicts arm used to
// open the PR page in the browser (`openGithub`); it must now queue a prompt
// through `runQueuedPrompt`, exactly like Fix / Review / Resolve / Sign off.
// `openGithub` itself survives for the meta-line link, so it is pinned alive
// here rather than left to chance.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")

const gui = read("gui.tsx")
const i18n = read("i18n.ts")

// The `conflicts` arm inside `option1`, up to the next case. Anchored on
// `option1` because other switches in gui.tsx also have a `conflicts` case.
function conflictsArm(source: string): string {
  const option1 = source.slice(source.indexOf("const option1 = ()"))
  const start = option1.indexOf(`case "conflicts":`)
  const end = option1.indexOf(`case "merge":`, start + 1)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return option1.slice(start, end)
}

// The handler, from its declaration to the Sign off comment that follows it.
function handler(source: string): string {
  const start = source.indexOf("const doResolveConflicts = async () => {")
  const end = source.indexOf("// Sign off is a queued prompt", start + 1)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("conflicts primary — queued prompt, not a GitHub link", () => {
  test("the conflicts arm runs the handler and keeps the primary variant", () => {
    const arm = conflictsArm(gui)
    expect(arm).toContain(`ctx.t("dialog.resolveConflicts")`)
    expect(arm).toContain("doResolveConflicts()")
    expect(arm).toContain(`variant: "contrast"`)
    expect(arm).not.toContain("openGithub")
  })

  test("the handler queues through runQueuedPrompt with the full spec", () => {
    const body = handler(gui)
    expect(body).toContain("runQueuedPrompt({")
    expect(body).toContain(`busy: "conflicts"`)
    expect(body).toContain(`ctx.t("dialog.conflictsPrompt"`)
    for (const field of ["number", "base", "stale"]) {
      expect(body).toContain(`${field}:`)
    }
    // `head` is resolved once so the prompt and its stale clause name the same
    // branch (the object uses the shorthand property).
    expect(body).toContain(`const head = current.branch ?? "this branch"`)
    expect(body).toContain("head,")
    expect(body).toContain(`resultKey: "dialog.conflictsResult"`)
    expect(body).toContain(`failedKey: "dialog.conflictsFailed"`)
    // The agent pushes a merge commit, so the reads must be refreshed.
    expect(body).toContain("refresh: true")
  })

  test("the guard refuses without a view or an open PR", () => {
    const body = handler(gui)
    expect(body).toContain("current === undefined")
    expect(body).toContain("!isOpen()")
  })

  test("the old GitHub label key is gone from copy and call sites", () => {
    expect(i18n).not.toContain("resolveConflictsGithub")
    expect(gui).not.toContain("resolveConflictsGithub")
  })

  test("openGithub survives for the meta-line link", () => {
    expect(gui).toContain("const openGithub = () => {")
    expect(gui).toContain("openGithub()")
  })
})
