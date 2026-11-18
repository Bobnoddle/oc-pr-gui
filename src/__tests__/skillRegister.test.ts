// Registration of the vendored pr-review skill: the frontmatter parser and the
// register-if-absent guard. `src/index.ts` imports @opencode/plugin and defines
// the plugin at module load, but the two exported helpers are pure and take a
// structural editor, so they can be exercised here with a fake — no host, no
// shell. The guard is the user-copy-wins rule: a global or project copy stays
// authoritative and the bundled one is never added over it.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { registerBundledSkill, skillFrontmatter, type SkillEditorLike } from "../index"

type Added = Parameters<SkillEditorLike["add"]>[0]

function fakeEditor(hit: unknown = undefined) {
  const added: Added[] = []
  const gets: string[] = []
  const editor: SkillEditorLike = {
    get: (id) => {
      gets.push(id)
      return hit
    },
    add: (skill) => {
      added.push(skill)
    },
  }
  return { editor, added, gets }
}

const FOLDED = [
  "---",
  "name: pr-review",
  "description: >-",
  "  Review a pull request, deliver one verdict, and post the findings to GitHub as",
  "  a comment review. Also runs the resolution flow for open review threads once",
  "  the user approves the plan.",
  "---",
  "",
  "# PR Review",
].join("\n")

describe("skillFrontmatter", () => {
  test("a folded description becomes one space-joined string", () => {
    expect(skillFrontmatter(FOLDED)).toEqual({
      name: "pr-review",
      description:
        "Review a pull request, deliver one verdict, and post the findings to GitHub as a comment review. Also runs the resolution flow for open review threads once the user approves the plan.",
    })
  })

  test("extracts name and inline (non-folded) descriptions", () => {
    expect(skillFrontmatter("---\nname: my-skill\ndescription: A plain description\n---\n")).toEqual({
      name: "my-skill",
      description: "A plain description",
    })
    // The parser keeps the raw scalar for a quoted inline description (quotes
    // included) — it only folds block scalars, it does not unquote.
    expect(skillFrontmatter('---\nname: my-skill\ndescription: "A quoted description"\n---\n')).toEqual({
      name: "my-skill",
      description: '"A quoted description"',
    })
  })

  test("no frontmatter yields an empty object", () => {
    expect(skillFrontmatter("# Just a heading\n\nSome body text.\n")).toEqual({})
  })
})

describe("registerBundledSkill", () => {
  const PATH = "/pkg/skills/pr-review/SKILL.md"

  test("a get hit means add is never called", () => {
    const { editor, added, gets } = fakeEditor({ id: "pr-review", name: "user copy" })
    registerBundledSkill(editor, FOLDED, PATH)
    expect(gets).toEqual(["pr-review"])
    expect(added).toHaveLength(0)
  })

  test("a miss adds once with frontmatter name and description, path and content", () => {
    const { editor, added } = fakeEditor()
    registerBundledSkill(editor, FOLDED, PATH)
    expect(added).toHaveLength(1)
    expect(added[0]).toEqual({
      id: "pr-review",
      name: "pr-review",
      description:
        "Review a pull request, deliver one verdict, and post the findings to GitHub as a comment review. Also runs the resolution flow for open review threads once the user approves the plan.",
      path: PATH,
      content: FOLDED,
    })
  })

  test("no frontmatter still adds with fallback name and empty description", () => {
    const content = "# Just a heading\n\nSome body text.\n"
    const { editor, added } = fakeEditor()
    registerBundledSkill(editor, content, PATH)
    expect(added).toHaveLength(1)
    expect(added[0]).toEqual({
      id: "pr-review",
      name: "pr-review",
      description: "",
      path: PATH,
      content,
    })
  })

  test("frontmatter with no name line falls back to pr-review", () => {
    const content = "---\ndescription: Only a description\n---\n"
    const { editor, added } = fakeEditor()
    registerBundledSkill(editor, content, PATH)
    expect(added).toHaveLength(1)
    expect(added[0].name).toBe("pr-review")
    expect(added[0].description).toBe("Only a description")
  })
})
