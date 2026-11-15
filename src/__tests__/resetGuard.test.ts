// Pins the merged-detection verdict behind `Reset workspace`.
//
// The count of commits outside origin/<base> is the whole guard on the fast
// path, but a squash merge leaves the head commit outside the base history, so
// a positive count is not proof of unmerged work. The verdict therefore asks
// GitHub — and every answer other than a full match must refuse. Each
// fail-closed case below is pinned separately so a future relaxation has to
// break a named test.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resetPrFacts, resetVerdict, type ResetPrFacts } from "../pure"

const git = readFileSync(new URL("../git.ts", import.meta.url), "utf8")

const feature = "feat/reset-guard"
const base = "main"
const tip = "8f4c2a1d9b7e6f5a4c3b2d1e0f9a8b7c6d5e4f3a"

const merged: ResetPrFacts = {
  state: "MERGED",
  headRefName: feature,
  headRefOid: tip,
  mergedAt: "2026-11-14T10:00:00Z",
}

// The shape gui.tsx calls with, minus the fields a case overrides.
const verdict = (over: Partial<Parameters<typeof resetVerdict>[0]> = {}) =>
  resetVerdict({ ahead: 1, number: 7, pr: merged, localTip: tip, feature, base, ...over })

describe("resetVerdict — git fast path", () => {
  test("nothing ahead of origin/<base> proceeds without force and without gh", () => {
    // No pr and no local tip: the fast path must not depend on either.
    const out = resetVerdict({ ahead: 0, feature, base })
    expect(out).toEqual({ proceed: true, forceDelete: false })
    // Even a PR that says otherwise cannot change this path.
    expect(verdict({ ahead: 0, pr: { state: "OPEN" } })).toEqual({ proceed: true, forceDelete: false })
    // A broken count is not a reason to refuse, only to skip gh.
    expect(verdict({ ahead: -1 })).toEqual({ proceed: true, forceDelete: false })
  })

  test("ahead is decided before any other field is read", () => {
    // A getter that throws proves the read order: if anything destructured the
    // rest of the input first, this call would throw instead of returning.
    const read: string[] = []
    const guarded = (name: string, value: unknown) => ({
      get: () => {
        read.push(name)
        throw new Error(`read ${name} on the fast path`)
      },
    })
    const input = Object.defineProperties(
      { ahead: 0 },
      {
        number: guarded("number", 7),
        pr: guarded("pr", merged),
        localTip: guarded("localTip", tip),
        feature: guarded("feature", feature),
        base: guarded("base", base),
      },
    ) as unknown as Parameters<typeof resetVerdict>[0]
    expect(resetVerdict(input)).toEqual({ proceed: true, forceDelete: false })
    expect(read).toEqual([])
  })

  test("a count that is not a usable number refuses instead of reading as zero", () => {
    for (const ahead of [Number.NaN, Number.POSITIVE_INFINITY, "0"] as unknown as number[]) {
      const out = resetVerdict({ ahead, number: 7, pr: merged, localTip: tip, feature, base })
      expect(out.proceed).toBe(false)
      expect(out.forceDelete).toBe(false)
      expect(out.reason).toBe(
        `Reset refused: could not read how far \`${feature}\` is ahead of origin/${base} (${String(ahead)}). No branch was deleted.`,
      )
    }
  })
})

describe("resetVerdict — squash merge, confirmed", () => {
  test("MERGED at the same branch and commit proceeds with -D", () => {
    expect(verdict()).toEqual({ proceed: true, forceDelete: true })
  })

  test("a merged PR outranks a missing mergedAt timestamp", () => {
    // `state` is authoritative; the timestamp is reporting, not identity.
    expect(verdict({ pr: { ...merged, mergedAt: undefined } })).toEqual({ proceed: true, forceDelete: true })
    expect(verdict({ pr: { ...merged, mergedAt: null } })).toEqual({ proceed: true, forceDelete: true })
  })

  test("state casing from gh does not matter", () => {
    expect(verdict({ pr: { ...merged, state: "merged" } })).toEqual({ proceed: true, forceDelete: true })
  })
})

describe("resetVerdict — malformed gh payloads (finding: payload validation)", () => {
  const unreadable = "Reset refused: could not read PR #7 from GitHub, so its merge state is unknown. No branch was deleted."

  test("resetPrFacts rejects anything that is not a plain object with a string state", () => {
    for (const raw of [null, [], "MERGED", 7, true, undefined]) {
      expect(resetPrFacts(raw)).toBeUndefined()
    }
    expect(resetPrFacts({ state: 7 })).toBeUndefined()
    expect(resetPrFacts({})).toBeUndefined()
    // Wrong-typed optional fields invalidate the payload too.
    expect(resetPrFacts({ state: "MERGED", headRefName: 5 })).toBeUndefined()
    expect(resetPrFacts({ state: "MERGED", headRefOid: {} })).toBeUndefined()
    expect(resetPrFacts({ state: "MERGED", mergedAt: 5 })).toBeUndefined()
    // The shapes gh actually prints are accepted, including a null mergedAt.
    expect(resetPrFacts({ state: "MERGED" })).toEqual({
      state: "MERGED",
      headRefName: undefined,
      headRefOid: undefined,
      mergedAt: undefined,
    })
    expect(resetPrFacts(merged)).toEqual(merged)
    expect(resetPrFacts({ state: "OPEN", mergedAt: null })).toEqual({
      state: "OPEN",
      headRefName: undefined,
      headRefOid: undefined,
      mergedAt: null,
    })
  })

  test("every malformed payload the caller can receive refuses by name", () => {
    // gui.tsx maps an undefined resetPrFacts to its named refusal and never
    // calls the verdict; this pins the two layers agreeing on that outcome.
    for (const raw of [null, [], "MERGED", { state: 7 }, {}, { state: "MERGED", headRefOid: 1 }]) {
      expect(resetPrFacts(raw)).toBeUndefined()
      const out = verdict({ pr: resetPrFacts(raw) })
      expect(out).toEqual({ proceed: false, forceDelete: false, reason: unreadable })
    }
  })

  test("resetVerdict itself never throws on a wrong-typed or absent pr record", () => {
    // The pure layer's contract is return-a-verdict, so a caller that skips the
    // validator still gets a refusal instead of an exception.
    const cases: unknown[] = [undefined, null, [], "MERGED", 7, { state: 7 }, { state: {} }, { state: "MERGED", headRefName: 5 }]
    for (const pr of cases) {
      const out = verdict({ pr: pr as ResetPrFacts | undefined })
      expect(out.proceed).toBe(false)
      expect(out.forceDelete).toBe(false)
      expect(typeof out.reason).toBe("string")
      expect((out.reason ?? "").length).toBeGreaterThan(0)
    }
  })

  test("a number with the right type but a misplaced value still refuses", () => {
    // `{"state":7}` is not MERGED, so the named refusal is the not-merged one.
    expect(verdict({ pr: { state: 7 as unknown as string } })).toEqual({
      proceed: false,
      forceDelete: false,
      reason: "Reset refused: PR #7 is not merged yet — reset after it lands. No branch was deleted.",
    })
  })
})

describe("resetVerdict — every fail-closed case refuses", () => {
  test("no PR number falls back to the unchanged count refusal", () => {
    expect(verdict({ number: undefined })).toEqual({
      proceed: false,
      forceDelete: false,
      reason: `Reset refused: \`${feature}\` has 1 commit(s) not in origin/${base}. Merge or push them first; no branch was deleted.`,
    })
  })

  test("a number that cannot name a PR is treated as missing", () => {
    const count = `Reset refused: \`${feature}\` has 1 commit(s) not in origin/${base}. Merge or push them first; no branch was deleted.`
    for (const number of [0, -3, 1.5, Number.NaN]) {
      const out = verdict({ number })
      expect(out.proceed).toBe(false)
      expect(out.reason).toBe(count)
    }
  })

  test("an unreadable or unparseable gh reply refuses (gh failure/timeout)", () => {
    expect(verdict({ pr: undefined })).toEqual({
      proceed: false,
      forceDelete: false,
      reason: "Reset refused: could not read PR #7 from GitHub, so its merge state is unknown. No branch was deleted.",
    })
  })

  test("not merged — including a queued auto-merge — names the PR", () => {
    const reason = "Reset refused: PR #7 is not merged yet — reset after it lands. No branch was deleted."
    for (const state of ["OPEN", "open", "CLOSED", "DRAFT", ""]) {
      expect(verdict({ pr: { ...merged, state } })).toEqual({ proceed: false, forceDelete: false, reason })
    }
    expect(verdict({ pr: { headRefName: feature, headRefOid: tip } })).toEqual({
      proceed: false,
      forceDelete: false,
      reason,
    })
  })

  test("head-name mismatch names both branches", () => {
    expect(verdict({ pr: { ...merged, headRefName: "something-else" } })).toEqual({
      proceed: false,
      forceDelete: false,
      reason: `Reset refused: PR #7 is from \`something-else\`, not \`${feature}\`. No branch was deleted.`,
    })
    // A blank head name is a mismatch, not a wildcard.
    expect(verdict({ pr: { ...merged, headRefName: undefined } })).toEqual({
      proceed: false,
      forceDelete: false,
      reason: `Reset refused: PR #7 is from \`an unknown branch\`, not \`${feature}\`. No branch was deleted.`,
    })
  })

  test("a branch that moved after the merge refuses with both commits", () => {
    const moved = "0000000000000000000000000000000000000000"
    expect(verdict({ localTip: moved })).toEqual({
      proceed: false,
      forceDelete: false,
      reason: `Reset refused: branch moved after the merge (head ${tip} ≠ local ${moved}). No branch was deleted.`,
    })
    // A PR that reports no head commit cannot be matched either.
    expect(verdict({ pr: { ...merged, headRefOid: undefined } })).toEqual({
      proceed: false,
      forceDelete: false,
      reason: `Reset refused: branch moved after the merge (head unknown ≠ local ${tip}). No branch was deleted.`,
    })
  })

  test("a local tip that could not be read refuses instead of comparing blanks", () => {
    const reason = `Reset refused: could not read the local tip of \`${feature}\`, so the merged commit cannot be confirmed. No branch was deleted.`
    expect(verdict({ localTip: undefined })).toEqual({ proceed: false, forceDelete: false, reason })
    expect(verdict({ localTip: "  " })).toEqual({ proceed: false, forceDelete: false, reason })
    // Both blank must not read as "equal", which is the trap this pins.
    expect(verdict({ localTip: "", pr: { ...merged, headRefOid: "" } }).proceed).toBe(false)
  })

  test("refusals never carry forceDelete", () => {
    for (const pr of [undefined, { state: "OPEN" }, { ...merged, headRefName: "x" }, { ...merged, headRefOid: "x" }]) {
      const out = verdict({ pr })
      expect(out.proceed).toBe(false)
      expect(out.forceDelete).toBe(false)
      expect((out.reason ?? "").length).toBeGreaterThan(0)
    }
  })
})

// Finding 1: moving the verified delete into casDeleteVerifiedBranch rewrote the
// timeout sentence to include the expected OID, which is not the promise the
// baseline made ("timed out" on a bounded command). The arm is pinned by its
// exact bytes, the createMessages.test.ts idiom: source-shape, not runtime.
describe("resetWorkspace — the verified-delete timeout keeps the baseline line", () => {
  function resetWorkspaceRegion(source: string): string {
    const start = source.indexOf("export async function resetWorkspace(")
    const end = source.indexOf("\nexport ", start + 1)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  test("the timeout arm returns the byte-exact baseline sentence", () => {
    const region = resetWorkspaceRegion(git)
    const start = region.indexOf('case "timeout":')
    const end = region.indexOf('case "', start + 1)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const arm = region.slice(start, end)
    expect(arm).toContain(
      "return fail(`Reset failed: \\`git update-ref -d refs/heads/${feature}\\` timed out.`)",
    )
    // The sentence names the ref only; the OID belongs to `cas.command`, not to
    // this user-facing first line.
    expect(arm).not.toContain("verifiedOid")
  })
})
