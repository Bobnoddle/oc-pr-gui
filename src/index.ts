import { Plugin } from "@opencode/plugin"
import { statSync } from "node:fs"
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
// `npm run build:gui`.

const GUI_SOURCES = ["gui.tsx", "git.ts", "contract.ts", "i18n.ts", "style.ts"] as const
const GUI_BUNDLE = join("dist", "gui-experimental.cjs")

function packageRoot(): string {
  // Bun provides `import.meta.dir`; Node (20.11+) provides `import.meta.dirname`.
  // Both point at this file's `src` directory.
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
    return `oc-pr-gui: ${bundle} is missing, so the PR panel cannot load. Run \`npm run build:gui\` in ${root}.`
  }

  const newer = GUI_SOURCES.filter((file) => {
    const sourceTime = mtime(join(root, "src", file))
    return sourceTime !== undefined && sourceTime > bundleTime
  })
  if (newer.length === 0) return undefined

  return (
    `oc-pr-gui: GUI source ${newer.join(", ")} is newer than ${GUI_BUNDLE}, ` +
    `so the desktop panel is showing a stale bundle. Run \`npm run build:gui\` in ${root}.`
  )
}

export default Plugin.define({
  id: "oc-pr-gui",
  async setup() {
    const warning = staleBundleWarning()
    if (warning !== undefined) console.warn(warning)
  },
})
