// Covers the plugin's visual vocabulary, now in its own module (./style): the
// approved state palette and the one Style sheet gui.tsx registers with
// `ctx.add(Style, PR_STYLE)`.
//
// Why this file exists: the sheet is a template literal that interpolates
// `${PALETTE.x}` into 11 `--oc-pr-gui-tone:` declarations. A literal that drifted
// back to a hard-coded hex would still build, still pass every other test, and
// only show up as a state whose banner and chip disagree with its primary — the
// exact class of bug the palette note in ./style documents against. So the guard
// is two-sided: the evaluated sheet must resolve to the approved hex per state,
// and the source must still be written in terms of the palette.
//
// Both values are window-side data. Evaluating PR_STYLE here needs no Solid, no
// JSX transform and no plugin host, which is the testability the split bought.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { PALETTE, PR_STYLE } from "../style"

// The approved table: one name per hex, no two names sharing one, and `neutral`
// the only name for #9CA3AF.
const SETTLED = {
  blue: "#60A5FA",
  amber: "#FBBF24",
  green: "#4ADE80",
  redSoft: "#FCA5A5",
  red: "#F87171",
  purple: "#A78BFA",
  neutral: "#9CA3AF",
} as const

// state -> the tone it must paint. The states are the ones the sheet actually
// writes; `create`/`pending`/`green`/`failing`/`review`/`conflicts`/`unknown`/
// `merged`/`closed`/`error` plus the bare default.
const EXPECTED_TONE: Record<string, string> = {
  "": SETTLED.neutral,
  create: SETTLED.blue,
  pending: SETTLED.amber,
  green: SETTLED.green,
  failing: SETTLED.redSoft,
  review: SETTLED.redSoft,
  conflicts: SETTLED.red,
  unknown: SETTLED.neutral,
  merged: SETTLED.purple,
  closed: SETTLED.neutral,
  error: SETTLED.neutral,
}

const source = readFileSync(new URL("../style.ts", import.meta.url), "utf8")
const toneLines = source.split("\n").filter((line) => line.includes("--oc-pr-gui-tone:"))

describe("PALETTE", () => {
  test("is exactly the seven settled colours", () => {
    // Exact equality, not a subset: an eighth tone or a changed hex has to be a
    // deliberate edit here too, because every tone is contrast-audited.
    expect(PALETTE).toEqual(SETTLED)
    expect(Object.keys(PALETTE)).toHaveLength(7)
  })

  test("no two names share a hex", () => {
    // One name per hex keeps a tone name unambiguous at every call site.
    expect(new Set(Object.values(PALETTE)).size).toBe(7)
  })
})

describe("PR_STYLE", () => {
  test("writes one tone declaration per state, eleven in all", () => {
    expect(toneLines).toHaveLength(11)
    const states = toneLines.map((line) => (line.match(/^\[data-oc-pr-state(?:="([a-z]+)")?\] \{/) ?? [])[1] ?? "")
    expect(states).toEqual(["", "create", "pending", "green", "failing", "review", "conflicts", "unknown", "merged", "closed", "error"])
  })

  test("the evaluated sheet resolves every tone to its approved hex", () => {
    for (const line of PR_STYLE.split("\n")) {
      if (!line.includes("--oc-pr-gui-tone:")) continue
      const state = (line.match(/^\[data-oc-pr-state(?:="([a-z]+)")?\]/) ?? [])[1] ?? ""
      const hex = line.match(/--oc-pr-gui-tone: (#[0-9A-F]{6});/)?.[1]
      expect(hex).toBe(EXPECTED_TONE[state])
    }
  })

  test("the sheet is fully interpolated by import time", () => {
    // A surviving `${` would mean the sheet shipped a placeholder to the host.
    expect(PR_STYLE).not.toContain("${")
    expect(PR_STYLE).not.toContain("PALETTE")
  })

  test("all eleven tone lines are written in terms of PALETTE, never a raw hex", () => {
    // The drift guard: these lines must interpolate a palette name, so the palette
    // stays the single source of the tone colour.
    for (const line of toneLines) {
      expect(line).toContain("${PALETTE.")
      expect(line).not.toMatch(/#[0-9A-Fa-f]{3,8}/)
    }
  })

  test("the default rule comes first, so every state overrides it", () => {
    // Source order matters for equal-specificity rules; the bare selector is the
    // fallback and must precede the per-state ones.
    expect(toneLines[0]).toBe("[data-oc-pr-state] { --oc-pr-gui-tone: ${PALETTE.neutral}; }")
    expect(PR_STYLE.trimStart().startsWith(toneLines[0].replace(/\$\{PALETTE\.neutral\}/, PALETTE.neutral))).toBe(true)
  })
})
