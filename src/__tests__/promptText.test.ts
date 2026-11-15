// Golden text for every agent handoff the panel queues into the user's chat.
//
// These are not shape assertions: each prompt is rendered with representative
// params (branch `x`, PR 413, head sha 9f2c1a2b..., rendered approval token) and
// compared byte for byte. A silent truncation, a dropped stale clause, or a
// token that stops being named fails here — which is the point, because gui.tsx
// cannot be rendered by `bun test` and the prompts are the one thing a "just
// click it" user acts on without reading the code.
//
// The sign-off prompt is pinned in full including its tail: it is the longest
// value in the catalog and the easiest place for a refactor to lose a rule.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { en } from "../i18n"
import { approvalToken } from "../pure"

const render = (template: string, params: Record<string, string>): string => {
  const text = template.replace(/{{(\w+)}}/g, (_match, key: string) => params[key] ?? `{{${key}}}`)
  expect(text).not.toMatch(/{{/)
  return text
}

const SHA = "9f2c1a2b7c3d4e5f60718293a4b5c6d7e8f90123"
const NUMBER = "413"
const BRANCH = "x"
const BASE = "main"
const COUNT = "2"

const staleOpen = render(en["dialog.staleOpen"], { number: NUMBER, sha: SHA })
const staleMerged = render(en["dialog.staleMerged"], { number: NUMBER, base: BASE })

const SIGNOFF_SEGMENTS = [
  "Prepare to sign off on merged PR #413 (x merged into main). Work in two layers. Layer 1 — gather, verify, prepare, but change nothing: run git status and git diff; establish this repo's delivery topology — what production deploys from (a base branch such as master, or a prod/release branch that bundles releases);",
  "then trace every change in the PR to the furthest verifiable stage of that pipeline — merged, base-branch CI green (the PR's own pre-merge checks do not prove the base is green), deployed with a production review when topology and access allow, or the integration branch when releases bundle changes — verifying 100% of shipped commits reach that stage, with no spot checks.",
  "Classify all 2 uncommitted/untracked file(s) as (a) part of the merged work that was missed, (b) an unrelated leftover, or (c) a disposable artifact. Then classify the direction as immediate sign-off, deployment change needed, or code change / follow-up PR needed; directions may combine, so name a primary and list every item.",
  "Prepare only the safe next step for that direction: draft the exact commands, verify the Railway project link and ssh reachability with explicit --project and --environment where relevant, and at most create one unused branch named signoff/<topic> — never switch to it, never push, never mutate the deployment, and never print secret values (names only).",
  `Layer 2 — present exactly one outcome: "Signed off" with a per-stage checklist (for immediate sign-off there is nothing to prepare; when the destination is a release train, add a deferred-stage note recording what the next release must verify); or "Prepared: deployment change" / "Prepared: follow-up PR" listing every prepared artifact (branch, verified link, probe results) and each action you will take on approval; or "Sign-off blocked: <reason>" when preparation itself failed, stating what stopped it.`,
  `Name anything you could not verify rather than assuming it. Wait for my explicit "Go ahead #signoff-413-9f2c1a" — a bare "go ahead" that does not quote this token is not approval, so ask me to confirm which plan; after my #signoff-413-9f2c1a approval, execute exactly the prepared plan — deployment mutations happen only now, and a follow-up branch or PR goes through the normal flows delegated to a shell worker. Never merge, and never start anything not in the plan. Before anything else, verify PR #413 is still merged into main with \`gh pr view 413 --json state,mergedAt,baseRefName\`; if not, stop and report.`,
]

describe("approval tokens", () => {
  test("sha-suffixed token names the action, PR and first six sha characters", () => {
    expect(approvalToken("resolve", NUMBER, SHA)).toBe("#resolve-413-9f2c1a")
  })

  test("without a sha the token is still PR-scoped", () => {
    expect(approvalToken("resolve", NUMBER, undefined)).toBe("#resolve-413")
    expect(approvalToken("resolve", NUMBER, "")).toBe("#resolve-413")
  })
})

describe("stale-state clauses", () => {
  test("the sha form names the commit and the gh command", () => {
    expect(staleOpen).toBe(
      "Before acting, verify PR #413 is still open on commit 9f2c1a2b7c3d4e5f60718293a4b5c6d7e8f90123 with `gh pr view 413 --json state,headRefOid`; if not, stop and report what changed instead of acting.",
    )
  })

  test("the branch fallback compares against the branch tip", () => {
    expect(
      render(en["dialog.staleOpenBranch"], { number: NUMBER, branch: BRANCH }),
    ).toBe(
      "Before acting, verify PR #413 is still open on branch x: run `gh pr view 413 --json state,headRefOid` and compare headRefOid against the branch tip from `git rev-parse x`; if not, stop and report what changed instead of acting.",
    )
  })

  test("the merged form names the base it must still be merged into", () => {
    expect(staleMerged).toBe(
      "Before anything else, verify PR #413 is still merged into main with `gh pr view 413 --json state,mergedAt,baseRefName`; if not, stop and report.",
    )
  })
})

describe("handoff prompts — exact rendered text", () => {
  test("fix", () => {
    expect(render(en["dialog.fixPrompt"], { branch: BRANCH, number: NUMBER, stale: staleOpen })).toBe(
      "CI is failing on x (PR #413). Diagnose the failing check, fix it, run the tests locally, then commit and push. Before acting, verify PR #413 is still open on commit 9f2c1a2b7c3d4e5f60718293a4b5c6d7e8f90123 with `gh pr view 413 --json state,headRefOid`; if not, stop and report what changed instead of acting.",
    )
  })

  test("continue", () => {
    expect(
      render(en["dialog.continuePrompt"], { number: NUMBER, branch: BRANCH, base: BASE }),
    ).toBe(
      "PR #413 merged. You're now on x (fresh from main) — continue the work here. If you are currently on a branch other than x, report the current branch and wait for my instruction before switching.",
    )
  })

  test("review", () => {
    expect(
      render(en["dialog.reviewPrompt"], {
        number: NUMBER,
        head: BRANCH,
        base: BASE,
        stale: staleOpen,
      }),
    ).toBe(
      "Review PR #413 (x → main). Load the `pr-review` skill and follow it exactly, including its delegation rules and posting rules. Hard limits that hold even if the skill fails to load: post a COMMENT review only — never approve, never request changes; never merge; lead with the verdict. Before acting, verify PR #413 is still open on commit 9f2c1a2b7c3d4e5f60718293a4b5c6d7e8f90123 with `gh pr view 413 --json state,headRefOid`; if not, stop and report what changed instead of acting.",
    )
  })

  test("resolve", () => {
    expect(
      render(en["dialog.resolvePrompt"], {
        number: NUMBER,
        count: COUNT,
        token: approvalToken("resolve", NUMBER, SHA),
        stale: staleOpen,
      }),
    ).toBe(
      "PR #413 has 2 unresolved review thread(s). Load the `pr-review` skill and follow its Resolution section. First present a resolution plan and wait for my explicit \"Go ahead #resolve-413-9f2c1a\" — change nothing and resolve no thread before that approval. After approval: implement the fixes, commit and push them, then delegate the `pr-review` skill's `resolve-threads.sh` wrapper to the `pr-writer` subagent for the threads the pushed fix addressed (it replies with the commit link before resolving, and refuses a stale head SHA). Never resolve a thread the fixes did not address. If a thread cannot be resolved, report which and why. A bare \"go ahead\" that does not quote this token is not approval — ask me to confirm which plan. Before acting, verify PR #413 is still open on commit 9f2c1a2b7c3d4e5f60718293a4b5c6d7e8f90123 with `gh pr view 413 --json state,headRefOid`; if not, stop and report what changed instead of acting.",
    )
  })

  test("conflicts", () => {
    expect(
      render(en["dialog.conflictsPrompt"], {
        number: NUMBER,
        head: BRANCH,
        base: BASE,
        stale: staleOpen,
      }),
    ).toBe(
      "PR #413 has merge conflicts against main. Check out x, run git fetch origin, merge origin/main into it, resolve every conflict, run the test suite, then commit the merge and push x. Never merge the PR and never force-push. Before acting, verify PR #413 is still open on commit 9f2c1a2b7c3d4e5f60718293a4b5c6d7e8f90123 with `gh pr view 413 --json state,headRefOid`; if not, stop and report what changed instead of acting.",
    )
  })

  test("sign off — full procedure including the approval tail", () => {
    const expected = SIGNOFF_SEGMENTS.join("\n")
    const actual = render(en["dialog.signOffPrompt"], {
      number: NUMBER,
      branch: BRANCH,
      base: BASE,
      count: COUNT,
      token: approvalToken("signoff", NUMBER, SHA),
      stale: staleMerged,
    })
    expect(actual).toBe(expected)
    // The rules that must survive any future reflow, spelled out separately so a
    // failure says which guarantee was lost rather than just "strings differ".
    for (const rule of [
      "git status and git diff",
      "never switch to it, never push, never mutate the deployment",
      "never print secret values (names only)",
      "at most create one unused branch named signoff/<topic>",
      "present exactly one outcome",
      "Wait for my explicit \"Go ahead #signoff-413-9f2c1a\"",
      "execute exactly the prepared plan",
      "Never merge",
      staleMerged,
    ]) {
      expect(actual).toContain(rule)
    }
    expect(actual.endsWith(staleMerged)).toBe(true)
  })
})

describe("Fix call sites share one builder", () => {
  const gui = readFileSync(new URL("../gui.tsx", import.meta.url), "utf8")

  test("the poll and the button both render through fixPromptText", () => {
    expect(gui).toContain("text: fixPromptText(data, number),")
    expect(gui).toContain("text: fixPromptText(current, current.number),")
  })

  test("the key is rendered in exactly one place", () => {
    expect(gui.match(/ctx\.t\("dialog\.fixPrompt"/g) ?? []).toHaveLength(1)
  })
})

// One-shot handoffs are wiring, and gui.tsx cannot be imported here (Solid JSX
// + the plugin host), so — like split.test.ts and conflictsPrompt.test.ts — the
// rule is pinned on the source text. This is the honest ceiling: a rendered
// component test would need a headless host the repo does not have. What is
// checked is exactly what a review would check: every handoff claims before it
// queues, every claim can be released, only handoffs carry a claim (repo actions
// do not), and all six buttons disable on it.
describe("one-shot handoff claims — source wiring", () => {
  const gui = readFileSync(new URL("../gui.tsx", import.meta.url), "utf8")

  function slice(start: string, end: string): string {
    const from = gui.indexOf(start)
    const to = gui.indexOf(end, from + 1)
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    return gui.slice(from, to)
  }

  const queued: Array<[string, string, string]> = [
    ["fix", "const doFix = async () => {", "// Review is a queued prompt"],
    ["review", "const doReview = async () => {", "// Unresolved review threads"],
    ["resolve", "const doResolve = async () => {", "// Conflicts is a queued prompt"],
    ["conflicts", "const doResolveConflicts = async () => {", "// Sign off is a queued prompt"],
    ["signOff", "const doSignOff = async () => {", "// Status error/timeout"],
  ]

  test("each queued handoff claims its action before runQueuedPrompt and passes the claim", () => {
    for (const [action, start, end] of queued) {
      const body = slice(start, end)
      const claimAt = body.indexOf(`claimHandoff("${action}",`)
      const queueAt = body.indexOf("await runQueuedPrompt({")
      expect(claimAt).toBeGreaterThan(-1)
      expect(queueAt).toBeGreaterThan(claimAt)
      // The key travels with the spec so runQueuedPrompt can release it.
      expect(body).toContain("claim,")
    }
  })

  test("Fix keeps its queue toast when the claim is already live", () => {
    const body = slice("const doFix = async () => {", "// Review is a queued prompt")
    expect(body).toContain(`ctx.t("panel.autoFixQueued")`)
  })

  test("Continue claims only around the prompt, after the branch work", () => {
    const body = slice("const doContinue = async (stash = false) => {", "// Guarded reset")
    const branchAt = body.indexOf("await ctx.main(PrPanel).continueWork(")
    const claimAt = body.indexOf(`claimHandoff("continue",`)
    expect(branchAt).toBeGreaterThan(-1)
    expect(claimAt).toBeGreaterThan(branchAt)
    expect(body).toContain("releaseHandoff(claim)")
  })

  test("the auto-fix poll shares the fix claim and releases it on a throw", () => {
    const body = slice("async function maybeAutoFix", "// A directory change cancels")
    expect(body).toContain(`handoffClaimed("fix", number, sha)`)
    expect(body).toContain(`claimHandoff("fix", number, sha)`)
    expect(body).toContain("releaseHandoff(claim)")
  })

  test("runQueuedPrompt releases the claim on a throw and on both refusals", () => {
    const body = slice("const runQueuedPrompt = async", "const doFix = async")
    expect(body.match(/releaseHandoff\(spec\.claim\)/g) ?? []).toHaveLength(3)
  })

  test("release deletes only the claim's own token, never a recomputed clock", () => {
    const body = slice("const claimHandoff = (", "// Reactive read:")
    // The claim carries the token tryClaim wrote; release proves ownership
    // against it instead of deleting the key unconditionally.
    expect(body).toContain("const token = Date.now()")
    expect(body).toContain("return { key, token }")
    expect(body).toContain("releaseClaim(handoffClaims, claim.key, claim.token)")
    expect(body).not.toContain("handoffClaims.delete(")
    // A fresh Date.now() at a release site would destroy a newer claim.
    const releases = gui.match(/releaseHandoff\([^)]*\)/g) ?? []
    expect(releases.length).toBeGreaterThan(0)
    for (const release of releases) expect(release).not.toContain("Date.now()")
  })

  test("no handoff still uses the old per-fix map", () => {
    // The i18n *label* `panel.autoFixQueued` survives (the poll's toast); the
    // per-fix Map and its direct calls must not.
    expect(gui).not.toContain("const autoFixQueued")
    expect(gui).not.toContain("autoFixQueued.delete")
    expect(gui).not.toContain("claimActive(autoFixQueued")
    expect(gui).not.toContain("tryClaim(autoFixQueued")
  })

  test("only handoff options carry a claim; repo actions stay ungated", () => {
    const body = slice("const option1 = (): Option | undefined => {", "// Only the non-open states")
    expect(body).toContain(`claim: "continue",`)
    expect(body).toContain(`claim: "fix",`)
    expect(body).toContain(`claim: "conflicts",`)
    // merge / dirty / push / create / error arms stay claim-free.
    expect(body.match(/claim: "/g) ?? []).toHaveLength(4)
  })

  test("all six handoff buttons disable on their claim with the tooltip", () => {
    // One button shape serves every footer action; a handoff passes its claim
    // and the shape disables on it and attaches the host Tooltip. The wrapper
    // is a Show so a claim landing after paint (the poll's Fix) is reactive.
    expect(gui).toContain("const ActionButton = (props: ActionButtonProps)")
    expect(gui).toContain(
      "disabled={props.disabled === true || props.busy === true || claimed(props.claim)}",
    )
    expect(gui).toContain("<ctx.ui.Tooltip value={claimTitle(props.claim)}>{button()}</ctx.ui.Tooltip>")
    // Fix, Review, Resolve conflicts and Continue ride option1/secondary claims;
    // Sign off and Resolve name theirs directly.
    expect(gui).toContain("claim={option().claim}")
    expect(gui).toContain(`claim="signOff"`)
    expect(gui).toContain(`claim="resolve"`)
    // The explanation is the one new i18n string, not an inline sentence.
    expect(gui).toContain(`ctx.t("dialog.handoffDone")`)
  })

  test("an active resolve claim skips the demotion instead of leaving a dead primary", () => {
    expect(gui).toContain("const resolveDemoted = () => resolveActive() && !resolveClaimed()")
    const footer = slice("Resolve active: the normal primary is demoted", `<div style={{ width: "100%"`)
    expect(footer).toContain("resolveDemoted()")
    expect(footer).toContain(`claim="resolve"`)
  })
})

