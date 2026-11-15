// createPr's user-facing strings, pinned structurally.
//
// `createPr` spawns `gh` and returns its message directly; there is no template
// seam (the wording lives inline in the switch over `classifyCreateError`), so
// these assertions are source-level, the same style as split.test.ts. Each
// changed branch is pinned twice: the new sentence must be present, and the old
// sentence carrying the false "No command was run." suffix must be gone. The
// suffix is still true for the pre-execution refusals (`checkRef`, the merge
// no-confirm literal), so those are pinned in place to keep this test honest
// about the difference.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")

const git = read("git.ts")

// The backend only: from `export async function createPr` to the next export.
function createPrRegion(source: string): string {
  const start = source.indexOf("export async function createPr(")
  const end = source.indexOf("\nexport ", start + 1)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

const create = createPrRegion(git)
const SUFFIX = "No command was run."

describe("createPr messages — post-execution branches do not claim nothing ran", () => {
  test("the view timeout keeps its detail and drops the false suffix", () => {
    expect(create).toContain(
      `"Create PR failed: timed out while checking for an existing PR."`,
    )
    expect(create).not.toContain(
      `"Create PR failed: timed out while checking for an existing PR. ${SUFFIX}"`,
    )
  })

  test("not-pushed states the true outcome without the suffix", () => {
    expect(create).toContain(
      `"Create PR refused: the branch is not on origin yet — push it first."`,
    )
    expect(create).not.toContain(`not on origin yet — push it first. ${SUFFIX}`)
  })

  test("no-commits keeps the refusal reason, drops the suffix", () => {
    expect(create).toContain(
      `"Create PR refused: there are no commits between the base branch and this branch."`,
    )
    expect(create).not.toContain(
      `there are no commits between the base branch and this branch. ${SUFFIX}`,
    )
  })

  test("the exists race states the PR already exists, drops the suffix", () => {
    expect(create).toContain(`"Create PR refused: this branch already has a pull request."`)
    expect(create).not.toContain(`this branch already has a pull request. ${SUFFIX}`)
  })

  test("control: no createPr post-execution branch ends in the suffix", () => {
    // The four messages above are the only createPr returns after a spawn. The
    // pre-execution refusals keep the suffix, so this must not be read as "the
    // suffix never appears in createPr" — it appears in `checkRef`, which is
    // outside this region.
    expect(create).not.toContain(`failed: timed out while checking for an existing PR. ${SUFFIX}`)
    expect(create).not.toContain(`the branch is not on origin yet — push it first. ${SUFFIX}`)
  })
})

describe("createPr messages — the suffix stays where it is true", () => {
  test("checkRef refusals still say no command was run", () => {
    expect(git).toContain(`must not be empty. ${SUFFIX}`)
    expect(git).toMatch(/must not start with "-" \(got .+\)\. No command was run\./)
    expect(git).toMatch(/may only contain A-Za-z0-9\._\/- \(got .+\)\. No command was run\./)
  })

  test("the merge no-confirm literal still says no command was run", () => {
    expect(git).toContain(`'oc-pr-gui refused: no explicit confirmation. ${SUFFIX}'`)
  })
})
