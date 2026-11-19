// The confirm dialog's inputs — or rather, their absence. Branch creation was
// the first flow to drop its typed name in favour of a queued agent prompt;
// PR creation now does the same. There is no title or description field, so the
// agent derives both from the actual changes and opens the PR with `pr_create`.
// These are source-level pins: the dialog cannot be rendered headlessly (Solid
// + the plugin host), so nothing here claims a visual or runtime check.
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

describe("confirm dialog fields — no typed input survives", () => {
  test("the branch and PR name/summary fields are all gone", () => {
    // A resurrected field would put a typed value back in front of the prompt
    // that now derives its own state and wording from the live repository.
    for (const gone of [
      "branchField",
      "setBranchField",
      "branchInput",
      "titleField",
      "setTitleField",
      "bodyField",
      "setBodyField",
      "prInput",
      "prCreating",
      "continueStamp",
      "dialog.branchName",
      "dialog.prTitle",
      "dialog.prBody",
    ]) {
      expect(dialog).not.toContain(gone)
    }
    // The only remaining input in the dialog body is the merge-reset switch.
    expect(dialog).not.toContain("<ctx.ui.TextInput")
    expect(dialog).toContain("<ctx.ui.Switch")
  })

  test("the meta line is hidden on branch-creating dialogs and kept for PR dialogs", () => {
    const meta = between(dialog, "const metaLine = (): string | undefined => {", "const metaGithubLabel")
    // The meta line was replaced by the prompt's own state sentence, so the
    // whole line (and its GitHub affordance) is suppressed on the six branches.
    expect(meta).toContain("if (branchCreating()) return undefined")
    expect(meta).toContain("plainBranch() ?? branchLabel()")

    const predicate = between(dialog, "const branchCreating = () =>", "// Branch creation is a queued handoff")
    expect(predicate).toContain(`actionKind() === "merged"`)
    expect(predicate).toContain(`actionKind() === "detached"`)
    expect(predicate).toContain("onBase()")
    expect(predicate).toContain(`actionKind() === "dirty"`)
    expect(predicate).toContain(`actionKind() === "create"`)
  })
})

describe("PR creation — both primaries queue the agent prompt", () => {
  test("the prompt builder is self-contained and derives its state from live reads", () => {
    const builder = between(dialog, "const pushCreateClaimScope = ()", "// Titles are the question")
    expect(builder).toContain("props.targetDir")
    expect(builder).toContain("plainBranch()")
    expect(builder).toContain('ctx.t("dialog.pushCreateState"')
    expect(builder).toContain('ctx.t("dialog.pushCreatePrompt"')
    expect(builder).toContain('ctx.t("dialog.staleBranch")')
    // One rendered key, shared by both call sites (the branch prompt works the
    // same way): a rename can never leave one arm rendering a raw key.
    expect((gui.match(/ctx\.t\("dialog\.pushCreatePrompt"/g) ?? []).length).toBe(1)
  })

  test("Create PR and Push-then-Create both claim, then queue, with no create IPC", () => {
    const arms: Array<[string, string, string]> = [
      ["const doCreate = async () => {", 'busy: "create"', "// Two-step merge"],
      ["const doPushThenCreate = async () => {", 'busy: "pushCreate"', "// Continue (merged)"],
    ]
    for (const [start, busy, end] of arms) {
      const body = between(dialog, start, end)
      expect(body).toContain('claimHandoff("pushCreate"')
      expect(body).toContain("pushCreateClaimScope()")
      const claimed = body.indexOf("const claim = claimHandoff(")
      const queued = body.indexOf("await runQueuedPrompt({")
      expect(claimed).toBeGreaterThan(-1)
      expect(queued).toBeGreaterThan(claimed)
      expect(body).toContain(busy)
      expect(body).toContain("text: pushCreatePromptText()")
      expect(body).toContain('resultKey: "dialog.pushCreateResult"')
      expect(body).toContain('failedKey: "dialog.pushCreateFailed"')
      expect(body).toContain("claim,")
      expect(body).not.toContain("ctx.main(PrPanel).create(")
      expect(body).not.toContain("prInput")
    }
  })

  test("Push only stays a direct IPC push and never reads a removed field", () => {
    const push = between(dialog, "const doPush = async () => {", "// \"Push, then Create PR\"")
    expect(push).toContain('ctx.main(PrPanel).push({ directory: props.targetDir, confirm: "push" })')
    expect(push).not.toContain("prInput")
    expect(push).not.toContain("titleField")
    expect(push).not.toContain("bodyField")
  })
})
