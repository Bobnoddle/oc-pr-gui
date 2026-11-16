// The titlebar chip's label, pinned structurally in source (no rendering: Solid
// + the plugin host cannot be mounted headlessly, so nothing here claims a
// visual or runtime check).
//
// The defect this pins: on the base branch the chip read `Create PR` while the
// dialog it opens asked the branch question (`Create branch from base`), because
// the chip never consulted the on-base swap the dialog performs. The chip itself
// only opens that dialog (`run: openDialog`), so the fix is the label; these
// assertions keep the chip from regaining a PR label on base, and keep anyone
// from "fixing" it by calling the create action from the chip.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const gui = readFileSync(new URL("../gui.tsx", import.meta.url), "utf8")

const between = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + 1)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

// One titlebar registration: from the component add to the next scope (`tab`).
const titlebar = between(gui, "ctx.add(TitlebarItem, () => {", "    const tab = {")
// The no-PR state only: the block whose labels describe the branch's own state.
const noPr = between(titlebar, 'if (latest.reason === "none") {', 'if (latest.reason === "cancelled") {')

describe("titlebar chip — on base it names branch creation, not Create PR", () => {
  test("the chip opens the dialog and never runs create itself", () => {
    // The single run for every chip state is the dialog opener.
    expect(titlebar).toContain("run: openDialog,")
    // No direct backend call from the chip: the dialog owns the guards, the
    // on-base swap and the branch/title/body fields.
    expect(titlebar).not.toContain(".create(")
    expect(titlebar).not.toContain("create({")
  })

  test("the clean no-PR row picks the branch label on base and Create PR off it", () => {
    expect(noPr).toContain(`onBase ? ctx.t("dialog.createBranch") : ctx.t("panel.create")`)
    // The old unconditional label must not come back.
    expect(noPr).not.toMatch(/return item\(\s*ctx\.t\("panel\.create"\)/)
  })

  test("the dirty row names the branch move the dialog's primary shows on base", () => {
    // Same string as `option1`'s dirty/on-base primary (`dialog.moveToNewBranch`,
    // whose handler is doStashCreate), so chip and dialog agree word for word.
    expect(noPr).toContain(`onBase ? ctx.t("dialog.moveToNewBranch") : ctx.t("chip.commitPush")`)
  })

  test("on base is derived fail-closed from the divergence base and the branch", () => {
    // Same rule as the dialog's `onBase()`: an absent/empty base is never on
    // base, and the comparison side is the branch `status` reported.
    expect(noPr).toContain("const baseBranch = divergence?.base")
    expect(noPr).toContain(`baseBranch !== undefined && baseBranch !== "" && baseBranch === latest.branch`)
    // The dialog's helper is a function inside `PrActions` and is not in this
    // scope; a copy of it here must stay a value derived once from the reads.
    expect(noPr).not.toContain("const onBase = () =>")
  })
})
