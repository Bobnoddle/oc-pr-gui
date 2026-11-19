// Covers the plugin's English copy, now in its own module (./i18n) instead of an
// object literal buried inside gui.tsx's `Plugin.define` call. The split is what
// makes these assertions possible without loading Solid, the JSX transform or the
// plugin host: `bun test` imports the dictionary directly.
//
// Two things are pinned here:
//   - the shape: 167 keys, and the keys that were deliberately deleted stay
//     deleted (they would otherwise be revived by a careless merge and render as
//     orphaned UI text). The four branch-dialog keys (`dialog.branchName`,
//     `dialog.branchNamePlaceholder`, `dialog.createBranchDone`,
//     `dialog.continuePrompt`) went with the typed branch name: branch creation
//     is now a queued prompt, so the stash result keys
//     (`dialog.stashCreateDone`, `dialog.stashCreateDoneNoStash`,
//     `dialog.stashCreateFailed`, `dialog.stashRestoreFailed`) lost their reply
//     too. The PR-creating flow made the same move: the two typed PR fields and
//     the push/create progress + result copy went with its direct IPC calls.
//     In exchange the six branch-prompt and four push-create keys were added.
//   - the wording of the strings whose exact bytes matter: the merge confirmation
//     names the command it will run, and the two short labels are read verbatim
//     in the panel and in the confirm dialog.
//
// Keys are not a literal union: `Catalog` types every locale as
// `Readonly<Record<string, string>>` and `ctx.t(key: string)` accepts any string,
// so a typo in a call site is a runtime miss (the raw key renders), never a type
// error. This test is the only thing standing between a rename and a raw key in
// the UI, which is why it pins the count as well as the specific values.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { en } from "../i18n"

describe("en dictionary", () => {
  test("holds exactly the 167 keys the plugin defines", () => {
    expect(Object.keys(en)).toHaveLength(167)
  })

  test("the one-shot handoff explanation is pinned", () => {
    // This sentence is the only explanation a disabled handoff button offers, so
    // its two promises — a state change or the TTL — must survive any reword.
    expect(en["dialog.handoffDone"]).toBe(
      "Already requested for this state — the agent has it. It re-enables when the PR changes or after 10 minutes.",
    )
  })

  test("deleted keys stay deleted", () => {
    // Each of these was removed from the copy on purpose: the panel never shows a
    // loading label (it renders a skeleton), the branch is named in the dialog
    // title instead, and merge conflicts / push are worded at their own call
    // sites. `dialog.resetWorkspace` went with the merged-state ghost: tidying is
    // now automatic, so no layout offers that button. A resurrected key is dead
    // weight that still ships.
    for (const key of [
      "panel.loading",
      "dialog.branch",
      "dialog.mergeConflicts",
      "dialog.push",
      "dialog.resetWorkspace",
      // The typed-name field and the two branch-created success messages.
      "dialog.branchName",
      "dialog.branchNamePlaceholder",
      "dialog.createBranchDone",
      // The old post-create prompt and the stash reply's result wording.
      "dialog.continuePrompt",
      "dialog.stashCreateDone",
      "dialog.stashCreateDoneNoStash",
      "dialog.stashCreateFailed",
      "dialog.stashRestoreFailed",
      // PR creation is a queued prompt now: no typed title/description and no
      // push/create progress lines or created result to report.
      "dialog.prTitle",
      "dialog.prTitlePlaceholder",
      "dialog.prBody",
      "dialog.prBodyPlaceholder",
      "dialog.created",
      "confirm.progressPushing",
      "confirm.progressCreating",
    ]) {
      expect(Object.hasOwn(en, key)).toBe(false)
    }
  })

  test("the push-create handoff is agent-executable and needs no typed input", () => {
    const prompt = en["dialog.pushCreatePrompt"]
    for (const variable of ["{{state}}", "{{stale}}"]) {
      expect(prompt).toContain(variable)
    }
    expect(en["dialog.pushCreateState"]).toContain("{{branch}}")
    expect(en["dialog.pushCreateState"]).toContain("{{directory}}")
    // The agent writes the title and body itself; the UI never asks for them.
    expect(prompt).toContain("`pr_create`")
    expect(prompt).toContain("do not ask me for a title or description")
    expect(en["dialog.pushCreateResult"]).toContain("{{delivery}}")
    expect(en["dialog.pushCreateFailed"]).toContain("{{error}}")
  })

  test("the merge confirmation names the command it will run", () => {
    expect(en["panel.warning"]).toBe(
      "This runs `gh pr merge --squash --auto` for this PR in the current repository. Confirm to continue.",
    )
    // The auto-merge flag is the promise the confirmation makes; if the command
    // grows a flag, the sentence has to grow with it.
    expect(en["panel.warning"]).toContain("--squash")
    expect(en["panel.warning"]).toContain("--auto")
  })

  test("the two labels read verbatim in the panel and confirm", () => {
    expect(en["dialog.continueKeepChanges"]).toBe("Continue on new branch & keep changes")
    expect(en["panel.checksFailingOne"]).toBe("1 test failure")
  })

  test("the conflicts primary queues an agent prompt, not a browser link", () => {
    // The dialog title already names the PR and the action, so the button is the
    // short label; the old GitHub-link key is dead and must stay gone.
    expect(en["dialog.resolveConflicts"]).toBe("Resolve conflicts")
    expect(Object.hasOwn(en, "dialog.resolveConflictsGithub")).toBe(false)
    // The prompt is agent-executable: it names every template variable the
    // handler fills, forbids the two irreversible actions, and requires tests.
    const prompt = en["dialog.conflictsPrompt"]
    for (const variable of ["{{number}}", "{{head}}", "{{base}}"]) {
      expect(prompt).toContain(variable)
    }
    expect(prompt).toContain("Never merge the PR")
    expect(prompt).toContain("never force-push")
    expect(prompt).toContain("test suite")
    // Delivery toasts mirror the other agent-handoff actions.
    expect(en["dialog.conflictsResult"]).toContain("{{delivery}}")
    expect(en["dialog.conflictsFailed"]).toContain("{{error}}")
  })

  // Two-step merge, honest delivery wording, and the two refusal sentences are
  // read verbatim in the dialog body, so a rename must fail here rather than
  // render a raw key.
  test("the merge confirmation, delivery and refusal wordings are pinned", () => {
    expect(en["dialog.confirmMergeReset"]).toBe("Confirm merge & reset")
    expect(en["dialog.pending"]).toBe("Pending — the agent will report in the chat")
    expect(en["dialog.noPrNumber"]).toBe("No pull request number available — refresh and try again.")
    expect(en["dialog.staleSession"]).toContain("different project directory")
  })

  test("every key is namespaced and every value is a non-empty string", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(key).toContain(".")
      expect(typeof value).toBe("string")
      expect(value.length).toBeGreaterThan(0)
    }
  })
})
