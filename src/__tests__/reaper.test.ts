// Pins the reaper's candidate table.
//
// The reaper deletes merged-PR branches without asking, so every refusal is a
// named rule instead of an implicit one. The single proof it accepts is tip
// equality: a local branch whose commit is exactly the merged PR's head commit
// carries no unpushed work. Each case below fixes one row of that table — the
// checked-out branch, a worktree-held branch, a moved tip, no merged PR, the
// protected integration names, the per-pass cap — so a future relaxation has
// to break a named test. `git`/`gh` argv order and parsing are covered here too,
// because both are plain strings until git.ts spawns anything.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import {
  isProtectedBranch,
  parseBranchRefs,
  pickDefaultBranch,
  reapPrs,
  reapVerdict,
  REAP_CAP,
  reaperPreference,
  shellQuote,
  type ReapBranch,
  type ReapPr,
} from "../pure"

const tip = "8f4c2a1d9b7e6f5a4c3b2d1e0f9a8b7c6d5e4f3a"
const other = "1111111111111111111111111111111111111111"

const branch = (name: string, oid = tip): ReapBranch => ({ branch: name, oid })
const pr = (number: number, name: string, oid = tip): ReapPr => ({ number, headRefName: name, headRefOid: oid })

// The shape git.ts calls with, minus the fields a case overrides.
const verdict = (over: Partial<Parameters<typeof reapVerdict>[0]> = {}) =>
  reapVerdict({ branches: [], merged: [], current: "", held: [], ...over })

describe("reapVerdict — one row per decision", () => {
  test("a merged PR whose head commit is the local tip is reaped with its restore command", () => {
    const out = verdict({ branches: [branch("feat/a")], merged: [pr(7, "feat/a")] })
    expect(out).toEqual({
      reaped: [{ branch: "feat/a", number: 7, oid: tip, restore: `git branch 'feat/a' ${tip}` }],
      skipped: [],
      truncated: false,
    })
  })

  test("the checked-out branch is never a candidate", () => {
    const out = verdict({ branches: [branch("feat/a")], merged: [pr(7, "feat/a")], current: "feat/a" })
    expect(out.reaped).toEqual([])
    expect(out.skipped).toEqual([{ branch: "feat/a", reason: "current" }])
  })

  test("a detached HEAD (empty --show-current) makes no branch current", () => {
    // The empty string must match nothing: with no current branch the merge
    // proof alone decides, so the branch is reaped.
    const out = verdict({ branches: [branch("feat/a")], merged: [pr(7, "feat/a")], current: "" })
    expect(out.reaped.map((entry) => entry.branch)).toEqual(["feat/a"])
  })

  test("a branch held by any worktree is never a candidate", () => {
    const out = verdict({ branches: [branch("feat/a")], merged: [pr(7, "feat/a")], held: ["feat/a"] })
    expect(out.reaped).toEqual([])
    expect(out.skipped).toEqual([{ branch: "feat/a", reason: "held" }])
  })

  test("current outranks held when both are true", () => {
    const out = verdict({
      branches: [branch("feat/a")],
      merged: [pr(7, "feat/a")],
      current: "feat/a",
      held: ["feat/a"],
    })
    expect(out.skipped).toEqual([{ branch: "feat/a", reason: "current" }])
  })

  test("a local tip that moved past the merged head is unpushed work", () => {
    const out = verdict({ branches: [branch("feat/a", other)], merged: [pr(7, "feat/a")] })
    expect(out.reaped).toEqual([])
    expect(out.skipped).toEqual([{ branch: "feat/a", reason: "unpushed-tip" }])
  })

  test("a branch with no merged PR is skipped", () => {
    const out = verdict({ branches: [branch("feat/a")], merged: [pr(7, "feat/b")] })
    expect(out.skipped).toEqual([{ branch: "feat/a", reason: "no-merged-pr" }])
  })

  test("a reused branch name matches the merged PR whose head commit is the tip", () => {
    // Old merged PR (same name, older commit) and the current one: only the
    // exact commit match may be deleted, and it names that PR.
    const out = verdict({
      branches: [branch("feat/a")],
      merged: [pr(9, "feat/a"), pr(7, "feat/a", other), pr(8, "feat/a")],
    })
    expect(out.reaped).toEqual([
      { branch: "feat/a", number: 9, oid: tip, restore: `git branch 'feat/a' ${tip}` },
    ])
  })

  test("integration names and origin/HEAD are protected", () => {
    const branches = [branch("main"), branch("master"), branch("trunk"), branch("develop"), branch("production")]
    const merged = branches.map((entry, index) => pr(index + 1, entry.branch))
    const out = verdict({ branches, merged, defaultBranch: "production" })
    expect(out.reaped).toEqual([])
    expect(out.skipped.map((entry) => entry.reason)).toEqual([
      "protected",
      "protected",
      "protected",
      "protected",
      "protected",
    ])
  })
})

describe("reapVerdict — the per-pass cap", () => {
  const names = ["a", "b", "c", "d", "e", "f", "g"]
  const branches = names.map((name) => branch(name))
  const merged = names.map((name, index) => pr(index + 1, name))

  test("the cap is five and takes the first names in for-each-ref order", () => {
    expect(REAP_CAP).toBe(5)
    const out = verdict({ branches, merged })
    expect(out.reaped.map((entry) => entry.branch)).toEqual(["a", "b", "c", "d", "e"])
    // The extra candidates are not skipped for a reason of their own; the flag
    // says the pass was cut short and the rest is next pass's work.
    expect(out.truncated).toBe(true)
    expect(out.skipped).toEqual([])
  })

  test("a pass at or under the cap is not truncated", () => {
    const out = verdict({ branches: branches.slice(0, 5), merged: merged.slice(0, 5) })
    expect(out.reaped).toHaveLength(5)
    expect(out.truncated).toBe(false)
  })

  test("skips do not consume the cap", () => {
    const out = verdict({
      branches: [branch("a", other), ...branches.slice(1)],
      merged,
      held: ["b"],
    })
    expect(out.reaped.map((entry) => entry.branch)).toEqual(["c", "d", "e", "f", "g"])
    expect(out.truncated).toBe(false)
    expect(out.skipped).toEqual([
      { branch: "a", reason: "unpushed-tip" },
      { branch: "b", reason: "held" },
    ])
  })

  test("a malformed cap falls back to five instead of deleting everything", () => {
    const out = reapVerdict({ branches, merged, held: [], cap: Number.NaN })
    expect(out.reaped).toHaveLength(REAP_CAP)
  })
})

describe("parseBranchRefs", () => {
  test("reads the NUL-separated for-each-ref format and skips the empty upstream", () => {
    const raw = `feat/a\0${tip}\0\nfix/b\0${other}\0origin/fix/b\n`
    expect(parseBranchRefs(raw)).toEqual([
      { branch: "feat/a", oid: tip },
      { branch: "fix/b", oid: other },
    ])
  })

  test("a line without a name or an object name is dropped, never guessed", () => {
    const raw = `\0${tip}\0\nfeat/a\0\0\nfeat/b\0${other}\0`
    expect(parseBranchRefs(raw)).toEqual([{ branch: "feat/b", oid: other }])
  })
})

describe("reapPrs", () => {
  test("accepts the gh payload and trims its strings", () => {
    expect(reapPrs([{ number: 7, headRefName: " feat/a ", headRefOid: ` ${tip} ` }])).toEqual([
      { number: 7, headRefName: "feat/a", headRefOid: tip },
    ])
  })

  test("an empty list is a valid answer, not a failure", () => {
    expect(reapPrs([])).toEqual([])
  })

  test("any malformed element invalidates the whole payload", () => {
    // A gh failure must delete nothing, and a payload this layer cannot read
    // is exactly that: unknown merge state.
    expect(reapPrs(undefined)).toBeUndefined()
    expect(reapPrs({})).toBeUndefined()
    expect(reapPrs([{ number: 7, headRefName: "feat/a" }])).toBeUndefined()
    expect(reapPrs([{ number: "7", headRefName: "feat/a", headRefOid: tip }])).toBeUndefined()
    expect(reapPrs([{ number: 7, headRefName: "", headRefOid: tip }])).toBeUndefined()
    expect(reapPrs([{ number: 0, headRefName: "feat/a", headRefOid: tip }])).toBeUndefined()
    expect(reapPrs([{ number: 7, headRefName: "feat/a", headRefOid: tip }, null])).toBeUndefined()
  })
})

describe("isProtectedBranch", () => {
  test("the integration names are case-insensitive and nothing else is", () => {
    expect(isProtectedBranch("main")).toBe(true)
    expect(isProtectedBranch(" MAIN ")).toBe(true)
    expect(isProtectedBranch("develop")).toBe(true)
    expect(isProtectedBranch("feat/main")).toBe(false)
    expect(isProtectedBranch("maintenance")).toBe(false)
  })
})

describe("shellQuote — the restore line is paste-safe", () => {
  test("plain and path-like names are quoted verbatim", () => {
    expect(shellQuote("plain")).toBe("'plain'")
    expect(shellQuote("feat/a")).toBe("'feat/a'")
  })

  test("separators, expansions and backticks stay literal", () => {
    // git only forbids space, `~^:?*[\`, `..`, `@{` and control characters in a
    // branch name, so `;`, `$` and backticks are legal. The restore command the
    // user pastes must not be able to run a second command.
    expect(shellQuote("feat/a;echo pwned")).toBe("'feat/a;echo pwned'")
    expect(shellQuote("$x")).toBe("'$x'")
    expect(shellQuote("a`id`b")).toBe("'a`id`b'")
  })

  test("an embedded single quote is closed, escaped and reopened", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})

describe("pickDefaultBranch — local, then gh, then abort", () => {
  test("a readable origin/HEAD wins over gh and is trimmed", () => {
    expect(pickDefaultBranch(" production ", "main")).toEqual({ ok: true, branch: "production" })
  })

  test("gh's defaultBranchRef is used when origin/HEAD is empty", () => {
    expect(pickDefaultBranch("", " production ")).toEqual({ ok: true, branch: "production" })
    expect(pickDefaultBranch(undefined, "production")).toEqual({ ok: true, branch: "production" })
    expect(pickDefaultBranch("   ", "production")).toEqual({ ok: true, branch: "production" })
  })

  test("both unreadable is a refusal, never 'no extra protection'", () => {
    // A repository whose default cannot be read is exactly where deleting the
    // wrong branch is unrecoverable, so the pass must not run.
    expect(pickDefaultBranch(undefined, undefined)).toEqual({ ok: false })
    expect(pickDefaultBranch("", "")).toEqual({ ok: false })
    expect(pickDefaultBranch("  ", "  ")).toEqual({ ok: false })
  })
})

describe("reaperPreference — missing, stored, unreadable", () => {
  test("a missing file is the documented default OFF", () => {
    // A stranger-safety default: a fresh install deletes nothing until the
    // user opts in once from the panel.
    expect(reaperPreference({ kind: "missing" }, "/repo")).toEqual({ enabled: false, known: true })
  })

  test("a stored map obeys this directory and leaves the others off", () => {
    expect(reaperPreference({ kind: "stored", map: { "/repo": false } }, "/repo")).toEqual({
      enabled: false,
      known: true,
    })
    expect(reaperPreference({ kind: "stored", map: { "/repo": true } }, "/repo")).toEqual({
      enabled: true,
      known: true,
    })
    // Another directory's opt-in says nothing about this one: absent stays off.
    expect(reaperPreference({ kind: "stored", map: { "/other": true } }, "/repo")).toEqual({
      enabled: false,
      known: true,
    })
    expect(reaperPreference({ kind: "stored", map: { "/other": false } }, "/repo")).toEqual({
      enabled: false,
      known: true,
    })
  })

  test("a corrupt file fails CLOSED and is reported unknown", () => {
    // The file cannot prove an opt-in, so the reaper must not act and the
    // switch must show Off until an explicit toggle rewrites the file.
    expect(reaperPreference({ kind: "unreadable" }, "/repo")).toEqual({ enabled: false, known: false })
  })
})
