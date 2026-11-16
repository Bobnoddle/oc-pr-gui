// The confirm dialog's inputs — PR title and description — pinned structurally,
// the same source-slice style as createMessages.test.ts. Branch creation has NO
// input any more: it queues a prompt that has the agent name and create the
// branch from verified live state, so nothing in the dialog can carry a name.
// The dialog cannot be rendered headlessly (Solid + the plugin host), so nothing
// here claims a visual or runtime check: each pin only proves which field is in
// which gated region and that the handler passes the signal into the call.
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
  test("branch-creating actions render no branch input", () => {
    // The field, its signal, its placeholder helper, its empty→absent helper and
    // its label keys are gone; a resurrected one would put a typed name back in
    // front of the prompt, or a timestamp helper back in the bundle.
    for (const gone of [
      "branchField",
      "setBranchField",
      "branchPlaceholder",
      "branchInput",
      "dialog.branchName",
      "continueStamp",
    ]) {
      expect(dialog).not.toContain(gone)
    }
    // Only the two PR fields remain in the whole dialog.
    expect(count(dialog, "<ctx.ui.TextInput")).toBe(2)

    const predicate = between(dialog, "const branchCreating = () =>", "const prCreating = () =>")
    // Continue (merged), Create branch (detached), and the on-base swaps for a
    // dirty tree and the create row. The predicate survives because the meta
    // line is hidden on exactly these arms.
    expect(predicate).toContain(`actionKind() === "merged"`)
    expect(predicate).toContain(`actionKind() === "detached"`)
    expect(predicate).toContain("onBase()")
    expect(predicate).toContain(`actionKind() === "dirty"`)
    expect(predicate).toContain(`actionKind() === "create"`)
  })

  test("the meta line is hidden on branch-creating dialogs and kept for PR dialogs", () => {
    const meta = between(dialog, "const metaLine = (): string | undefined => {", "const metaGithubLabel")
    // The meta line was the branch being replaced; the prompt derives its state
    // from live reads instead, so the whole line (and its GitHub affordance) is
    // suppressed on the six branch arms.
    expect(meta).toContain("if (branchCreating()) return undefined")
    expect(meta).toContain("plainBranch() ?? branchLabel()")
  })

  test("the PR title and description render only for PR-creating actions", () => {
    const prShow = between(dialog, "when={prCreating()}", "{/* Armed merge")
    expect(prShow).toContain("value={titleField()}")
    expect(prShow).toContain("onInput={setTitleField}")
    expect(prShow).toContain(`label={ctx.t("dialog.prTitle")}`)
    expect(prShow).toContain("value={bodyField()}")
    expect(prShow).toContain("onInput={setBodyField}")
    expect(prShow).toContain(`label={ctx.t("dialog.prBody")}`)

    const predicate = between(dialog, "const prCreating = () =>", "let seededFor")
    // `create` (the create state's primary) and `push` (doPushThenCreate); both
    // off base, since on base the row creates the branch instead.
    expect(predicate).toContain("!onBase()")
    expect(predicate).toContain(`actionKind() === "create"`)
    expect(predicate).toContain(`actionKind() === "push"`)
  })

  test("the seeds are the documented defaults and reset on action change", () => {
    const seed = between(dialog, "let seededFor", "const prInput = ()")
    // Branch creation has no seed: no signal, no reset, no placeholder.
    expect(seed).not.toContain("setBranchField")
    // Title starts at the branch; description starts empty.
    expect(seed).toContain(`setTitleField(prCreating() ? (plainBranch() ?? "") : "")`)
    expect(seed).toContain(`setBodyField("")`)
    // A stale value cannot survive a change of action/base/branch.
    expect(seed).toContain("seededFor = key")
    expect(seed).toContain("if (key === seededFor) return")
  })
})

describe("confirm dialog fields — the values reach the contract calls", () => {
  test("branch creation never calls continueWork from the dialog", () => {
    // The backend and its contract entry are retained for the agent/other
    // callers; the GUI caller is removed, so no branch dialog can create a
    // branch before its prompt is delivered.
    expect(dialog).not.toContain("continueWork")
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
  })
})
