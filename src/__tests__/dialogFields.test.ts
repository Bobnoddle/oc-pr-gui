// The confirm dialog's three inputs — branch name, PR title and PR description —
// pinned structurally, the same source-slice style as createMessages.test.ts.
// The dialog cannot be rendered headlessly (Solid + the plugin host), so nothing
// here claims a visual or runtime check: each pin only proves that the field is
// in the right gated region and that the handler passes the signal into the
// contract call.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const gui = readFileSync(new URL("../gui.tsx", import.meta.url), "utf8")

// One dialog component: from its declaration to the opener that mounts it.
function dialogRegion(source: string): string {
  const start = source.indexOf("const PrActions = (props:")
  const end = source.indexOf("const openDialog = () => {")
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

const dialog = dialogRegion(gui)

const between = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + 1)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

const count = (source: string, needle: string): number => source.split(needle).length - 1

describe("confirm dialog fields — gated on what the chosen action does", () => {
  test("the branch field renders only for branch-creating actions", () => {
    const branchShow = between(dialog, "when={branchCreating()}", "when={prCreating()}")
    expect(branchShow).toContain("value={branchField()}")
    expect(branchShow).toContain("onInput={setBranchField}")
    expect(branchShow).toContain(`label={ctx.t("dialog.branchName")}`)
    // The generated name is the field's PLACEHOLDER, not its value: a prefilled
    // timestamp reads as an answer the user has to clear first.
    expect(branchShow).toContain("placeholder={branchPlaceholder()}")
    // No PR field shares the branch gate.
    expect(branchShow).not.toContain("titleField()")
    expect(branchShow).not.toContain("bodyField()")

    const predicate = between(dialog, "const branchCreating = () =>", "const prCreating = () =>")
    // Continue (merged), Create branch (detached), and the on-base swaps for a
    // dirty tree and the create row. Anything else must not offer a name.
    expect(predicate).toContain(`actionKind() === "merged"`)
    expect(predicate).toContain(`actionKind() === "detached"`)
    expect(predicate).toContain("onBase()")
    expect(predicate).toContain(`actionKind() === "dirty"`)
    expect(predicate).toContain(`actionKind() === "create"`)
  })

  test("the PR title and description render only for PR-creating actions", () => {
    const prShow = between(dialog, "when={prCreating()}", "{/* Armed merge")
    expect(prShow).toContain("value={titleField()}")
    expect(prShow).toContain("onInput={setTitleField}")
    expect(prShow).toContain(`label={ctx.t("dialog.prTitle")}`)
    expect(prShow).toContain("value={bodyField()}")
    expect(prShow).toContain("onInput={setBodyField}")
    expect(prShow).toContain(`label={ctx.t("dialog.prBody")}`)
    expect(prShow).not.toContain("branchField()")

    const predicate = between(dialog, "const prCreating = () =>", "let seededFor")
    // `create` (the create state's primary) and `push` (doPushThenCreate); both
    // off base, since on base the row creates the branch instead.
    expect(predicate).toContain("!onBase()")
    expect(predicate).toContain(`actionKind() === "create"`)
    expect(predicate).toContain(`actionKind() === "push"`)
  })

  test("the seeds are the documented defaults and reset on action change", () => {
    const seed = between(dialog, "let seededFor", "const branchInput = ()")
    // The branch field starts BLANK: the timestamped suggestion is only the
    // placeholder (see `branchPlaceholder`), so accepting the default means
    // leaving the field alone and the value is sent as absent.
    expect(seed).toContain(`setBranchField("")`)
    expect(seed).not.toContain("setBranchField(branchCreating()")
    // The suggestion itself still matches main's own fallback and stays gated on
    // the branch-creating actions, so no other state shows it.
    expect(seed).toContain("const branchPlaceholder = () =>")
    expect(seed).toContain("branchCreating() ? `continue/${continueStamp()}`")
    // Title starts at the branch; description starts empty.
    expect(seed).toContain(`setTitleField(prCreating() ? (plainBranch() ?? "") : "")`)
    expect(seed).toContain(`setBodyField("")`)
    // A stale value cannot survive a change of action/base/branch.
    expect(seed).toContain("seededFor = key")
    expect(seed).toContain("if (key === seededFor) return")
  })
})

describe("confirm dialog fields — the values reach the contract calls", () => {
  test("every continueWork call site passes the branch input", () => {
    const sites: string[] = []
    let from = 0
    for (;;) {
      const at = dialog.indexOf(".continueWork(", from)
      if (at === -1) break
      sites.push(dialog.slice(at, at + 320))
      from = at + 1
    }
    // Continue, the stash-backed create, and the clean create branch.
    expect(sites).toHaveLength(3)
    for (const site of sites) expect(site).toContain("...branchInput()")
  })

  test("both create call sites pass the PR title and body", () => {
    // doCreate and doPushThenCreate only: the panel's own create chip has no
    // dialog fields and is outside this region.
    expect(count(dialog, "create({ directory: props.targetDir, ...prInput() })")).toBe(2)
    // Empty input is sent as absent, not as an empty string, so main keeps its
    // own fallback (timestamped branch, branch name as title, empty body).
    const pr = between(dialog, "const prInput = ()", "// Titles are the question")
    expect(pr).toContain("titleField().trim() || undefined")
    expect(pr).toContain("bodyField().trim() || undefined")
    const branch = between(dialog, "const branchInput = ()", "const prInput = ()")
    expect(branch).toContain("branchField().trim() || undefined")
  })
})
