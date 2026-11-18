import { Plugin } from "@opencode/plugin"
import { statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

// No-op server part.
//
// The v2.2.5 plugin loader does not recognise a package whose exports contain
// only `./gui-experimental` (it makes `opencode plugin list` return nothing), so
// this package also exports a `.` server entry. It registers no tools and no
// hooks: the user-visible part is the GUI bundle.
//
// The one thing it does do is warn when the GUI bundle is older than its
// sources. That mismatch is the main cause of "it worked once": the desktop app
// loads `dist/gui-experimental.cjs`, which is only refreshed by an explicit
// `bun run build`.

const GUI_SOURCES = ["gui.tsx", "git.ts", "contract.ts", "i18n.ts", "style.ts"] as const
const GUI_BUNDLE = join("dist", "gui-experimental.cjs")
const BUNDLED_SKILL_PATH = join("skills", "pr-review", "SKILL.md")

function packageRoot(): string {
  // Bun's `import.meta.dir` / Node's `import.meta.dirname` point at this file's
  // `src` directory; the `dirname` step below moves up to the package root.
  const meta = import.meta as ImportMeta & { dir?: string; dirname?: string }
  return dirname(meta.dir ?? meta.dirname ?? ".")
}

function mtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

function staleBundleWarning(root = packageRoot()): string | undefined {
  const bundle = join(root, GUI_BUNDLE)
  const bundleTime = mtime(bundle)
  if (bundleTime === undefined) {
    return `oc-pr-gui: ${bundle} is missing, so the PR panel cannot load. Run \`bun run build\` in ${root}.`
  }

  const newer = GUI_SOURCES.filter((file) => {
    const sourceTime = mtime(join(root, "src", file))
    return sourceTime !== undefined && sourceTime > bundleTime
  })
  if (newer.length === 0) return undefined

  return (
    `oc-pr-gui: GUI source ${newer.join(", ")} is newer than ${GUI_BUNDLE}, ` +
    `so the desktop panel is showing a stale bundle. Run \`bun run build\` in ${root}.`
  )
}

// Pull the skill's identity out of its YAML frontmatter so the registered name
// and description stay in sync with the vendored SKILL.md. Only `name` and the
// folded `description: >-` block are needed here.
function skillFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return {}
  const lines = match[1].split(/\r?\n/)
  const result: { name?: string; description?: string } = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith("name:")) {
      result.name = line.slice("name:".length).trim()
    } else if (line.startsWith("description:")) {
      const rest = line.slice("description:".length).trim()
      if (rest === ">-" || rest === ">" || rest === "|-" || rest === "|") {
        const block: string[] = []
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j]
          if (next.trim() === "" || /^\s/.test(next)) block.push(next.trim())
          else break
        }
        result.description = block.filter(Boolean).join(" ")
      } else {
        result.description = rest
      }
    }
  }
  return result
}

export default Plugin.define({
  id: "oc-pr-gui",
  async setup(ctx) {
    const warning = staleBundleWarning()
    if (warning !== undefined) console.warn(warning)

    const skillPath = join(packageRoot(), BUNDLED_SKILL_PATH)
    let content: string | undefined
    try {
      content = await readFile(skillPath, "utf8")
    } catch {
      console.warn(
        `oc-pr-gui: bundled skill ${skillPath} is missing or unreadable, so pr-review was not registered.`,
      )
    }

    if (content !== undefined) {
      const frontmatter = skillFrontmatter(content)
      try {
        await ctx.skill.transform((editor) => {
          // A user's own copy (global or project) stays authoritative.
          if (editor.get("pr-review")) return
          const skill = {
            id: "pr-review",
            name: frontmatter.name ?? "pr-review",
            description: frontmatter.description ?? "",
            path: skillPath,
            content,
          } as Parameters<typeof editor.add>[0]
          editor.add(skill)
        })
      } catch {
        console.warn(
          `oc-pr-gui: could not register the bundled pr-review skill; continuing without it.`,
        )
      }
    }

    // Soft dependencies: the queued Review/Resolve handoffs recommend the
    // `advisor` and `pr-writer` subagents, but the panel works without them.
    // Listing agents is advisory only — never fail setup over it.
    try {
      const agents = await ctx.agent.list()
      const ids = new Set(agents.data.map((agent) => agent.id))
      const missing = ["advisor", "pr-writer"].filter((id) => !ids.has(id))
      if (missing.length > 0) {
        console.warn(
          `oc-pr-gui: the ${missing.join(" and ")} subagent${missing.length > 1 ? "s are" : " is"} not installed; recommended for the Review/Resolve handoffs — see README Requirements.`,
        )
      }
    } catch {
      // Agent listing unavailable: advisory only, never fail setup.
    }
  },
})
