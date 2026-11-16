// Locks the IPC contract main and the window must agree on: the exact method
// set, what each schema accepts and rejects, and the two gh-failure
// classifiers. The schemas are what stop a value reaching gh's argv.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { classifyCreateError, classifyGhError, PrPanel } from "../contract"

const methods = PrPanel.spec.methods
// The bridge decodes with these codecs; decodeUnknownOption is the same codec
// without throwing, so it is the right oracle for acceptance.
const decode = (codec: unknown, value: unknown) =>
  Option.isSome(Schema.decodeUnknownOption(codec as never)(value))
const input = (name: string) => (methods as any)[name].input
const output = (name: string) => (methods as any)[name].output

const dir = "/tmp/worktree"

describe("PrPanel schema", () => {
  test("id, kind and the documented method set", () => {
    expect(PrPanel.id).toBe("oc-pr-gui")
    expect(PrPanel.kind).toBe("ipc")
    expect(Object.keys(methods).sort()).toEqual([
      "ahead",
      "autoFix",
      "commitPush",
      "continueWork",
      "create",
      "merge",
      "push",
      "reap",
      "reaper",
      "resetWorkspace",
      "status",
      "threads",
    ])
  })

  test("every method has an input and a String output", () => {
    for (const name of Object.keys(methods)) {
      expect(input(name)).toBeDefined()
      expect(output(name)).toBeDefined()
      expect(decode(output(name), JSON.stringify({ ok: true }))).toBe(true)
      expect(decode(output(name), { ok: true })).toBe(false)
    }
  })

  test("status requires a string directory", () => {
    expect(decode(input("status"), { directory: dir })).toBe(true)
    expect(decode(input("status"), { directory: 3 })).toBe(false)
    expect(decode(input("status"), {})).toBe(false)
    expect(decode(input("status"), null)).toBe(false)
  })

  test("unknown keys are dropped rather than rejected", () => {
    const codec = Schema.decodeUnknownOption(input("status") as never)
    const decoded = Option.getOrThrow(codec({ directory: dir, extra: 1 }) as never) as any
    expect(decoded).toEqual({ directory: dir })
    expect("extra" in decoded).toBe(false)
  })

  test("merge requires a number and the literal confirm value", () => {
    const ok = { directory: dir, number: 7, url: "https://github.com/o/r/pull/7", confirm: "merge" }
    expect(decode(input("merge"), ok)).toBe(true)
    // The second click is what sends "merge"; anything else must never pass.
    expect(decode(input("merge"), { ...ok, confirm: "yes" })).toBe(false)
    expect(decode(input("merge"), { ...ok, confirm: "Merge" })).toBe(false)
    // A numeric string is a different gh argument shape, so it is refused.
    expect(decode(input("merge"), { ...ok, number: "7" })).toBe(false)
    expect(decode(input("merge"), { ...ok, url: 7 })).toBe(false)
  })

  test("commitPush, push and resetWorkspace accept only their own literal", () => {
    for (const [name, literal] of [
      ["commitPush", "commit"],
      ["push", "push"],
      ["resetWorkspace", "reset"],
    ] as const) {
      expect(decode(input(name), { directory: dir, confirm: literal })).toBe(true)
      expect(decode(input(name), { directory: dir, confirm: "merge" })).toBe(false)
      expect(decode(input(name), { directory: dir })).toBe(false)
    }
  })

  test("resetWorkspace takes an optional PR number and only the reset literal", () => {
    expect(decode(input("resetWorkspace"), { directory: dir, confirm: "reset" })).toBe(true)
    // Additive: the number names the PR for the merged check in main.
    expect(decode(input("resetWorkspace"), { directory: dir, confirm: "reset", number: 7 })).toBe(true)
    // A numeric string, a wrong confirm or a missing confirm must never pass.
    expect(decode(input("resetWorkspace"), { directory: dir, confirm: "reset", number: "7" })).toBe(false)
    expect(decode(input("resetWorkspace"), { directory: dir, confirm: "merge", number: 7 })).toBe(false)
    expect(decode(input("resetWorkspace"), { directory: dir, number: 7 })).toBe(false)
  })

  test("reap and reaper take a directory; reaper's toggle is an optional boolean", () => {
    expect(decode(input("reap"), { directory: dir })).toBe(true)
    // No confirm literal and no extra fields: a pass is never armed.
    expect(decode(input("reap"), { directory: dir, confirm: "reap" })).toBe(true)
    expect(decode(input("reap"), {})).toBe(false)
    expect(decode(input("reap"), { directory: 1 })).toBe(false)

    expect(decode(input("reaper"), { directory: dir })).toBe(true)
    expect(decode(input("reaper"), { directory: dir, enabled: false })).toBe(true)
    expect(decode(input("reaper"), { directory: dir, enabled: true })).toBe(true)
    expect(decode(input("reaper"), { directory: dir, enabled: "yes" })).toBe(false)
    expect(decode(input("reaper"), {})).toBe(false)
  })

  test("create, autoFix and continueWork accept omitted optional fields", () => {
    expect(decode(input("create"), { directory: dir })).toBe(true)
    expect(decode(input("create"), { directory: dir, title: "t", base: "b" })).toBe(true)
    expect(decode(input("create"), { directory: dir, title: 1 })).toBe(false)

    expect(decode(input("autoFix"), { directory: dir })).toBe(true)
    expect(decode(input("autoFix"), { directory: dir, enabled: false })).toBe(true)
    expect(decode(input("autoFix"), { directory: dir, enabled: "yes" })).toBe(false)

    expect(decode(input("continueWork"), { directory: dir })).toBe(true)
    expect(decode(input("continueWork"), { directory: dir, stash: true })).toBe(true)
    expect(decode(input("continueWork"), { directory: dir, stash: 1 })).toBe(false)
  })

  test("threads needs directory, url and a numeric number", () => {
    expect(decode(input("threads"), { directory: dir, url: "u", number: 1 })).toBe(true)
    expect(decode(input("threads"), { directory: dir, url: "u" })).toBe(false)
    expect(decode(input("threads"), { directory: dir, number: 1 })).toBe(false)
    expect(decode(input("threads"), { directory: dir, url: "u", number: "1" })).toBe(false)
  })
})

describe("classifyGhError", () => {
  test("a branch without a PR is a normal none state", () => {
    expect(classifyGhError('no pull requests found for branch "feature"')).toBe("none")
    expect(classifyGhError('No Pull Requests Found For Branch "x"')).toBe("none")
  })

  test("outside a repository is not-repo in both git spellings", () => {
    expect(classifyGhError("fatal: not a git repository (or any of the parent directories)")).toBe("not-repo")
    expect(classifyGhError("no git repository found")).toBe("not-repo")
  })

  test("anything else stays a real error", () => {
    expect(classifyGhError("HTTP 401: Bad credentials")).toBe("error")
    expect(classifyGhError("")).toBe("error")
  })
})

describe("classifyCreateError", () => {
  test("unpushed branch and empty history are actionable states", () => {
    expect(classifyCreateError("You must first push the current branch")).toBe("not-pushed")
    expect(classifyCreateError("No commits between main and feature")).toBe("no-commits")
  })

  test("an existing PR is recognised by gh's spellings", () => {
    expect(classifyCreateError('a pull request for branch "x" already exists')).toBe("exists")
    expect(classifyCreateError("A pull request for branch x already exists")).toBe("exists")
  })

  test("gh's head == base refusal is its own kind", () => {
    expect(
      classifyCreateError(
        'head branch "main" is the same as base branch "main", cannot create a pull request',
      ),
    ).toBe("same-branch")
  })

  test("near misses that only mention a base branch stay in their own kind", () => {
    // gh's other equal-history refusal: same branch names, different sentence,
    // and it already has an actionable kind of its own.
    expect(classifyCreateError("No commits between main and main")).toBe("no-commits")
    // The phrase alone is not enough: the pattern is anchored at the start and
    // requires the full comparison clause, so a prefix or a fragment is unknown.
    expect(
      classifyCreateError(
        'warning: head branch "main" is the same as base branch "main", cannot create a pull request',
      ),
    ).toBe("unknown")
    expect(classifyCreateError('base branch "main" is protected')).toBe("unknown")
    expect(classifyCreateError('head branch "x" is not the same as base branch "main"')).toBe(
      "unknown",
    )
  })

  test("an unknown failure is left unknown so the raw line can be shown", () => {
    expect(classifyCreateError("HTTP 502")).toBe("unknown")
    expect(classifyCreateError("")).toBe("unknown")
  })
})
