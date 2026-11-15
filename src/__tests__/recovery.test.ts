// Covers the post-failure advice printed by the stash-backed Continue flow.
// `recoveryCommand` decides which of the two commands can still make progress:
// an index-stage refusal applied nothing and loops on `--index`, so it must
// point at the plain apply; every other failure keeps the `--index` wording
// that also restores the staged/unstaged split.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { recoveryCommand } from "../pure"

// The real text git prints when the stash entry's index commit cannot be
// rebuilt: the fatal line git suggests the workaround for.
const INDEX_STAGE = "error: patch failed: src/a.ts:10\nerror: conflicts in index. Try without --index."
// A worktree-stage conflict: the patch touched the file, so the worktree now
// holds the conflict and re-running the same command after resolving is right.
const WORKTREE_STAGE = "error: patch failed: src/a.ts:10\nerror: src/a.ts: patch does not apply"

describe("recoveryCommand", () => {
  test("index-stage failure points at the plain apply and names the lost split", () => {
    const text = recoveryCommand(INDEX_STAGE, "abc123")
    expect(text).toContain("`git stash apply abc123` instead of `--index`")
    expect(text).toContain("the staged/unstaged split is not restored")
    expect(text).toContain("`git add`")
    expect(text).not.toContain("stash apply --index")
  })

  test("the bare `Try without --index` hint alone is enough to classify", () => {
    expect(recoveryCommand("hint: Try without --index", "abc123")).toContain("instead of `--index`")
  })

  test("index-stage detection is case-insensitive", () => {
    expect(recoveryCommand("ERROR: CONFLICTS IN INDEX. TRY WITHOUT --INDEX.", "abc123")).toContain(
      "instead of `--index`",
    )
  })

  test("worktree-stage failure keeps the exact --index wording", () => {
    expect(recoveryCommand(WORKTREE_STAGE, "abc123")).toBe(
      "`git stash apply --index abc123` after resolving the conflict.",
    )
  })

  test("an ordinary CONFLICT line stays on the --index wording", () => {
    expect(recoveryCommand("CONFLICT (content): Merge conflict in src/a.ts", "abc123")).toBe(
      "`git stash apply --index abc123` after resolving the conflict.",
    )
  })

  test("empty stderr falls back to the safe --index default", () => {
    expect(recoveryCommand("", "abc123")).toBe("`git stash apply --index abc123` after resolving the conflict.")
  })

  test("unrelated stderr (timeout/abort text) keeps the --index default", () => {
    expect(recoveryCommand("git stash apply --index timed out", "abc123")).toBe(
      "`git stash apply --index abc123` after resolving the conflict.",
    )
  })

  test("the oid is interpolated into both variants", () => {
    const oid = "9f2c0d1e8b7a6f5e4d3c2b1a09f8e7d6c5b4a392"
    expect(recoveryCommand(INDEX_STAGE, oid)).toContain(`\`git stash apply ${oid}\``)
    expect(recoveryCommand(WORKTREE_STAGE, oid)).toContain(`\`git stash apply --index ${oid}\``)
  })
})
