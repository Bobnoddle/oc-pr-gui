// Integration coverage for the reaper's delete half: a REAL git repository,
// REAL `git update-ref -d <ref> <old-oid>` compare-and-swap, no network.
//
// reaper.test.ts already pins the decision table (`reapVerdict`) and the argv
// strings as data. What it cannot pin is that the CAS actually refuses a ref
// that moved under us, and that the branch the pass logs as deleted is really
// gone while every other ref survives. So every test below builds a throwaway
// repository under the OS temp dir, runs `reapBranches` against it, and reads
// the refs back with git itself.
//
// The one network seam is `gh pr list` (and, when origin/HEAD is unreadable,
// `gh repo view`). It is stubbed with a local shell script named `gh` placed
// first on PATH. `run` in git.ts spawns with `env: process.env`, so the child
// resolves our script and never reaches the real CLI. Every `git` invocation
// stays real: no src edit, no module monkey-patching. Because the stub is an
// executable, the "moved under us" case can be produced deterministically: the
// stub moves the ref while answering the PR list, which is exactly the
// concurrent-writer window the CAS exists to survive.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reapBranches } from "../git"
import type { ReapedBranch, ReapSkip } from "../pure"

type ReapReply = { reaped: ReapedBranch[]; skipped: ReapSkip[]; truncated: boolean; error?: string }

type Repo = {
  root: string
  dir: string
  // Directory holding the stub `gh`; prepended to PATH by `useRepo`.
  bin: string
  // XDG_DATA_HOME holding the reaper's opt-in file for this repository.
  data: string
  git: (...args: string[]) => string
  oid: (ref: string) => string
}

const roots: string[] = []
const originalPath = process.env.PATH
const originalXdg = process.env.XDG_DATA_HOME
const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL
const originalGitConfigSystem = process.env.GIT_CONFIG_SYSTEM
const originalGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name]
  else process.env[name] = original
}

// Git reads these straight from the environment and they outrank the config
// files below: a `GIT_DIR` would move the fixture's repository out from under
// it, and `GIT_TEMPLATE_DIR` would seed a hook that later runs in it. Capture
// and remove them before any git runs, then put them back in `afterEach`.
// Both spawn sites pass `env: process.env` (the `git` helper and the restore
// command's `sh -c`), so both see the scrubbed state.
const HOSTILE_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_TEMPLATE_DIR",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
] as const

// `GIT_CONFIG_COUNT=n` exposes `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` pairs:
// config injected through the environment, which can re-set core.hooksPath past
// the empty config files. Scan a sane bound rather than pre-listing the names.
const ENV_CONFIG_SLOTS = 16

// name -> the value it had before the first scrub (undefined = it was absent).
const savedGitEnv = new Map<string, string | undefined>()

function scrubGitEnv(): void {
  const names: string[] = [...HOSTILE_GIT_ENV]
  for (let i = 0; i < ENV_CONFIG_SLOTS; i++) {
    names.push(`GIT_CONFIG_KEY_${i}`, `GIT_CONFIG_VALUE_${i}`)
  }
  for (const name of names) {
    if (!savedGitEnv.has(name)) savedGitEnv.set(name, process.env[name])
    delete process.env[name]
  }
}

// `run` in git.ts spawns with `env: process.env`, so every git this fixture
// drives would otherwise inherit the machine's global and system config plus
// any stray GIT_* override: core.hooksPath, init.templateDir, core.excludesFile.
// Point both config scopes at empty files in the fixture root so only the local
// `user.*`/signing settings below apply.
function isolateGitConfig(root: string): void {
  const config = join(root, "config")
  mkdirSync(config)
  const globalConfig = join(config, "global.gitconfig")
  const systemConfig = join(config, "system.gitconfig")
  writeFileSync(globalConfig, "")
  writeFileSync(systemConfig, "")
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.GIT_CONFIG_SYSTEM = systemConfig
  process.env.GIT_CONFIG_NOSYSTEM = "1"
}

// One repo per test: mkdtemp under the OS temp dir, never the checkout under
// test and never a config directory. Cleanup is unconditional.
function makeRepo(label: string): Repo {
  const base = realpathSync(tmpdir())
  const root = realpathSync(mkdtempSync(join(base, `oc-pr-gui-${label}-`)))
  roots.push(root)
  if (!root.startsWith(`${base}/`) || !root.includes("oc-pr-gui-")) {
    throw new Error(`fixture refused a non-temp root: ${root}`)
  }
  const dir = join(root, "repo")
  mkdirSync(dir)
  // Before any git runs: suppress inherited config and environment overrides so
  // the fixture is hermetic.
  isolateGitConfig(root)
  scrubGitEnv()
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Explicit env, like `run` in git.ts: Bun's implicit child environment does
      // not pick up `process.env` writes made after startup, so the isolation
      // below would not reach git otherwise.
      env: process.env,
    }).trim()
  // Local identity and no signing: commits must work with no global config.
  git("init", "-b", "main")
  git("config", "user.email", "reaper@example.invalid")
  git("config", "user.name", "Reaper Test")
  git("config", "commit.gpgsign", "false")
  for (const file of ["one.txt", "two.txt"]) {
    writeFileSync(join(dir, file), `${file}\n`)
    git("add", file)
    git("commit", "-m", file)
  }
  // The reaper only parses this URL (repoFromRemote) to name the repository for
  // `gh pr list`. Nothing in these tests fetches or pushes it.
  git("remote", "add", "origin", "https://github.com/acme/demo.git")
  // origin/HEAD readable locally: the default branch comes from tier one, so no
  // `gh repo view` call is made and the pass has its protected name.
  git("update-ref", "refs/remotes/origin/main", "HEAD")
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")

  const bin = join(root, "bin")
  mkdirSync(bin)
  const data = join(root, "data")
  mkdirSync(join(data, "opencode"), { recursive: true })
  writeFileSync(join(data, "opencode", "oc-pr-gui-reaper.json"), JSON.stringify({ [dir]: true }))
  return { root, dir, bin, data, git, oid: (ref) => git("rev-parse", ref) }
}

// A side branch with one commit of its own, left un-checked-out. Returns its tip.
function sideBranch(r: Repo, name: string, from = "main"): string {
  r.git("switch", "-c", name, from)
  const file = `${name.replace(/\//g, "-")}.txt`
  writeFileSync(join(r.dir, file), `${name}\n`)
  r.git("add", file)
  r.git("commit", "-m", name)
  const tip = r.oid(`refs/heads/${name}`)
  r.git("switch", from)
  return tip
}

// The stub `gh`: answers the one merged-PR listing a pass makes. `move` makes it
// rewrite a branch first — a concurrent writer landing between the pass's
// `for-each-ref` read and its CAS.
function fakeGh(
  r: Repo,
  merged: Array<{ number: number; headRefName: string; headRefOid: string }>,
  move?: { branch: string; oid: string },
): void {
  const side = move === undefined ? "" : `    git -C '${r.dir}' update-ref 'refs/heads/${move.branch}' ${move.oid}\n`
  const script = `#!/bin/sh
case "$1 $2" in
  "pr list")
${side}    printf '%s\\n' '${JSON.stringify(merged)}'
    ;;
  "repo view")
    printf '%s\\n' '{"defaultBranchRef":{"name":"main"}}'
    ;;
  *)
    echo "fake gh: unsupported arguments: $*" >&2
    exit 1
    ;;
esac
`
  writeFileSync(join(r.bin, "gh"), script, { mode: 0o755 })
}

function useRepo(r: Repo): void {
  process.env.PATH = `${r.bin}:${originalPath ?? ""}`
  process.env.XDG_DATA_HOME = r.data
}

async function reap(r: Repo): Promise<ReapReply> {
  useRepo(r)
  return JSON.parse(await reapBranches(r.dir)) as ReapReply
}

function hasRef(r: Repo, ref: string): boolean {
  try {
    r.git("rev-parse", "--verify", "--quiet", ref)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  restoreEnv("PATH", originalPath)
  restoreEnv("XDG_DATA_HOME", originalXdg)
  restoreEnv("GIT_CONFIG_GLOBAL", originalGitConfigGlobal)
  restoreEnv("GIT_CONFIG_SYSTEM", originalGitConfigSystem)
  restoreEnv("GIT_CONFIG_NOSYSTEM", originalGitConfigNoSystem)
  // Every hostile GIT_* var the fixture removed: original value back if it had
  // one, absent again if it did not.
  for (const [name, original] of savedGitEnv) restoreEnv(name, original)
  savedGitEnv.clear()
})

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("reapBranches — the CAS delete runs against real git", () => {
  test("a merged branch at its verified tip is deleted; other refs and HEAD survive", async () => {
    const r = makeRepo("delete")
    const done = sideBranch(r, "feat/done")
    const keep = sideBranch(r, "feat/keep")
    const mainTip = r.oid("refs/heads/main")
    fakeGh(r, [
      { number: 11, headRefName: "feat/done", headRefOid: done },
      // Same branch name, different commit: the local tip is not what GitHub
      // merged, so nothing about it may be touched.
      { number: 12, headRefName: "feat/keep", headRefOid: "0".repeat(40) },
    ])

    const out = await reap(r)

    expect(out.reaped).toEqual([
      { branch: "feat/done", number: 11, oid: done, restore: `git branch 'feat/done' ${done}` },
    ])
    expect(out.error).toBeUndefined()
    expect(out.truncated).toBe(false)
    expect(hasRef(r, "refs/heads/feat/done")).toBe(false)
    expect(r.oid("refs/heads/feat/keep")).toBe(keep)
    expect(r.oid("refs/heads/main")).toBe(mainTip)
    expect(r.git("branch", "--show-current")).toBe("main")
    expect(r.git("status", "--porcelain")).toBe("")
  })

  test("the logged restore command recreates the deleted branch at the verified OID", async () => {
    const r = makeRepo("restore")
    const done = sideBranch(r, "feat/done")
    fakeGh(r, [{ number: 21, headRefName: "feat/done", headRefOid: done }])

    const out = await reap(r)

    // src/pure.ts's logged form: shellQuote'd branch name, bare OID.
    const restore = out.reaped[0]?.restore
    expect(restore).toBe(`git branch 'feat/done' ${done}`)
    expect(hasRef(r, "refs/heads/feat/done")).toBe(false)

    // Executed for real in the same repository: the undo the log promises.
    execFileSync("sh", ["-c", restore as string], { cwd: r.dir, encoding: "utf8", env: process.env })
    expect(r.oid("refs/heads/feat/done")).toBe(done)
  })

  test("the default branch from origin/HEAD is skipped, never deleted", async () => {
    const r = makeRepo("protected")
    const production = sideBranch(r, "production")
    r.git("update-ref", "refs/remotes/origin/production", production)
    r.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/production")
    fakeGh(r, [
      { number: 31, headRefName: "production", headRefOid: production },
      { number: 32, headRefName: "main", headRefOid: r.oid("refs/heads/main") },
    ])

    const out = await reap(r)

    expect(out.reaped).toEqual([])
    expect(out.skipped).toContainEqual({ branch: "production", reason: "protected" })
    expect(r.oid("refs/heads/production")).toBe(production)
    expect(hasRef(r, "refs/heads/main")).toBe(true)
  })

  test("the checked-out branch is skipped even when its merged PR matches", async () => {
    const r = makeRepo("current")
    const current = sideBranch(r, "feat/current")
    r.git("switch", "feat/current")
    fakeGh(r, [{ number: 41, headRefName: "feat/current", headRefOid: current }])

    const out = await reap(r)

    expect(out.reaped).toEqual([])
    expect(out.skipped).toContainEqual({ branch: "feat/current", reason: "current" })
    expect(r.oid("refs/heads/feat/current")).toBe(current)
    expect(r.git("branch", "--show-current")).toBe("feat/current")
  })

  test("a branch held by another worktree is skipped", async () => {
    const r = makeRepo("held")
    const held = sideBranch(r, "feat/held")
    const worktree = join(r.root, "second-worktree")
    r.git("worktree", "add", worktree, "feat/held")
    fakeGh(r, [{ number: 51, headRefName: "feat/held", headRefOid: held }])

    const out = await reap(r)

    expect(out.reaped).toEqual([])
    expect(out.skipped).toContainEqual({ branch: "feat/held", reason: "held" })
    expect(r.oid("refs/heads/feat/held")).toBe(held)
    // The worktree is still attached: the pass never removes one.
    expect(r.git("worktree", "list", "--porcelain")).toContain(worktree)
  })

  test("a ref that moves after verification is refused, and the new tip survives", async () => {
    const r = makeRepo("moved")
    const verified = sideBranch(r, "feat/moved")
    const moved = sideBranch(r, "feat/other")
    // `gh pr list` answers with the commit the pass verified, then a concurrent
    // writer rewrites the branch before the CAS runs.
    fakeGh(r, [{ number: 61, headRefName: "feat/moved", headRefOid: verified }], {
      branch: "feat/moved",
      oid: moved,
    })

    const out = await reap(r)

    expect(out.reaped).toEqual([])
    expect(out.skipped).toContainEqual({ branch: "feat/moved", reason: "moved" })
    expect(out.error).toContain("feat/moved")
    expect(out.error).toContain("moved after verification")
    // Refusal is a no-op: the ref is still there, at the value it moved to.
    expect(r.oid("refs/heads/feat/moved")).toBe(moved)
    expect(r.oid("refs/heads/feat/other")).toBe(moved)
  })
})
