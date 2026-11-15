// Pins the decision layer that gui.tsx renders: facts -> banner tone, chip
// stage and primary tone. The banner and the chip deliberately keep two
// different orders (conflicts above failing vs failing above conflicts), so the
// tests assert both and assert that they disagree on the same facts.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import {
  chipStage,
  facts,
  hasReviewWork,
  prTone,
  stateTone,
  toneWordKey,
  type PrFacts,
} from "../pure"

const ok = (state: string) => ({ name: state, state })
const green = [ok("SUCCESS")]
const failing = [ok("FAILURE")]
const pending = [ok("QUEUED")]
const unknown = [ok("SUCCESS"), ok("MYSTERY")]

const mk = (partial: Parameters<typeof facts>[0]): PrFacts => facts(partial)

describe("facts", () => {
  test("upper-cases the state and reads the check summary once", () => {
    expect(mk({ state: "open", checks: [ok("FAILURE"), ok("ERROR"), ok("SUCCESS")] })).toEqual({
      state: "OPEN",
      conflicts: false,
      failing: true,
      pending: 0,
      unknown: false,
      reviewWork: false,
    })
  })

  test("conflicts accept both gh spellings", () => {
    expect(mk({ mergeable: "CONFLICTING" }).conflicts).toBe(true)
    expect(mk({ mergeStateStatus: "dirty" }).conflicts).toBe(true)
    expect(mk({ mergeStateStatus: "CONFLICTING" }).conflicts).toBe(true)
    expect(mk({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }).conflicts).toBe(false)
  })

  test("only a positive unresolved count is review work", () => {
    expect(mk({ reviewThreads: { unresolved: 2 } }).reviewWork).toBe(true)
    expect(mk({ reviewThreads: { unresolved: 1 } }).reviewWork).toBe(true)
    expect(mk({ reviewThreads: { unresolved: 0 } }).reviewWork).toBe(false)
    expect(mk({ reviewThreads: null }).reviewWork).toBe(false)
    expect(mk({}).reviewWork).toBe(false)
    // Negative can only come from a broken producer; it is not review work.
    expect(mk({ reviewThreads: { unresolved: -1 } }).reviewWork).toBe(false)
  })

  test("hasReviewWork is the single predicate behind that fact", () => {
    expect(hasReviewWork({ unresolved: 3 })).toBe(true)
    expect(hasReviewWork({ unresolved: 0 })).toBe(false)
    expect(hasReviewWork({})).toBe(false)
    expect(hasReviewWork(null)).toBe(false)
    expect(hasReviewWork(undefined)).toBe(false)
  })

  test("an empty record is all-empty facts, not a failure", () => {
    expect(mk({})).toEqual({
      state: "",
      conflicts: false,
      failing: false,
      pending: 0,
      unknown: false,
      reviewWork: false,
    })
  })
})

// One fixture per chip stage. Each row pins the stage, the banner tone, the
// state-word KEY the titlebar shows and the primary tone for a merge action.
const stages = [
  {
    name: "failing",
    input: { state: "OPEN", checks: failing },
    stage: "failing",
    kind: "failing",
    tone: "failing",
    key: "panel.stateFailing",
    primary: "redSoft",
  },
  {
    name: "conflicts",
    input: { state: "OPEN", checks: green, mergeable: "CONFLICTING" },
    stage: "conflicts",
    kind: "conflicts",
    tone: "conflicts",
    key: "panel.stateConflicts",
    primary: "red",
  },
  {
    name: "pending",
    input: { state: "OPEN", checks: pending },
    stage: "pending",
    kind: "merge",
    tone: "pending",
    key: "panel.statePending",
    primary: "amber",
  },
  {
    name: "unknown",
    input: { state: "OPEN", checks: unknown },
    stage: "unknown",
    kind: "merge",
    tone: "unknown",
    key: "panel.stateUnknown",
    primary: "neutral",
  },
  {
    name: "open",
    input: { state: "OPEN", checks: green },
    stage: "open",
    kind: "merge",
    tone: "green",
    key: "panel.stateOpen",
    primary: "green",
  },
] as const

describe("chip stages", () => {
  for (const row of stages) {
    test(`${row.name}: stage, banner word and primary tone agree`, () => {
      const f = mk(row.input as Parameters<typeof facts>[0])
      expect(chipStage(f)).toBe(row.stage)
      expect(prTone(f)).toBe(row.tone)
      expect(toneWordKey(prTone(f))).toBe(row.key)
      expect(stateTone(row.kind, f)).toBe(row.primary)
    })
  }

  test("review has a chip stage and banner word but no primary of its own", () => {
    const f = mk({ state: "OPEN", checks: green, reviewThreads: { unresolved: 3 } })
    expect(chipStage(f)).toBe("review")
    expect(prTone(f)).toBe("review")
    expect(toneWordKey(prTone(f))).toBe("panel.stateReviewItems")
    // gui.tsx renders the tone-filled primary inside `<Show when={!resolveActive()}>`,
    // and the resolve overlay owns redSoft, so review work never reaches
    // stateTone: the merge arm's deleted `review` branch falls through to green.
    expect(stateTone("merge", f)).toBe("green")
  })
})

describe("deliberately different precedences (banner vs chip)", () => {
  test("conflicts + failing: banner says conflicts, chip says failing", () => {
    const f = mk({ state: "OPEN", mergeable: "CONFLICTING", checks: failing })
    expect(prTone(f)).toBe("conflicts")
    expect(chipStage(f)).toBe("failing")
  })

  test("review + failing: banner says failing, chip says review", () => {
    const f = mk({ state: "OPEN", checks: failing, reviewThreads: { unresolved: 1 } })
    expect(prTone(f)).toBe("failing")
    expect(chipStage(f)).toBe("review")
  })

  test("review + conflicts + pending: banner says conflicts, chip says review", () => {
    const f = mk({
      state: "OPEN",
      mergeable: "CONFLICTING",
      checks: pending,
      reviewThreads: { unresolved: 1 },
    })
    expect(prTone(f)).toBe("conflicts")
    expect(chipStage(f)).toBe("review")
  })

  test("orders that agree: pending beats unknown in both", () => {
    const f = mk({ state: "OPEN", checks: [ok("QUEUED"), ok("MYSTERY")] })
    expect(prTone(f)).toBe("pending")
    expect(chipStage(f)).toBe("pending")
  })

  test("failing beats pending in both", () => {
    const f = mk({ state: "OPEN", checks: [ok("QUEUED"), ok("FAILURE")] })
    expect(prTone(f)).toBe("failing")
    expect(chipStage(f)).toBe("failing")
  })

  test("failing beats conflicts in the chip, conflicts beats failing in the banner", () => {
    // Restates the inversion with a merged/closed state so the terminal states
    // are shown to short-circuit the banner but not the chip's fact order.
    const f = mk({ state: "MERGED", mergeable: "CONFLICTING", checks: failing })
    expect(prTone(f)).toBe("merged")
    expect(chipStage(f)).toBe("failing")
  })
})

describe("prTone ordering and terminal states", () => {
  test("merged outranks everything, including conflicts and failing", () => {
    expect(prTone(mk({ state: "merged", mergeable: "DIRTY", checks: failing }))).toBe("merged")
  })

  test("closed outranks conflicts", () => {
    expect(prTone(mk({ state: "CLOSED", mergeable: "CONFLICTING" }))).toBe("closed")
  })

  test("review sits below failing but above pending", () => {
    expect(prTone(mk({ state: "OPEN", checks: pending, reviewThreads: { unresolved: 1 } }))).toBe("review")
  })

  test("zero or unknown threads never promote", () => {
    expect(prTone(mk({ state: "OPEN", checks: green, reviewThreads: { unresolved: 0 } }))).toBe("green")
    expect(prTone(mk({ state: "OPEN", checks: green, reviewThreads: null }))).toBe("green")
  })

  test("empty facts fall through to green (no PR row never calls prTone)", () => {
    expect(prTone(mk({}))).toBe("green")
    expect(chipStage(mk({}))).toBe("open")
  })

  test("no checks at all is green, while an unrecognized check state is unknown", () => {
    expect(prTone(mk({ state: "OPEN", checks: [] }))).toBe("green")
    expect(prTone(mk({ state: "OPEN", checks: [ok("MYSTERY")] }))).toBe("unknown")
  })
})

describe("stateTone matrix", () => {
  const simple = [
    ["detached", "neutral"],
    ["merged", "purple"],
    ["failing", "redSoft"],
    ["conflicts", "red"],
    ["dirty", "blue"],
    ["push", "blue"],
    ["create", "blue"],
    ["error", "neutral"],
  ] as const

  test("every non-merge action kind maps to one palette tone", () => {
    const f = mk({ state: "OPEN", checks: green })
    for (const [kind, tone] of simple) expect(stateTone(kind, f)).toBe(tone)
  })

  test("the merge arm follows the chip stage", () => {
    expect(stateTone("merge", mk({ state: "OPEN", checks: pending }))).toBe("amber")
    expect(stateTone("merge", mk({ state: "OPEN", checks: unknown }))).toBe("neutral")
    expect(stateTone("merge", mk({ state: "OPEN", checks: green }))).toBe("green")
  })

  test("documented unreachable merge arms still map deterministically", () => {
    // actionKind() never returns "merge" with failing checks or conflicts, so
    // these rows are defensive: they must not crash or invent a tone.
    expect(stateTone("merge", mk({ state: "OPEN", checks: failing }))).toBe("green")
    expect(stateTone("merge", mk({ state: "OPEN", mergeable: "CONFLICTING" }))).toBe("green")
  })

  test("no action yields the hexless primary", () => {
    expect(stateTone(undefined, mk({}))).toBe("none")
  })
})

describe("toneWordKey", () => {
  test("every tone maps to its established i18n key", () => {
    const keys = {
      create: "panel.stateCreate",
      pending: "panel.statePending",
      green: "panel.stateOpen",
      failing: "panel.stateFailing",
      review: "panel.stateReviewItems",
      conflicts: "panel.stateConflicts",
      unknown: "panel.stateUnknown",
      merged: "panel.stateMerged",
      closed: "panel.stateClosed",
      error: "panel.stateError",
    } as const
    for (const [tone, key] of Object.entries(keys)) {
      expect(toneWordKey(tone as keyof typeof keys)).toBe(key)
    }
  })

  test("all ten keys are distinct", () => {
    const tones = [
      "create",
      "pending",
      "green",
      "failing",
      "review",
      "conflicts",
      "unknown",
      "merged",
      "closed",
      "error",
    ] as const
    expect(new Set(tones.map(toneWordKey)).size).toBe(10)
  })
})
