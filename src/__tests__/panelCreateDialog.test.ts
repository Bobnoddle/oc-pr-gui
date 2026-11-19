// The panel's own Create button, pinned structurally in source (no rendering:
// Solid + the plugin host cannot be mounted headlessly, so nothing here claims a
// visual or runtime check).
//
// The defect this pins: the button ran `create()` directly, a setup-scope helper
// that called `ctx.main(PrPanel).create({ directory })` with no dialog. On the
// base branch that could only return git's head==base refusal (no on-base swap,
// no branch/title/body fields), and off base it bypassed the dialog's title and
// description fields shipped for `415a32e`. The titlebar chip already routed to
// `run: openDialog`; the panel now does the same, so both inherit the dialog's
// state machine. These assertions keep the direct call from coming back and keep
// the off-base create reachable through the dialog.
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

// One panel component: from its declaration to the Panel registration.
const panel = between(gui, "const PanelBody = () => {", "ctx.add(Panel, {")
// The no-PR create row only: the clean, nothing-to-create-yet state.
const createRow = between(panel, 'reason === "none"', 'reason === "not-repo"')
// One dialog component: from its declaration to the opener that mounts it.
const dialog = between(gui, "const PrActions = (props:", "const openDialog = () => {")

describe("panel Create button — it opens the dialog, never creates directly", () => {
  test("the button routes through the dialog opener", () => {
    expect(createRow).toContain("onClick={() => openDialog()}")
    // No direct backend call from the panel: the dialog owns the on-base swap,
    // the branch/title/body fields and the confirm wording.
    expect(createRow).not.toContain("void create()")
    expect(createRow).not.toContain(".create(")
    expect(createRow).not.toContain("create({")
  })

  test("the panel scope keeps no direct-create helper at all", () => {
    // The old setup-scope `create()` (and the result signal that only it wrote)
    // are gone, so no future wiring can re-point the button at a bare IPC call.
    expect(gui).not.toContain("const create = async () => {")
    expect(gui).not.toContain("setCreateResult")
    expect(panel).not.toContain("PrPanel).create(")
  })

  test("the button still exists for the clean no-PR state, under the same gate", () => {
    expect(createRow).toContain("when={panelCanCreate()}")
    expect(createRow).toContain('class="oc-pr-gui-primary"')
    // Off base it keeps the Create PR label; on base it names the branch create
    // the dialog's primary performs, exactly as the chip does.
    expect(createRow).toContain(`panelOnBase() ? ctx.t("dialog.createBranch") : ctx.t("panel.create")`)
  })

  test("on base is derived fail-closed from the divergence base and the reported branch", () => {
    // Setup scope, beside `panelCanCreate` — the same reads the chip uses.
    const helper = between(gui, "const panelOnBase = () => {", "const toneWord =")
    expect(helper).toContain("divergenceFor(directory())?.base")
    expect(helper).toContain("failure()?.branch")
    expect(helper).toContain(`baseBranch !== undefined && baseBranch !== "" && baseBranch === branch`)
    // A value derived once per read, not a dialog-scope function copy.
    expect(helper).not.toContain("const onBase = () =>")
  })
})

describe("panel Create button — the off-base path still creates the PR", () => {
  test("opening the dialog mounts PrActions for the same directory", () => {
    expect(gui).toContain(
      "ctx.dialogs.open((dialog) => <PrActions dialog={dialog} session={current} targetDir={targetDir} />)",
    )
  })

  test("off base the dialog's create primary queues the push-create prompt", () => {
    // There is no typed field gate any more: the panel button opens the same
    // dialog, and the create primary hands the work to the agent with a prompt.
    expect(dialog).not.toContain("prCreating")
    const create = between(dialog, "const doCreate = async () => {", "// Two-step merge")
    expect(create).toContain("await runQueuedPrompt({")
    expect(create).toContain("text: pushCreatePromptText()")
    expect(create).toContain('busy: "create"')
  })
})
