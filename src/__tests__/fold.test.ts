// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import {
  BRANCH_PR_QUERY,
  FOLDED_PR_QUERY,
  foldKey,
  foldOutcome,
  foldThreads,
  parseStatusSnapshot,
  pickBranchPr,
  porcelainFiles,
  prFromGraphql,
  repoFromRemote,
} from "../pure"

// Tier B items 7 and 11. The two pure seams the main process now depends on:
// the folded GraphQL reply (one call for status + review threads) and the single
// `git status --porcelain=v2 --branch -z` read that replaced six git spawns.
// The v2 strings below are verbatim captures from a scratch repository; the
// GraphQL payloads mirror the live reply verified against freightway#305.

const filled = (owner: string, name: string) => ({ owner, name })

describe("repoFromRemote", () => {
  test("https with and without .git", () => {
    expect(repoFromRemote("https://github.com/Bobnoddle/freightway.git")).toEqual(
      filled("Bobnoddle", "freightway"),
    )
    expect(repoFromRemote("https://github.com/Bobnoddle/freightway")).toEqual(
      filled("Bobnoddle", "freightway"),
    )
    expect(repoFromRemote("https://github.com/Bobnoddle/freightway/")).toEqual(
      filled("Bobnoddle", "freightway"),
    )
  })

  test("scp-like ssh", () => {
    expect(repoFromRemote("git@github.com:Bobnoddle/freightway.git")).toEqual(
      filled("Bobnoddle", "freightway"),
    )
  })

  test("ssh:// with an explicit scheme", () => {
    expect(repoFromRemote("ssh://git@github.com/Bobnoddle/freightway.git")).toEqual(
      filled("Bobnoddle", "freightway"),
    )
  })

  test("a host other than github.com still parses (Enterprise)", () => {
    expect(repoFromRemote("git@ghe.internal.example.com:team/repo.git")).toEqual(
      filled("team", "repo"),
    )
  })

  test("a local path has no owner/repo and falls back", () => {
    expect(repoFromRemote("/Users/david/Projects/thing")).toBeUndefined()
    expect(repoFromRemote("file:///Users/david/Projects/thing")).toBeUndefined()
    expect(repoFromRemote("")).toBeUndefined()
    expect(repoFromRemote("   ")).toBeUndefined()
  })

  test("a path that is not owner/repo is refused", () => {
    expect(repoFromRemote("https://github.com/onlyowner")).toBeUndefined()
    expect(repoFromRemote("https://github.com/own er/repo.git")).toBeUndefined()
  })
})

describe("prFromGraphql", () => {
  test("maps the live freightway#305 shape", () => {
    const pr = prFromGraphql({
      number: 305,
      url: "https://github.com/Bobnoddle/freightway/pull/305",
      title: "feat(ai): monthly client analytics report graph",
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      headRefOid: "8bd4b4d806b79a4e4a0e8c3b7d1b00906a840100",
      baseRefName: "master",
      headRefName: "feat/monthly-client-reports",
      statusCheckRollup: {
        contexts: {
          nodes: [
            { __typename: "CheckRun", name: "auto-merge", conclusion: "SKIPPED", status: "COMPLETED" },
            { __typename: "CheckRun", name: "Lint", conclusion: "SUCCESS", status: "COMPLETED" },
            { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS" },
          ],
        },
      },
    })
    expect(pr).toEqual({
      number: 305,
      url: "https://github.com/Bobnoddle/freightway/pull/305",
      title: "feat(ai): monthly client analytics report graph",
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      // gh pr view prints "" for a missing decision, GraphQL sends null.
      reviewDecision: "",
      headRefOid: "8bd4b4d806b79a4e4a0e8c3b7d1b00906a840100",
      baseRefName: "master",
      headRefName: "feat/monthly-client-reports",
      statusCheckRollup: [
        { name: "auto-merge", conclusion: "SKIPPED", status: "COMPLETED" },
        { name: "Lint", conclusion: "SUCCESS", status: "COMPLETED" },
        { context: "ci/legacy", state: "SUCCESS" },
      ],
    })
  })

  test("a real review decision is kept verbatim", () => {
    const pr = prFromGraphql({ number: 1, reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: null })
    expect(pr?.reviewDecision).toBe("CHANGES_REQUESTED")
    expect(pr?.statusCheckRollup).toEqual([])
  })

  test("no number means the reply cannot be used", () => {
    expect(prFromGraphql({ url: "https://github.com/a/b/pull/1" })).toBeUndefined()
    expect(prFromGraphql(null)).toBeUndefined()
  })

  test("a running CheckRun keeps its status so it reads pending, not unknown", () => {
    // gh reports a queued run as conclusion "" + status IN_PROGRESS; the
    // flattening must carry both so checkLine can pick the non-blank one.
    const pr = prFromGraphql({
      number: 2,
      statusCheckRollup: {
        contexts: { nodes: [{ __typename: "CheckRun", name: "CI", conclusion: "", status: "IN_PROGRESS" }] },
      },
    })
    expect(pr?.statusCheckRollup).toEqual([{ name: "CI", conclusion: "", status: "IN_PROGRESS" }])
  })
})

describe("foldThreads", () => {
  test("counts unresolved threads only", () => {
    expect(
      foldThreads({ reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }, {}] } }),
    ).toEqual({ unresolved: 2 })
  })

  test("an empty list is a real zero, not unknown", () => {
    expect(foldThreads({ reviewThreads: { nodes: [] } })).toEqual({ unresolved: 0 })
  })

  test("a missing list is unknown", () => {
    expect(foldThreads({})).toBeUndefined()
    expect(foldThreads(null)).toBeUndefined()
  })
})

const foldedNode = {
  number: 305,
  url: "https://github.com/Bobnoddle/freightway/pull/305",
  title: "t",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  headRefOid: "abc",
  baseRefName: "master",
  headRefName: "feat/x",
  statusCheckRollup: { contexts: { nodes: [] } },
  reviewThreads: { nodes: [{ isResolved: false }] },
}

const payload = (data: unknown) => ({ ok: true, out: JSON.stringify({ data }) })

describe("foldKey", () => {
  test("a remembered number wins over the branch", () => {
    expect(foldKey({ branch: "feat/x", memo: 305 })).toEqual({ kind: "number", number: 305 })
  })

  test("without a number the branch is the key", () => {
    expect(foldKey({ branch: "feat/x" })).toEqual({ kind: "branch", branch: "feat/x" })
  })

  test("no branch and no number means no folded query at all", () => {
    expect(foldKey({})).toEqual({ kind: "none" })
    expect(foldKey({ branch: "" })).toEqual({ kind: "none" })
    expect(foldKey({ memo: 0 })).toEqual({ kind: "none" })
  })
})

describe("foldOutcome", () => {
  test("number-keyed reply folds status and threads together", () => {
    const outcome = foldOutcome(
      payload({ repository: { pullRequest: foldedNode } }),
      { kind: "number", number: 305 },
      "feat/x",
    )
    expect(outcome.kind).toBe("folded")
    if (outcome.kind !== "folded") return
    expect(outcome.pr.number).toBe(305)
    expect(outcome.threads).toEqual({ unresolved: 1 })
  })

  test("branch-keyed reply takes the first of one row", () => {
    const outcome = foldOutcome(
      payload({ repository: { pullRequests: { nodes: [foldedNode] } } }),
      { kind: "branch", branch: "feat/x" },
      "feat/x",
    )
    expect(outcome.kind).toBe("folded")
  })

  test("zero rows is the fork/no-PR case and falls back", () => {
    // pullRequests(headRefName:) cannot see a fork PR: the head branch lives in
    // another repository. Zero rows is also the ordinary no-PR state.
    const outcome = foldOutcome(
      payload({ repository: { pullRequests: { nodes: [] } } }),
      { kind: "branch", branch: "feat/x" },
      "feat/x",
    )
    expect(outcome).toEqual({ kind: "fallback", why: "no-pr" })
  })

  test("a null pullRequest falls back", () => {
    const outcome = foldOutcome(
      payload({ repository: { pullRequest: null } }),
      { kind: "number", number: 999999 },
      "feat/x",
    )
    expect(outcome).toEqual({ kind: "fallback", why: "no-pr" })
  })

  test("a remembered number that is no longer this branch falls back", () => {
    const stale = { ...foldedNode, headRefName: "feat/old" }
    const outcome = foldOutcome(
      payload({ repository: { pullRequest: stale } }),
      { kind: "number", number: 305 },
      "feat/new",
    )
    expect(outcome).toEqual({ kind: "fallback", why: "stale-number" })
  })

  test("an unparsable payload falls back", () => {
    expect(foldOutcome({ ok: true, out: "not json" }, { kind: "number", number: 1 })).toEqual({
      kind: "fallback",
      why: "unparsable",
    })
    expect(foldOutcome({ ok: true, out: "{}" }, { kind: "number", number: 1 })).toEqual({
      kind: "fallback",
      why: "unparsable",
    })
  })

  test("a reply without reviewThreads is not the folded contract", () => {
    const { reviewThreads: _dropped, ...withoutThreads } = foldedNode
    const outcome = foldOutcome(
      payload({ repository: { pullRequest: withoutThreads } }),
      { kind: "number", number: 305 },
      "feat/x",
    )
    expect(outcome).toEqual({ kind: "fallback", why: "unparsable" })
  })

  test("a gh failure falls back, and a timeout says so", () => {
    expect(foldOutcome({ ok: false, out: "", err: "boom" } as any, { kind: "number", number: 1 })).toEqual({
      kind: "fallback",
      why: "gh failed",
    })
    expect(
      foldOutcome({ ok: false, out: "", timedOut: true } as any, { kind: "number", number: 1 }),
    ).toEqual({ kind: "fallback", why: "timeout" })
  })

  test("an abort is a cancelled reply, not a fallback", () => {
    expect(foldOutcome({ ok: false, out: "", aborted: true } as any, { kind: "number", number: 1 })).toEqual({
      kind: "cancelled",
    })
  })

  test("no key never runs a query", () => {
    expect(foldOutcome(payload({ repository: {} }), { kind: "none" })).toEqual({
      kind: "fallback",
      why: "no-key",
    })
  })
})

describe("parseStatusSnapshot", () => {
  // Verbatim `git status --porcelain=v2 --branch -z` from the scratch repo:
  // modified + renamed (origin path as its own NUL record) + untracked with a
  // space in the name.
  const RICH =
    "# branch.oid 130a2506413d2ca78a962b6f0c42fe4a4b40c4b5\0" +
    "# branch.head main\0" +
    "# branch.upstream origin/main\0" +
    "# branch.ab +0 -0\0" +
    "1 .M N... 100644 100644 100644 5626abf0f72e58d7a153368ba57db4c673c0e171 5626abf0f72e58d7a153368ba57db4c673c0e171 a.txt\0" +
    "2 R. N... 100644 100644 100644 f719efd430d52bcfc8566a43b2eb655688d38871 f719efd430d52bcfc8566a43b2eb655688d38871 R100 c.txt\0" +
    "b.txt\0" +
    "? sp ace.txt\0"

  test("branch, oid, upstream, ahead/behind and the dirty entries in one read", () => {
    expect(parseStatusSnapshot(RICH)).toEqual({
      branch: "main",
      commit: "130a2506413d2ca78a962b6f0c42fe4a4b40c4b5",
      detached: false,
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      // v2 spells "unmodified" as "."; the v1 parser produced a space, so the
      // file list and `dirty` read identically from both.
      entries: [
        { status: " M", path: "a.txt" },
        { status: "R ", path: "c.txt" },
        { status: "??", path: "sp ace.txt" },
      ],
    })
  })

  test("the display lines match what the v1 parser produced", () => {
    expect(porcelainFiles(parseStatusSnapshot(RICH).entries)).toEqual([
      " M a.txt",
      "R  c.txt",
      "?? sp ace.txt",
    ])
  })

  test("a rename consumes its origin record instead of emitting a second entry", () => {
    const parsed = parseStatusSnapshot(RICH)
    expect(parsed.entries.map((entry) => entry.path)).toEqual(["a.txt", "c.txt", "sp ace.txt"])
  })

  test("ahead and behind carry the ab line's own order", () => {
    const parsed = parseStatusSnapshot(
      "# branch.head main\0# branch.upstream origin/main\0# branch.ab +3 -2\0",
    )
    expect(parsed.ahead).toBe(3)
    expect(parsed.behind).toBe(2)
  })

  test("a detached HEAD has a commit and no branch", () => {
    const parsed = parseStatusSnapshot(
      "# branch.oid 73bb3b85d73216f7c55be9aa311ace4fcd08b56c\0# branch.head (detached)\0",
    )
    expect(parsed).toEqual({
      branch: undefined,
      commit: "73bb3b85d73216f7c55be9aa311ace4fcd08b56c",
      detached: true,
      entries: [],
    })
  })

  test("no upstream leaves ahead/behind undefined so the origin probe still runs", () => {
    const parsed = parseStatusSnapshot(
      "# branch.oid 73bb3b85d73216f7c55be9aa311ace4fcd08b56c\0# branch.head main\0",
    )
    expect(parsed.upstream).toBeUndefined()
    expect(parsed.ahead).toBeUndefined()
    expect(parsed.behind).toBeUndefined()
    expect(parsed.branch).toBe("main")
  })

  test("an unborn branch is a branch with no commit", () => {
    const parsed = parseStatusSnapshot("# branch.oid (initial)\0# branch.head main\0")
    expect(parsed.branch).toBe("main")
    expect(parsed.commit).toBeUndefined()
    expect(parsed.detached).toBe(false)
  })

  test("an unmerged entry keeps its two-letter v1 status", () => {
    const parsed = parseStatusSnapshot(
      "u UU N... 100644 100644 100644 100644 1111 2222 3333 conflict.txt\0",
    )
    expect(parsed.entries).toEqual([{ status: "UU", path: "conflict.txt" }])
  })

  test("an empty read is a clean, detached-free snapshot", () => {
    expect(parseStatusSnapshot("")).toEqual({
      branch: undefined,
      commit: undefined,
      detached: false,
      entries: [],
    })
  })
})

describe("folded query shape", () => {
  test("one selection carries status fields AND reviewThreads", () => {
    expect(FOLDED_PR_QUERY).toContain("pullRequest(number:$number)")
    expect(FOLDED_PR_QUERY).toContain("statusCheckRollup")
    expect(FOLDED_PR_QUERY).toContain("reviewThreads(first:100)")
    expect(FOLDED_PR_QUERY).toContain("mergeStateStatus")
    expect(FOLDED_PR_QUERY).toContain("headRefOid")
    expect(FOLDED_PR_QUERY).toContain("baseRefName")
  })

  test("it never uses the commits.nodes rollup form", () => {
    expect(FOLDED_PR_QUERY).not.toContain("commits(")
    expect(BRANCH_PR_QUERY).not.toContain("commits(")
  })

  test("the branch-keyed form covers open, merged and closed PRs, newest first", () => {
    expect(BRANCH_PR_QUERY).toContain(
      "pullRequests(headRefName:$head,states:[OPEN,MERGED,CLOSED],first:10,orderBy:{field:CREATED_AT,direction:DESC})",
    )
    expect(BRANCH_PR_QUERY).toContain("reviewThreads(first:100)")
  })
})

describe("pickBranchPr (gate finding 1a)", () => {
  const OLD_MERGED = { number: 152, state: "MERGED", headRefName: "fix/reused", createdAt: "2026-10-17T23:04:04Z" }
  const NEW_OPEN = { number: 240, state: "OPEN", headRefName: "fix/reused", createdAt: "2026-10-31T14:23:07Z" }

  test("an open row wins over an older merged row on the same branch", () => {
    expect(pickBranchPr([NEW_OPEN, OLD_MERGED])).toBe(NEW_OPEN)
    // Defensive: the preference must not depend on the API's ordering.
    expect(pickBranchPr([OLD_MERGED, NEW_OPEN])).toBe(NEW_OPEN)
  })

  test("with no open row the newest row wins (merged display / Continue)", () => {
    const NEWER = { ...OLD_MERGED, number: 240, createdAt: "2026-10-31T14:23:07Z" }
    expect(pickBranchPr([NEWER, OLD_MERGED])).toBe(NEWER)
  })

  test("no rows and junk are undefined", () => {
    expect(pickBranchPr([])).toBeUndefined()
    expect(pickBranchPr(null)).toBeUndefined()
    expect(pickBranchPr([null, "x"])).toBeUndefined()
  })
})

describe("reused-branch resolution (gate finding 1)", () => {
  const reused = (number: number, state: string, createdAt: string) => ({
    ...foldedNode,
    number,
    state,
    createdAt,
    url: `https://github.com/Bobnoddle/freightway/pull/${number}`,
  })
  const OLD_MERGED = reused(152, "MERGED", "2026-10-17T23:04:04Z")
  const NEW_OPEN = reused(240, "OPEN", "2026-10-31T14:23:07Z")

  test("branch rows: the open PR wins over the older merged one", () => {
    // Newest-first, the order the ordered query now returns.
    const outcome = foldOutcome(
      payload({ repository: { pullRequests: { nodes: [NEW_OPEN, OLD_MERGED] } } }),
      { kind: "branch", branch: "feat/x" },
      "feat/x",
    )
    expect(outcome.kind).toBe("folded")
    if (outcome.kind !== "folded") return
    expect(outcome.pr.number).toBe(240)
    expect(outcome.pr.state).toBe("OPEN")
  })

  test("branch rows: the merged PR still resolves when it is the only row", () => {
    // Continue-from-merged reads MERGED from exactly this resolution.
    const outcome = foldOutcome(
      payload({ repository: { pullRequests: { nodes: [OLD_MERGED] } } }),
      { kind: "branch", branch: "feat/x" },
      "feat/x",
    )
    expect(outcome.kind).toBe("folded")
    if (outcome.kind !== "folded") return
    expect(outcome.pr.state).toBe("MERGED")
  })

  test("a remembered merged number is revalidated, not trusted", () => {
    expect(
      foldOutcome(payload({ repository: { pullRequest: OLD_MERGED } }), { kind: "number", number: 152 }, "feat/x"),
    ).toEqual({ kind: "revalidate" })
  })

  test("a remembered closed number is revalidated too", () => {
    const closed = { ...OLD_MERGED, state: "CLOSED" }
    expect(
      foldOutcome(payload({ repository: { pullRequest: closed } }), { kind: "number", number: 152 }, "feat/x"),
    ).toEqual({ kind: "revalidate" })
  })

  test("a remembered OPEN number is accepted without a second call (fast path)", () => {
    const outcome = foldOutcome(
      payload({ repository: { pullRequest: NEW_OPEN } }),
      { kind: "number", number: 240 },
      "feat/x",
    )
    expect(outcome.kind).toBe("folded")
    if (outcome.kind !== "folded") return
    expect(outcome.pr.number).toBe(240)
    expect(outcome.threads).toEqual({ unresolved: 1 })
  })
})
