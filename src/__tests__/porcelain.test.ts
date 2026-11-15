// Covers the porcelain reader (including the first-entry repair that keeps a
// trimmed " M path" readable), the staging exclusion rules, the continue-branch
// stamp and the stash-retention wording shared by the dialog and the toast.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, spyOn, test } from "bun:test"
import {
  continueStamp,
  firstFilled,
  isExcludedPath,
  parsePorcelain,
  retainedStashNote,
  type StashLookup,
} from "../pure"

const OID = "0123456789abcdef0123456789abcdef01234567"

describe("parsePorcelain", () => {
  // `run(raw: true)` keeps stdout verbatim, so the window sees the leading
  // X-column space. That is the common path and must not be "repaired".
  test("verbatim -z output keeps the X column", () => {
    expect(parsePorcelain(" M src/a.ts\0?? b.txt\0A  c.ts\0")).toEqual([
      { status: " M", path: "src/a.ts" },
      { status: "??", path: "b.txt" },
      { status: "A ", path: "c.ts" },
    ])
  })

  test("a trimmed first entry is repaired and counted", () => {
    const stats = { repairs: 0 }
    expect(parsePorcelain("M src/a.ts\0?? b.txt\0", stats)).toEqual([
      { status: " M", path: "src/a.ts" },
      { status: "??", path: "b.txt" },
    ])
    expect(stats.repairs).toBe(1)
  })

  test("a repaired path that begins with pps/ keeps its full path", () => {
    // Regression shape from the old repair: the leading char must be prepended,
    // never spliced into the path.
    expect(parsePorcelain("M pps/notes/today.md\0")).toEqual([
      { status: " M", path: "pps/notes/today.md" },
    ])
  })

  test("only the first entry can be repaired; later trimmed entries stay as-is", () => {
    const stats = { repairs: 0 }
    const out = parsePorcelain("M a.ts\0M b.ts\0", stats)
    expect(stats.repairs).toBe(1)
    expect(out[0]).toEqual({ status: " M", path: "a.ts" })
    // The second entry was never at an edge of the raw string, so trim() could
    // not have touched it: the un-repaired shape shifts the path left by one,
    // which is exactly the damage the first-entry repair exists to undo.
    expect(out[1]).toEqual({ status: "M ", path: ".ts" })
  })

  test("a rename consumes its origin field and emits one entry with the new path", () => {
    expect(parsePorcelain("R  new.ts\0old.ts\0?? z.ts\0")).toEqual([
      { status: "R ", path: "new.ts" },
      { status: "??", path: "z.ts" },
    ])
  })

  test("a copy consumes its origin field too", () => {
    expect(parsePorcelain("C  copy.ts\0src.ts\0")).toEqual([{ status: "C ", path: "copy.ts" }])
  })

  test("short and empty entries are skipped, not guessed at", () => {
    expect(parsePorcelain("\0??\0?? \0?? x\0")).toEqual([{ status: "??", path: "x" }])
    expect(parsePorcelain("")).toEqual([])
  })

  test("a first entry with no X-column repair needed is not counted", () => {
    const stats = { repairs: 0 }
    parsePorcelain(" M a\0?? b\0", stats)
    expect(stats.repairs).toBe(0)
  })

  test("the repair warning names the count and uses the singular form", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      parsePorcelain("M a.ts\0")
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain("repaired 1 trimmed status entry")
      parsePorcelain(" M a.ts\0")
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("isExcludedPath", () => {
  test("any .env is excluded, but .env.example is not", () => {
    expect(isExcludedPath(".env")).toBe(true)
    expect(isExcludedPath("apps/web/.env")).toBe(true)
    expect(isExcludedPath(".env.example")).toBe(false)
    expect(isExcludedPath("docs/env.md")).toBe(false)
  })

  test("anything under .orch/ is excluded, a similar name is not", () => {
    expect(isExcludedPath(".orch/state.json")).toBe(true)
    expect(isExcludedPath("repo/.orch")).toBe(true)
    expect(isExcludedPath("orchestra/x.ts")).toBe(false)
  })

  test("secret-shaped basenames are excluded", () => {
    for (const path of [
      "certs/server.pem",
      "certs/server.key",
      "certs/server.p12",
      "store.keystore",
      "id_rsa",
      "id_rsa.pub",
      "my_credentials.json",
    ]) {
      expect(isExcludedPath(path)).toBe(true)
    }
  })

  test("the credentials match is case-insensitive and basename-scoped", () => {
    expect(isExcludedPath("secrets/AWS_CREDENTIALS")).toBe(true)
    expect(isExcludedPath("credentials/token.txt")).toBe(false)
  })

  test("ordinary source files are staged", () => {
    expect(isExcludedPath("src/app.tsx")).toBe(false)
    expect(isExcludedPath("README.md")).toBe(false)
    expect(isExcludedPath("keyboard.ts")).toBe(false)
  })
})

describe("firstFilled", () => {
  test("returns the first value with content after trimming", () => {
    expect(firstFilled(undefined, null, "", "   ", "  IN_PROGRESS ")).toBe("IN_PROGRESS")
    expect(firstFilled("", "second")).toBe("second")
  })

  test("non-strings count when they stringify to something", () => {
    expect(firstFilled(0)).toBe("0")
    expect(firstFilled(false)).toBe("false")
  })

  test("all-blank input is undefined", () => {
    expect(firstFilled()).toBeUndefined()
    expect(firstFilled(undefined, null, "", "  ")).toBeUndefined()
  })
})

describe("continueStamp", () => {
  test("pads month, day, hour and minute", () => {
    expect(continueStamp(new Date(2026, 0, 5, 3, 7))).toBe("20260105-0307")
  })

  test("does not pad what is already two digits", () => {
    expect(continueStamp(new Date(2026, 11, 31, 23, 59))).toBe("20261231-2359")
  })

  test("uses local components, matching the branch name the user sees", () => {
    const date = new Date(2026, 5, 9, 10, 4)
    expect(continueStamp(date)).toBe("20260609-1004")
  })
})

describe("retainedStashNote", () => {
  const retained: StashLookup = { listed: true, entry: { oid: OID, ref: "stash@{0}", subject: "x" } }
  const gone: StashLookup = { listed: true }
  const unknown: StashLookup = { listed: false }

  test("retained on the stack quotes the current ref in both renderings", () => {
    expect(retainedStashNote(retained, OID)).toContain(`stash entry retained: ${OID} (currently stash@{0})`)
    expect(retainedStashNote(retained, OID)).toContain("git stash drop stash@{0}")
    expect(retainedStashNote(retained, OID, true)).toStartWith("Stash entry retained:")
  })

  test("a successful listing without our oid says so factually", () => {
    expect(retainedStashNote(gone, OID)).toContain("is no longer listed by `git stash list`")
    expect(retainedStashNote(gone, OID)).toContain("nothing to clean up")
    expect(retainedStashNote(gone, OID, true)).toStartWith(`Stash entry ${OID} is no longer listed`)
  })

  test("a failed listing never claims retained or gone", () => {
    const full = retainedStashNote(unknown, OID)
    expect(full).toContain("could not verify retention")
    expect(full).not.toContain("no longer listed")
    expect(retainedStashNote(unknown, OID, true)).toStartWith("Could not verify retention")
  })

  test("compact and full renderings differ only in their leading clause", () => {
    const full = retainedStashNote(retained, OID)
    const compact = retainedStashNote(retained, OID, true)
    expect(full).not.toBe(compact)
    expect(full).toContain(`(currently ${retained.entry?.ref})`)
    expect(compact).toContain(`(currently ${retained.entry?.ref})`)
  })
})
