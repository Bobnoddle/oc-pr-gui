// The default-branch read behind the on-base option swaps (`readDivergence`'s
// `base`) and `createPr`'s head == base pre-flight: a REAL git repository, a
// stubbed `gh`, no network.
//
// The regression this pins: `defaultBaseBranch` used to strip only
// `^refs/remotes/`, so `git symbolic-ref refs/remotes/origin/HEAD` reported
// `origin/main` instead of `main`. Every consumer compares that string to
// `git branch --show-current`, so an `origin/` prefix silently disabled the
// whole feature. The assertions below name the bare branch and refuse any `/`.
//
// Network seam: `gh` is a shell script in a temp `bin/` prepended to PATH, the
// same pattern as reapCas.test.ts — `run` in git.ts spawns with `env:
// process.env`. Every test installs a stub BEFORE the first call, so no code
// path here can resolve the real CLI:
//   - readDivergence (symbolic-ref / repo-view / failing-gh tests): stub writes
//     a log line, so an unexpected invocation is both harmless and visible.
//   - createPr (pre-flight + off-base): the stub answers `pr view`/`pr create`.
// Every `git` call is real; nothing is monkey-patched.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPr, continueWork, readDivergence } from "../git"
import { continueStamp } from "../pure"

type Repo = {
  root: string
  dir: string
  // Directory holding the stub `gh`; prepended to PATH by `useRepo`.
  bin: string
  git: (...args: string[]) => string
}

type GhStub = {
  // `gh repo view --json defaultBranchRef` answer. Omitted = exit 1 (no gh).
  defaultBranch?: string
  // `gh pr view` reports an existing PR (exit 0) instead of failing.
  existingPr?: boolean
  // `gh pr create` succeeds and prints this URL.
  createUrl?: string
}

const roots: string[] = []
const originalPath = process.env.PATH
const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL
const originalGitConfigSystem = process.env.GIT_CONFIG_SYSTEM
const originalGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name]
  else process.env[name] = original
}

// Same hygiene as reapCas.test.ts: these outrank the config files below and a
// stray value would move the fixture repository out from under it.
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

const ENV_CONFIG_SLOTS = 16

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

// One repo per test under the OS temp dir, with two commits on `main` and an
// origin remote. `originHead` optionally sets refs/remotes/origin/HEAD — the
// tier-one read; without it the fixture exercises the gh fallback.
// `options.remote` replaces the unreachable URL with a REAL local bare
// repository carrying `branch`: the flows that run `git fetch origin --prune`
// (continueWork) need an origin that works with no network.
type RepoOptions = { remote?: { branch: string } }

function makeRepo(label: string, originHead: boolean, options: RepoOptions = {}): Repo {
  const base = realpathSync(tmpdir())
  const root = realpathSync(mkdtempSync(join(base, `oc-pr-gui-base-${label}-`)))
  roots.push(root)
  if (!root.startsWith(`${base}/`) || !root.includes("oc-pr-gui-base-")) {
    throw new Error(`fixture refused a non-temp root: ${root}`)
  }
  const dir = join(root, "repo")
  mkdirSync(dir)
  isolateGitConfig(root)
  scrubGitEnv()
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    }).trim()
  git("init", "-b", "main")
  git("config", "user.email", "base@example.invalid")
  git("config", "user.name", "Base Test")
  git("config", "commit.gpgsign", "false")
  for (const file of ["one.txt", "two.txt"]) {
    writeFileSync(join(dir, file), `${file}\n`)
    git("add", file)
    git("commit", "-m", file)
  }
  if (options.remote === undefined) {
    // Parsed only for gh's positional repo argument; never fetched or pushed.
    git("remote", "add", "origin", "https://github.com/acme/demo.git")
  } else {
    // A bare origin one directory up, seeded with a `trunk` (or given) branch
    // that has a commit `main` does not, so a test can prove which ref the new
    // branch was cut from. Pushing updates refs/remotes/origin/* here, exactly
    // as the flow's own `git fetch origin --prune` would.
    const { branch } = options.remote
    const bare = join(root, "origin.git")
    execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    git("remote", "add", "origin", bare)
    if (branch === "main") {
      git("push", "origin", "main")
    } else {
      git("switch", "-c", branch)
      writeFileSync(join(dir, `${branch}.txt`), `${branch}\n`)
      git("add", `${branch}.txt`)
      git("commit", "-m", branch)
      git("push", "origin", branch)
      git("switch", "main")
    }
  }
  if (originHead) {
    git("update-ref", "refs/remotes/origin/main", "HEAD")
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
  }
  const bin = join(root, "bin")
  mkdirSync(bin)
  return { root, dir, bin, git }
}

function ghLog(r: Repo): string {
  return join(r.root, "gh.log")
}

// Every invocation appends its argv to gh.log: harmless when the code should
// not call gh, and direct evidence when it should.
function fakeGh(r: Repo, stub: GhStub = {}): void {
  const view =
    stub.existingPr === true
      ? `printf '%s\\n' '{"number":9,"url":"https://github.com/acme/demo/pull/9"}'`
      : `printf '%s\\n' 'no pull requests found for branch' >&2\n    exit 1`
  const repoView =
    stub.defaultBranch === undefined
      ? `printf '%s\\n' 'not a git repository' >&2\n    exit 1`
      : `printf '%s\\n' '{"defaultBranchRef":{"name":"${stub.defaultBranch}"}}'`
  const create =
    stub.createUrl === undefined
      ? `printf '%s\\n' 'stub: pr create not configured' >&2\n    exit 1`
      : `printf '%s\\n' '${stub.createUrl}'`
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> '${ghLog(r)}'
case "$1 $2" in
  "pr view")
    ${view}
    ;;
  "repo view")
    ${repoView}
    ;;
  "pr create")
    ${create}
    ;;
  *)
    printf '%s\\n' "fake gh: unsupported arguments: $*" >&2
    exit 1
    ;;
esac
`
  writeFileSync(join(r.bin, "gh"), script, { mode: 0o755 })
}

// A `git` shim for the case git reports an error AFTER it has already moved the
// changes into a stash entry. Same PATH seam as the gh stub: the real binary is
// baked in from `command -v git` before `bin/` joins PATH, and only
// `stash push` is intercepted — everything else is exec'd straight through.
//   "after-save": run the real push (the entry now exists), then exit 1.
//   "no-entry":  fail before touching the worktree (nothing was saved).
function fakeGitFailedStashPush(r: Repo, mode: "after-save" | "no-entry"): void {
  const real = execFileSync("/bin/sh", ["-c", "command -v git"], {
    encoding: "utf8",
    env: { ...process.env, PATH: originalPath ?? "" },
  }).trim()
  const push =
    mode === "after-save"
      ? `"${real}" "$@"
    printf '%s\\n' 'fatal: could not write new index file: simulated post-save failure' >&2
    exit 1`
      : `printf '%s\\n' 'fatal: unable to write index: simulated failure before saving' >&2
    exit 1`
  const script = `#!/bin/sh
case "$1:$2" in
  stash:push)
    ${push}
    ;;
  *)
    exec "${real}" "$@"
    ;;
esac
`
  writeFileSync(join(r.bin, "git"), script, { mode: 0o755 })
}

function useRepo(r: Repo): void {
  process.env.PATH = `${r.bin}:${originalPath ?? ""}`
}

function ghCalls(r: Repo): string[] {
  const log = ghLog(r)
  if (!existsSync(log)) return []
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
}

afterEach(() => {
  restoreEnv("PATH", originalPath)
  restoreEnv("GIT_CONFIG_GLOBAL", originalGitConfigGlobal)
  restoreEnv("GIT_CONFIG_SYSTEM", originalGitConfigSystem)
  restoreEnv("GIT_CONFIG_NOSYSTEM", originalGitConfigNoSystem)
  for (const [name, original] of savedGitEnv) restoreEnv(name, original)
  savedGitEnv.clear()
})

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("defaultBaseBranch — the base is the BARE branch name", () => {
  // No gh stub call expected: origin/HEAD resolves it locally. The stub is
  // still installed so an accidental fallback cannot reach the network.
  test("readDivergence returns `main` from origin/HEAD, never `origin/main`", async () => {
    const r = makeRepo("symref", true)
    fakeGh(r, { defaultBranch: "trunk" })
    useRepo(r)

    const div = await readDivergence(r.dir)

    expect(div.base).toBe("main")
    // The regression guard: any `origin/` prefix reintroduces the dead swap.
    expect(div.base).not.toContain("/")
    // Tier one answered, so the gh fallback (which would say "trunk") never ran.
    expect(ghCalls(r)).toEqual([])
  })

  test("no origin/HEAD: gh's defaultBranchRef is used and the stub was invoked", async () => {
    const r = makeRepo("fallback", false)
    fakeGh(r, { defaultBranch: "trunk" })
    useRepo(r)

    const div = await readDivergence(r.dir)

    expect(div.base).toBe("trunk")
    expect(div.base).not.toContain("/")
    expect(ghCalls(r).some((line) => line.startsWith("repo view"))).toBe(true)
  })

  test("no origin/HEAD and a failing gh: the object has no `base` key at all", async () => {
    const r = makeRepo("noghh", false)
    fakeGh(r)
    useRepo(r)

    const div = await readDivergence(r.dir)

    // FAIL CLOSED: absent, not `undefined`-valued, and never defaulted to main.
    expect("base" in div).toBe(false)
    expect(ghCalls(r).some((line) => line.startsWith("repo view"))).toBe(true)
  })
})

describe("createPr — head == base is refused before `gh pr create`", () => {
  test("on main: refusal sentence, and the stub logged no `pr create`", async () => {
    const r = makeRepo("onbase", true)
    fakeGh(r, { createUrl: "https://github.com/acme/demo/pull/7" })
    useRepo(r)

    const reply = await createPr(r.dir, undefined, undefined)

    expect(reply).toBe("Create PR refused: this branch is main — there is nothing to open a PR against.")
    // The existing-PR check does run `gh pr view` — only `create` is withheld.
    expect(ghCalls(r).some((line) => line.startsWith("pr view"))).toBe(true)
    expect(ghCalls(r).filter((line) => line.startsWith("pr create"))).toEqual([])
  })

  test("off base: the guard does not over-block and `gh pr create` runs", async () => {
    const r = makeRepo("offbase", true)
    r.git("switch", "-c", "feat/x")
    fakeGh(r, { createUrl: "https://github.com/acme/demo/pull/7" })
    useRepo(r)

    const reply = await createPr(r.dir, undefined, undefined)

    expect(reply).toBe("https://github.com/acme/demo/pull/7")
    expect(reply).not.toContain("nothing to open a PR against")
    const created = ghCalls(r).filter((line) => line.startsWith("pr create"))
    expect(created).toHaveLength(1)
    expect(created[0]).toContain("--title=feat/x")
  })
})

// The wave-5 hold: the panel offers a branch action from `defaultBaseBranch`
// (origin/HEAD, else gh's `defaultBranchRef`), but the backend that performs it
// — `continueWork`, behind both Create-branch and the detached-stash repair —
// resolved its base from the PR and origin/HEAD only, so with no PR and no
// origin/HEAD the panel offered an action `continueWork` refused. These run REAL
// git with an offline bare origin; `gh pr view` always fails, so the base can
// only come from the shared resolver.
describe("continueWork — the backend shares the GUI's default-branch fallback", () => {
  const dirtyFiles = (r: Repo): void => {
    writeFileSync(join(r.dir, "one.txt"), "edited\n")
    writeFileSync(join(r.dir, "new.txt"), "untracked\n")
  }

  test("clean tree, no origin/HEAD: the branch is cut from gh's default `trunk`", async () => {
    const r = makeRepo("cont-clean", false, { remote: { branch: "trunk" } })
    fakeGh(r, { defaultBranch: "trunk" })
    useRepo(r)

    const reply = await continueWork(r.dir, undefined, false)

    expect(reply.ok).toBe(true)
    if (!reply.ok) return
    expect(reply.base).toBe("trunk")
    expect(reply.branch.startsWith("continue/")).toBe(true)
    // origin/trunk was fetched and used: the new HEAD is exactly its tip, not
    // main's.
    expect(r.git("rev-parse", reply.branch)).toBe(r.git("rev-parse", "refs/remotes/origin/trunk"))
    expect(r.git("rev-parse", "refs/remotes/origin/trunk")).not.toBe(r.git("rev-parse", "main"))
    expect(r.git("branch", "--show-current")).toBe(reply.branch)
    // gh's defaultBranchRef answered because origin/HEAD is unset.
    expect(ghCalls(r).some((line) => line.startsWith("repo view"))).toBe(true)
  })

  test("dirty tree, no origin/HEAD: the changes travel to the new branch", async () => {
    const r = makeRepo("cont-dirty", false, { remote: { branch: "trunk" } })
    fakeGh(r, { defaultBranch: "trunk" })
    useRepo(r)
    dirtyFiles(r)

    const reply = await continueWork(r.dir, undefined, true)

    expect(reply.ok).toBe(true)
    if (!reply.ok) return
    expect(reply.base).toBe("trunk")
    // Both the tracked edit and the untracked file survived the stash/apply
    // round trip, in the worktree of the branch that was created.
    expect(readFileSync(join(r.dir, "one.txt"), "utf8")).toBe("edited\n")
    expect(readFileSync(join(r.dir, "new.txt"), "utf8")).toBe("untracked\n")
    expect(r.git("status", "--porcelain")).toContain("one.txt")
    expect(r.git("branch", "--show-current")).toBe(reply.branch)
    // `apply` never drops: the entry is retained and named in the reply.
    expect(reply.stashed).toBeDefined()
    expect(r.git("stash", "list")).not.toBe("")
  })

  test("no origin/HEAD and a failing gh: the refusal changes nothing", async () => {
    const r = makeRepo("cont-nobase", false, { remote: { branch: "trunk" } })
    // No stub answer: `pr view` and `repo view` both exit 1.
    fakeGh(r)
    useRepo(r)
    dirtyFiles(r)

    const reply = await continueWork(r.dir, undefined, true)

    expect(reply.ok).toBe(false)
    if (reply.ok) return
    expect(reply.error).toContain("could not resolve the PR base or origin/HEAD")
    // The base is resolved BEFORE the stash now, so there is nothing to strand
    // and no stash note to report.
    expect(reply.error).not.toContain("stash")
    expect(readFileSync(join(r.dir, "one.txt"), "utf8")).toBe("edited\n")
    expect(readFileSync(join(r.dir, "new.txt"), "utf8")).toBe("untracked\n")
    expect(r.git("stash", "list")).toBe("")
    expect(r.git("branch", "--show-current")).toBe("main")
    expect(ghCalls(r).some((line) => line.startsWith("repo view"))).toBe(true)
  })

  test("a failed switch restores the changes instead of stranding them", async () => {
    const r = makeRepo("cont-switch", false, { remote: { branch: "trunk" } })
    fakeGh(r, { defaultBranch: "trunk" })
    useRepo(r)
    // Claim the name continueWork will pick (`continue/<yyyyMMdd-hhmm>`), so
    // `git switch -c` fails at the one point where the stash already exists.
    // The following minute is claimed too, so a boundary crossing cannot race.
    const now = new Date()
    r.git("branch", `continue/${continueStamp(now)}`)
    r.git("branch", `continue/${continueStamp(new Date(now.getTime() + 60_000))}`)
    writeFileSync(join(r.dir, "one.txt"), "edited\n")

    const reply = await continueWork(r.dir, undefined, true)

    expect(reply.ok).toBe(false)
    if (reply.ok) return
    expect(reply.error).toContain("git switch -c")
    expect(reply.error).toContain("Your changes were restored to the worktree")
    expect(readFileSync(join(r.dir, "one.txt"), "utf8")).toBe("edited\n")
    expect(r.git("branch", "--show-current")).toBe("main")
    // Restored by `apply`, so the entry is still listed, never dropped.
    expect(r.git("stash", "list")).not.toBe("")
  })

  // The gate's open hole: a `stash push` that exits non-zero AFTER saving. The
  // old branch returned a bare failure, which left the changes reachable only
  // by a stash-literate user. Both reachable outcomes are pinned here.
  test("a stash push that saves then fails: the changes are restored, entry retained", async () => {
    const r = makeRepo("cont-pushfail", false, { remote: { branch: "trunk" } })
    fakeGh(r, { defaultBranch: "trunk" })
    fakeGitFailedStashPush(r, "after-save")
    useRepo(r)
    dirtyFiles(r)

    const reply = await continueWork(r.dir, undefined, true)

    expect(reply.ok).toBe(false)
    if (reply.ok) return
    expect(reply.error).toContain("git stash push -u")
    expect(reply.error).toContain("simulated post-save failure")
    // Case (b): the entry this push created was identified and replayed.
    expect(reply.error).toContain("they were restored to the worktree")
    expect(reply.error).toContain("still listed")
    // Post-condition: both the tracked edit and the untracked file are back in
    // the worktree, on the branch that was never switched away from.
    expect(readFileSync(join(r.dir, "one.txt"), "utf8")).toBe("edited\n")
    expect(readFileSync(join(r.dir, "new.txt"), "utf8")).toBe("untracked\n")
    expect(r.git("status", "--porcelain")).toContain("one.txt")
    expect(r.git("branch", "--show-current")).toBe("main")
    // `git stash list` still shows exactly the one entry the failed push made —
    // nothing was dropped, so the restore is a duplicate of a retained entry.
    const listed = r.git("stash", "list")
    expect(listed).toContain("oc-pr auto-stash")
    expect(listed.split("\n")).toHaveLength(1)
  })

  test("a stash push that fails without saving: the message points at status and the stack", async () => {
    const r = makeRepo("cont-pushnone", false, { remote: { branch: "trunk" } })
    fakeGh(r, { defaultBranch: "trunk" })
    fakeGitFailedStashPush(r, "no-entry")
    useRepo(r)
    dirtyFiles(r)

    const reply = await continueWork(r.dir, undefined, true)

    expect(reply.ok).toBe(false)
    if (reply.ok) return
    // Case (c): no entry to identify, so recovery must be spelled out rather
    // than assumed.
    expect(reply.error).toContain("Could not identify a stash entry")
    expect(reply.error).toContain("`git status`")
    expect(reply.error).toContain("`git stash list`")
    // Nothing moved: the work never left the worktree and nothing was stashed.
    expect(readFileSync(join(r.dir, "one.txt"), "utf8")).toBe("edited\n")
    expect(readFileSync(join(r.dir, "new.txt"), "utf8")).toBe("untracked\n")
    expect(r.git("stash", "list")).toBe("")
    expect(r.git("branch", "--show-current")).toBe("main")
  })
})

// The confirm dialog's optional branch name. Every case runs real git against
// the offline bare origin: the point is that a bad or taken name is refused
// BEFORE the fetch and the stash, so the worktree and the stack are untouched.
describe("continueWork — a dialog-supplied branch name", () => {
  test("a valid name is used verbatim, cut from the resolved base", async () => {
    const r = makeRepo("cont-named", false, { remote: { branch: "trunk" } })
    fakeGh(r, { defaultBranch: "trunk" })
    useRepo(r)

    const reply = await continueWork(r.dir, undefined, false, "feat/named")

    expect(reply.ok).toBe(true)
    if (!reply.ok) return
    expect(reply.branch).toBe("feat/named")
    expect(reply.base).toBe("trunk")
    expect(r.git("branch", "--show-current")).toBe("feat/named")
    expect(r.git("rev-parse", "feat/named")).toBe(r.git("rev-parse", "refs/remotes/origin/trunk"))
  })

  test("an invalid name refuses before the stash, nothing moved", async () => {
    const r = makeRepo("cont-invalid", false, { remote: { branch: "trunk" } })
    fakeGh(r, { defaultBranch: "trunk" })
    useRepo(r)
    writeFileSync(join(r.dir, "one.txt"), "edited\n")
    writeFileSync(join(r.dir, "new.txt"), "untracked\n")

    const reply = await continueWork(r.dir, undefined, true, "bad name")

    expect(reply.ok).toBe(false)
    if (reply.ok) return
    expect(reply.error).toContain("Continue refused")
    expect(reply.error).toContain("No branch was created")
    expect(readFileSync(join(r.dir, "one.txt"), "utf8")).toBe("edited\n")
    expect(readFileSync(join(r.dir, "new.txt"), "utf8")).toBe("untracked\n")
    expect(r.git("stash", "list")).toBe("")
    expect(r.git("branch", "--show-current")).toBe("main")
    // The refusal precedes the base fetch, so gh was never asked either.
    expect(ghCalls(r)).toEqual([])
  })

  // git owns the grammar: these all satisfy the text rules above (`REF_RE` plus
  // the explicit `..`/`@{` rules) and are still refused by
  // `git check-ref-format --branch`. Before that check existed the flow stashed
  // first and only `git switch -c` failed, leaving the work in the stack. Each
  // case therefore proves the refusal happens with the worktree, the stash and
  // the ref list untouched, and without asking gh.
  const gitRejected = [".hidden", "feat/.hidden", "feat.lock/child", "foo..bar", "@{x}"]
  for (const [index, name] of gitRejected.entries()) {
    test(`\`${name}\` is refused before anything is touched`, async () => {
      const r = makeRepo(`cont-reject-${index}`, false, { remote: { branch: "trunk" } })
      fakeGh(r, { defaultBranch: "trunk" })
      useRepo(r)
      writeFileSync(join(r.dir, "one.txt"), "edited\n")
      writeFileSync(join(r.dir, "new.txt"), "untracked\n")

      const reply = await continueWork(r.dir, undefined, true, name)

      expect(reply.ok).toBe(false)
      if (reply.ok) return
      expect(reply.error).toContain("Continue refused")
      expect(reply.error).toContain(`\`${name}\``)
      expect(reply.error).toContain("No branch was created")
      // No stash, no branch, the dirty files exactly as they were, no gh call.
      expect(r.git("stash", "list")).toBe("")
      expect(r.git("branch", "--list", name)).toBe("")
      expect(readFileSync(join(r.dir, "one.txt"), "utf8")).toBe("edited\n")
      expect(readFileSync(join(r.dir, "new.txt"), "utf8")).toBe("untracked\n")
      expect(ghCalls(r)).toEqual([])
    })
  }

  test("a name that already exists refuses and names the collision", async () => {
    const r = makeRepo("cont-taken", false, { remote: { branch: "trunk" } })
    fakeGh(r, { defaultBranch: "trunk" })
    useRepo(r)
    r.git("branch", "feat/taken")
    writeFileSync(join(r.dir, "one.txt"), "edited\n")

    const reply = await continueWork(r.dir, undefined, true, "feat/taken")

    expect(reply.ok).toBe(false)
    if (reply.ok) return
    expect(reply.error).toContain("`feat/taken` already exists")
    expect(reply.error).toContain("No branch was created")
    // Refused before the stash: the edit is still in the worktree and the stack
    // is empty, and the existing branch was not moved or reused.
    expect(readFileSync(join(r.dir, "one.txt"), "utf8")).toBe("edited\n")
    expect(r.git("stash", "list")).toBe("")
    expect(r.git("branch", "--show-current")).toBe("main")
  })

  test("a blank name keeps the timestamped default exactly", async () => {
    const r = makeRepo("cont-blank", false, { remote: { branch: "trunk" } })
    fakeGh(r, { defaultBranch: "trunk" })
    useRepo(r)

    const reply = await continueWork(r.dir, undefined, false, "   ")

    expect(reply.ok).toBe(true)
    if (!reply.ok) return
    expect(reply.branch.startsWith("continue/")).toBe(true)
    expect(r.git("branch", "--show-current")).toBe(reply.branch)
  })
})

// `--body` is one argv element (`run` uses execFile; there is no shell), and an
// absent description must keep the byte-identical empty `--body=` this method
// sent before the dialog grew a description field.
describe("createPr — the dialog description becomes one argv element", () => {
  test("a description with quotes, dollars and a command substitution is passed whole", async () => {
    const r = makeRepo("body-arg", true)
    r.git("switch", "-c", "feat/body")
    fakeGh(r, { createUrl: "https://github.com/acme/demo/pull/8" })
    useRepo(r)
    const sentinel = join(r.root, "pwned")
    const body = `Uses "quotes"; $(touch ${sentinel}) & \`echo hi\``

    const reply = await createPr(r.dir, "A title", undefined, body)

    expect(reply).toBe("https://github.com/acme/demo/pull/8")
    const created = ghCalls(r).filter((line) => line.startsWith("pr create"))
    expect(created).toHaveLength(1)
    expect(created[0]).toContain(`--body=${body}`)
    // execFile never interprets the string, so the substitution stayed literal.
    expect(existsSync(sentinel)).toBe(false)
  })

  test("an absent description keeps the original empty --body=", async () => {
    const r = makeRepo("body-empty", true)
    r.git("switch", "-c", "feat/empty")
    fakeGh(r, { createUrl: "https://github.com/acme/demo/pull/8" })
    useRepo(r)

    const reply = await createPr(r.dir, "Only a title", undefined)

    expect(reply).toBe("https://github.com/acme/demo/pull/8")
    const created = ghCalls(r).filter((line) => line.startsWith("pr create"))
    expect(created).toHaveLength(1)
    expect(created[0].endsWith("--body=")).toBe(true)
  })
})
