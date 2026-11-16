// oc-pr-gui — the main-process half.
//
// Every helper that spawns a process (`git`, `gh`) and every module-level memo
// only the main process touches lives here. `gui.tsx` imports this module for
// its `main` handlers; `setup` and the window components never call into it.
// They reach these functions only through `ctx.main(PrPanel)`, so the window's
// setup path runs no `execFile` and mutates no cache it does not own. That
// direction is one-way (`gui.tsx -> git.ts`) and guarded by split.test.ts.
//
// The dual-process note from gui.tsx still applies: `execFile` is an inert
// placeholder in the window, and this module's functions are only ever invoked
// from `main`, where Node is real.
import { execFile } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { classifyCreateError, classifyGhError, type PrFailureReason } from "./contract"
import {
  BRANCH_PR_QUERY,
  checkLine,
  continueStamp,
  failureLine,
  firstLine,
  FOLDED_PR_QUERY,
  foldKey,
  foldOutcome,
  isExcludedPath,
  message,
  parseBranchRefs,
  parseJson,
  parsePorcelain,
  parseStatusSnapshot,
  pickDefaultBranch,
  porcelainFiles,
  reapPrs,
  reapVerdict,
  reaperPreference,
  repoFromRemote,
  resetPrFacts,
  resetVerdict,
  retainedStashNote,
  recoveryCommand,
  shellQuote,
  stepText,
  type Check,
  type FoldKey,
  type GhPrFields,
  type PorcelainEntry,
  type ReapedBranch,
  type ReaperSettingsRead,
  type ResetPrFacts,
  type StashEntry,
  type StashLookup,
  type StepText,
  type WorktreeSnapshot,
} from "./pure"

type RunResult = { ok: boolean; out: string; err: string; timedOut?: boolean; aborted?: boolean }

export type PrOk = {
  ok: true
  number?: number
  url?: string
  title?: string
  state?: string
  isDraft?: boolean
  mergeable?: string
  mergeStateStatus?: string
  reviewDecision?: string
  checks?: Check[]
  branch?: string
  // Base branch (baseRefName). Read from the same `gh pr view` call so the
  // dialog can show `<head> → <base>` and the Review prompt can name both.
  base?: string
  // HEAD commit, used (with the PR number) as the auto-fix dedupe key so a
  // poll tick cannot queue the same fix twice for one head.
  headSha?: string
  // Unresolved review threads on this PR. `null` = unknown (query failed,
  // repository or number missing); the modal then keeps its review-fact
  // fallback and the normal primary button. The titlebar chip reads the same
  // count: `> 0` adds a "N open items" label segment and, on an open PR,
  // promotes the state word to Review items. Unknown and 0 leave it short.
  // Counted in ONE of two ways. The normal path is folded into the status call
  // itself (main runs a single GraphQL query for the status fields AND
  // reviewThreads, Tier B item 7), so it arrives with the status it belongs to.
  // The fallback path (`gh pr view`, used whenever the folded query cannot
  // answer) has no such field and decorates from the separate `threads` pass
  // after this status has painted. `undefined` means "not counted yet" and reads
  // as unknown everywhere.
  reviewThreads?: { unresolved: number } | null
}

type PrFail = {
  ok: false
  // `none`/`not-repo`/`detached` are normal states, not failures. `timeout`
  // gets a retry affordance; `error` keeps a bounded raw output for the details
  // toggle. `commit` is the short SHA when HEAD is detached.
  reason: PrFailureReason
  branch?: string
  commit?: string
  error?: string
  output?: string
}

export type PrData = PrOk | PrFail

const MAX_BUFFER = 8 * 1024 * 1024
const MAX_RAW = 4_000
export const MAX_SHORT = 300
const DEFAULT_TIMEOUT = 12_000
// Review-thread count is decoration, not the status itself: a slow GraphQL
// answer is dropped to `null` rather than delaying the panel.
const THREADS_TIMEOUT = 8_000
// The poll's two cadences live in ./pure (POLL_MS_FAST / POLL_MS_SLOW) behind
// `pollDelay`, so the visible-or-dialog rule is unit-tested rather than spelled
// out inside a setTimeout.

// Same shape as oc-pr.ts: values never reach gh's option grammar.
const PR_NUMBER_RE = /^\d+$/
const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/(\d+)\/?$/
const REF_RE = /^[A-Za-z0-9._/-]+$/

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT,
  signal?: AbortSignal,
  // Keep stdout verbatim. Porcelain `-z` output begins with a status column
  // that may be a space (" M file\0"); trimming it would shift every entry by
  // one character. Only the dirty checks ask for this.
  raw = false,
): Promise<RunResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: process.env, signal },
        (error, stdout, stderr) => {
          const e = error as any
          const aborted = e?.name === "AbortError" || e?.code === "ABORT_ERR"
          const timedOut = !aborted && e?.killed === true && e?.signal === "SIGTERM"
          const stdoutText = String(stdout ?? "")
          resolve({
            ok: !error,
            out: raw ? stdoutText : stdoutText.trim(),
            err: String(stderr ?? "").trim() || (error ? message(error) : ""),
            timedOut,
            aborted,
          })
        },
      )
    } catch (e) {
      resolve({
        ok: false,
        out: "",
        err: message(e),
        aborted: (e as any)?.name === "AbortError",
      })
    }
  })
}

// ONE `run` -> {aborted, timedOut, !ok} collapse. The three sentences stay at
// the call site, because they name the flow, the command and its consequence;
// this helper only decides which one applies and returns it whole. `steps` is
// never touched here: recording what succeeded stays with the caller.
//
// A template may be a function of stderr when the sentence quotes git/gh's own
// line; `aborted` never needs it, `timeout` does where the old code preferred
// stderr over its fallback wording.
export type StepOutcome =
  | { ok: true; out: string }
  | { ok: false; kind: "aborted" | "timeout" | "error"; message: string }

async function runStep(
  cmd: string,
  args: string[],
  options: { cwd: string; timeout?: number; signal?: AbortSignal },
  messages: { aborted: StepText; timeout: StepText; error: StepText },
): Promise<StepOutcome> {
  const res = await run(
    cmd,
    args,
    options.cwd,
    options.timeout ?? DEFAULT_TIMEOUT,
    options.signal,
  )
  if (res.aborted) return { ok: false, kind: "aborted", message: stepText(messages.aborted, res.err) }
  if (res.timedOut) return { ok: false, kind: "timeout", message: stepText(messages.timeout, res.err) }
  if (!res.ok) return { ok: false, kind: "error", message: stepText(messages.error, res.err) }
  return { ok: true, out: res.out }
}

type HeadInfo = {
  branch?: string
  commit?: string
  // True only for a real repository whose HEAD is not on a branch. Never true
  // for a directory that is not a repository: that falls through to gh's
  // `not-repo` state.
  detached: boolean
}

// A detached worktree used to look like a branch literally named "HEAD": both
// `git branch --show-current` (empty) and `rev-parse --abbrev-ref HEAD`
// ("HEAD") mean "no branch". Resolve the branch and the short SHA together so
// the panel can show `detached HEAD (<sha>)` and never ask gh about "HEAD".
async function branchName(cwd: string, signal?: AbortSignal): Promise<HeadInfo> {
  const [current, abbrev, short] = await Promise.all([
    run("git", ["branch", "--show-current"], cwd, 5_000, signal),
    run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd, 5_000, signal),
    run("git", ["rev-parse", "--short", "HEAD"], cwd, 5_000, signal),
  ])
  const raw = current.ok ? current.out.trim() : ""
  const branch =
    raw !== "" && raw !== "HEAD" && !(abbrev.ok && abbrev.out === "HEAD") ? raw : undefined
  const commit = short.ok && short.out !== "" ? short.out : undefined
  return { branch, commit, detached: current.ok && branch === undefined }
}

// Owner/repo parsed from a PR URL. `gh pr view --json` has no `baseRepository`
// field — asking for one fails the entire call (gh 2.103.3: "Unknown JSON
// field") — so the URL is the reliable source, and the URL always names the
// base repository, including for fork PRs.
export function repoFromUrl(raw: unknown): { owner: string; name: string } | undefined {
  if (typeof raw !== "string") return undefined
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(raw)
  if (match === null) return undefined
  const owner = match[1]
  const name = match[2]
  if (owner === undefined || name === undefined) return undefined
  return { owner, name }
}

// Counts unresolved review threads with `gh api graphql`. Everything here is
// best-effort: a missing repository/number, a non-zero exit, or an unexpected
// payload returns `null` (unknown), never an error and never a blocked status.
// Threads are page-capped at 100, matching the single-page contract.

export async function countReviewThreads(
  cwd: string,
  owner: string,
  name: string,
  number: number,
  signal?: AbortSignal,
): Promise<{ unresolved: number } | null> {
  const query =
    "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}"
  const result = await run(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${name}`,
      "-F",
      `number=${number}`,
    ],
    cwd,
    THREADS_TIMEOUT,
    signal,
  )
  if (!result.ok) return null
  const nodes = parseJson<any>(result.out)?.data?.repository?.pullRequest?.reviewThreads?.nodes
  if (!Array.isArray(nodes)) return null
  return { unresolved: nodes.filter((node: any) => node?.isResolved !== true).length }
}

// Mirrors oc-pr.ts prStatus's `gh pr view` field set, reduced to what the panel
// shows. Never throws: a missing PR is a typed `reason`, not raw stderr.
//
// Tier B item 11: "which branch" and "what state" come from ONE process-wide
// worktree read shared by `status` and `ahead` (see `worktreeSnapshot`), which
// replaced six git spawns per refresh (three branch/HEAD probes per caller) with
// one `git status --porcelain=v2 --branch -z`.
type Snapshot = {
  head: HeadInfo
  entries: PorcelainEntry[]
  ahead?: number
  behind?: number
  upstream?: string
  repo?: { owner: string; name: string }
}

const EMPTY_SNAPSHOT: WorktreeSnapshot = { detached: false, entries: [] }

async function readSnapshot(cwd: string): Promise<Snapshot> {
  const [status, origin] = await Promise.all([
    run("git", ["status", "--porcelain=v2", "--branch", "-z"], cwd, 5_000, undefined, true),
    // The folded query needs the base repository. Reading it from git is one
    // local spawn; `gh repo view` would be a second network round trip.
    run("git", ["config", "--get", "remote.origin.url"], cwd, 5_000),
  ])
  const parsed = status.ok ? parseStatusSnapshot(status.out) : EMPTY_SNAPSHOT
  let ahead = parsed.ahead
  let behind = parsed.behind
  let upstream = parsed.upstream
  // No configured upstream: keep the pre-existing `origin/<branch>` probe so a
  // branch that only exists on origin still reports its counts. This costs one
  // extra spawn in this state only, never in the ordinary refresh.
  if (parsed.branch !== undefined && (ahead === undefined || behind === undefined)) {
    const remote = await run("git", ["rev-parse", "--verify", `origin/${parsed.branch}`], cwd, 5_000)
    if (remote.ok && remote.out !== "") {
      const counts = await run(
        "git",
        ["rev-list", "--left-right", "--count", `${remote.out}...HEAD`],
        cwd,
        5_000,
      )
      if (counts.ok) {
        const [behindRaw, aheadRaw] = counts.out.split(/\s+/)
        const parsedBehind = Number.parseInt(behindRaw ?? "", 10)
        const parsedAhead = Number.parseInt(aheadRaw ?? "", 10)
        if (Number.isFinite(parsedAhead) && Number.isFinite(parsedBehind)) {
          ahead = parsedAhead
          behind = parsedBehind
          upstream = remote.out
        }
      }
    }
  }
  const commit = parsed.commit
  return {
    head: {
      branch: parsed.branch,
      // v2 prints the full oid and has no short form; the panel showed
      // `rev-parse --short` before, so keep the same display width.
      commit: commit === undefined ? undefined : commit.slice(0, 7),
      detached: parsed.detached,
    },
    entries: parsed.entries,
    ahead,
    behind,
    upstream,
    repo: repoFromRemote(origin.out),
  }
}

const snapshotInFlight = new Map<string, Promise<Snapshot>>()

// Bumped by every mutating method in `main` (see `mutate`). It is process-wide
// because BOTH in-flight maps are keyed by it: the IPC dedupe map and the
// snapshot share below. Keying the snapshot by generation too is what stops a
// post-action refresh from joining a pre-action worktree read that is still in
// flight — an entry from an older generation can only be awaited by the callers
// that already had it, and it deletes its own (old) key when it settles.
let readGen = 0

// In-flight dedupe by generation + directory: the window sends `status` and
// `ahead` together on every refresh (same `source` key), so whichever arrives
// first computes the read and the other joins. readSnapshot consumes RunResults
// only and therefore never rejects. The entry is removed on settle, so the map
// holds no result and is bounded by the directories in flight.
function worktreeSnapshot(cwd: string): Promise<Snapshot> {
  const key = `${readGen}\u0000${cwd}`
  const hit = snapshotInFlight.get(key)
  if (hit !== undefined) return hit
  const pending = readSnapshot(cwd).finally(() => {
    if (snapshotInFlight.get(key) === pending) snapshotInFlight.delete(key)
  })
  snapshotInFlight.set(key, pending)
  return pending
}

// The one field mapper both status paths share, so the folded reply and `gh pr
// view` cannot drift apart: every field below is what the `--json` list names.
function toPrOk(pr: GhPrFields, head: HeadInfo): PrOk {
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup.slice(0, 20).map(checkLine) : []
  return {
    ok: true,
    branch: head.branch,
    number: typeof pr.number === "number" ? pr.number : undefined,
    url: typeof pr.url === "string" ? pr.url : undefined,
    title: typeof pr.title === "string" ? pr.title : undefined,
    state: typeof pr.state === "string" ? pr.state : undefined,
    isDraft: pr.isDraft === true,
    mergeable: typeof pr.mergeable === "string" ? pr.mergeable : undefined,
    mergeStateStatus: typeof pr.mergeStateStatus === "string" ? pr.mergeStateStatus : undefined,
    reviewDecision: typeof pr.reviewDecision === "string" ? pr.reviewDecision : undefined,
    checks,
    headSha: typeof pr.headRefOid === "string" ? pr.headRefOid : undefined,
    base: typeof pr.baseRefName === "string" ? pr.baseRefName : undefined,
  }
}

// Last PR number main saw for a directory's branch. A hint only: the folded
// reply carries headRefName, and a mismatch turns the hint back into a branch
// lookup, so a branch switch can never pin the panel to the old PR.
const prNumber = new Map<string, { branch?: string; number: number }>()

// ONE rule for every memo write, shared by the folded and the `gh pr view`
// paths: only an OPEN PR is remembered. A merged or closed number must never
// enter the hint, because a reused branch carries an old merged PR next to the
// new open one — remembering the old one would send every tick down the
// revalidate path (and, before the revalidate rule, pinned the branch to it).
// A non-open result also CLEARS any previous hint for the directory, so the
// hint and the painted status can never disagree about which PR is current.
function rememberPr(cwd: string, branch: string | undefined, data: PrOk): void {
  if (data.number !== undefined && branch !== undefined && (data.state ?? "").toUpperCase() === "OPEN") {
    prNumber.set(cwd, { branch, number: data.number })
  } else {
    prNumber.delete(cwd)
  }
}

// Validate every value that reaches gh's argv, exactly like checkRef. owner/name
// already passed repoFromRemote's character check.
function foldedArgs(repo: { owner: string; name: string }, key: ReturnType<typeof foldKey>): string[] | undefined {
  if (key.kind === "none") return undefined
  if (key.kind === "branch" && (!REF_RE.test(key.branch) || key.branch.startsWith("-"))) return undefined
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${key.kind === "number" ? FOLDED_PR_QUERY : BRANCH_PR_QUERY}`,
    "-F",
    `owner=${repo.owner}`,
    "-F",
    `repo=${repo.name}`,
  ]
  if (key.kind === "number") args.push("-F", `number=${key.number}`)
  else args.push("-F", `head=${key.branch}`)
  return args
}

// Tier B item 7: ONE `gh api graphql` for the status fields AND reviewThreads.
// Returns undefined whenever the folded shape cannot answer, which is the signal
// to run the untouched dual path below: no origin remote, no usable key, any
// gh/schema/timeout failure, a null PR, zero PRs for the branch (the fork case),
// or a remembered number that no longer belongs to this branch.
async function readFoldedStatus(cwd: string, snap: Snapshot): Promise<PrData | undefined> {
  const repo = snap.repo
  if (repo === undefined) return undefined
  const memo = prNumber.get(cwd)
  const hint = memo !== undefined && memo.branch === snap.head.branch ? memo.number : undefined
  let key: FoldKey = foldKey({ branch: snap.head.branch, memo: hint })
  // At most two gh calls: the remembered number first, then — only when the hint
  // could not answer — the ordered branch query, which is authoritative. The
  // second call is what makes a reused branch correct: the old merged PR's
  // number is dropped and the newest open PR is selected instead.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const args = foldedArgs(repo, key)
    if (args === undefined) return undefined
    const result = await run("gh", args, cwd, DEFAULT_TIMEOUT)
    const outcome = foldOutcome(result, key, snap.head.branch)
    if (outcome.kind === "cancelled") return { ok: false, reason: "cancelled", branch: snap.head.branch }
    if (outcome.kind === "fallback") return undefined
    if (outcome.kind === "revalidate") {
      // The remembered PR is merged or closed. On a reused branch that is the
      // old PR, so drop the hint and let the ordered branch query decide.
      prNumber.delete(cwd)
      if (key.kind !== "number" || snap.head.branch === undefined) return undefined
      key = { kind: "branch", branch: snap.head.branch }
      continue
    }
    const data: PrOk = { ...toPrOk(outcome.pr, snap.head), reviewThreads: outcome.threads }
    // OPEN-only, shared rule: see `rememberPr`.
    rememberPr(cwd, snap.head.branch, data)
    return data
  }
  return undefined
}

// The pre-Tier-B status path, unchanged apart from taking the HEAD it used to
// resolve itself and seeding the PR-number hint for the next folded call.
async function readStatusViaView(cwd: string, head: HeadInfo): Promise<PrData> {
  const view = await run(
    "gh",
    [
      "pr",
      "view",
      "--json",
      "number,url,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,baseRefName",
    ],
    cwd,
    DEFAULT_TIMEOUT,
  )

  if (!view.ok) {
    if (view.aborted) return { ok: false, reason: "cancelled", branch: head.branch }
    if (view.timedOut) return { ok: false, reason: "timeout", branch: head.branch }

    const kind = classifyGhError(view.err)
    if (kind === "none") return { ok: false, reason: "none", branch: head.branch }
    if (kind === "not-repo") return { ok: false, reason: "not-repo", branch: head.branch }

    return {
      ok: false,
      reason: "error",
      branch: head.branch,
      error: firstLine(view.err).slice(0, MAX_SHORT) || "gh pr view failed",
      output: view.err.slice(0, MAX_RAW),
    }
  }

  const pr = parseJson<any>(view.out)
  if (!pr) return { ok: false, reason: "error", error: "could not parse gh output", output: view.out.slice(0, MAX_RAW) }

  const data = toPrOk(pr, head)
  // Same OPEN-only rule as the folded path (`rememberPr`): `gh pr view` reports
  // MERGED/CLOSED for a landed PR, and that number must not become the hint.
  rememberPr(cwd, head.branch, data)
  return data
}

export async function readStatus(cwd: string, signal?: AbortSignal): Promise<PrData> {
  // Resolve HEAD first: a detached worktree has a commit but no branch, so gh
  // cannot resolve a pull request and must not be asked (it used to fail with
  // "not on any branch").
  const snap = await worktreeSnapshot(cwd)
  if (signal?.aborted) return { ok: false, reason: "cancelled", branch: snap.head.branch }
  if (snap.head.detached) return { ok: false, reason: "detached", commit: snap.head.commit }

  const folded = await readFoldedStatus(cwd, snap)
  if (folded !== undefined) return folded
  // Fallback: the existing dual path, unchanged (gh pr view here, the separate
  // threads IPC from the window).
  return readStatusViaView(cwd, snap.head)
}

// Mirrors oc-pr.ts checkRef: a ref never reaches gh's option grammar.
function checkRef(field: string, raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const s = raw.trim()
  if (s === "") {
    return { ok: false, error: `Create PR refused: \`${field}\` must not be empty. No command was run.` }
  }
  if (s.startsWith("-")) {
    return {
      ok: false,
      error: `Create PR refused: \`${field}\` must not start with "-" (got \`${s}\`). No command was run.`,
    }
  }
  if (!REF_RE.test(s)) {
    return {
      ok: false,
      error: `Create PR refused: \`${field}\` may only contain A-Za-z0-9._/- (got \`${s}\`). No command was run.`,
    }
  }
  return { ok: true, value: s }
}

// A branch name typed into the confirm dialog finishes a different sentence
// (`Continue`), so it is validated separately from `checkRef` rather than
// borrowing its "Create PR refused" wording.
//
// Two stages, cheapest first. REF_RE stays FIRST so nothing hostile ever reaches
// git as an option (`-x`, spaces, `@{...}`), and it names those problems in this
// flow's own words. It is only a SUBSET of git's grammar, though: `.hidden`,
// `feat/.hidden` and `feat.lock/child` all pass it and are still refused by git,
// which is what used to let the flow stash first and fail at `git switch -c`.
// `git check-ref-format --branch` is therefore the authoritative second stage.
// It is read-only — no ref, index or worktree is touched — so the whole check
// still finishes before the fetch, the stash and the switch, and `--branch`
// takes the name as its next argument even when it starts with `-`.
async function checkBranchName(
  cwd: string,
  raw: string,
  signal?: AbortSignal,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const s = raw.trim()
  const refused = (why: string) =>
    ({ ok: false, error: `Continue refused: ${why} No branch was created.` }) as const
  if (s.startsWith("-")) return refused("the branch name must not start with \"-\".")
  if (!REF_RE.test(s)) return refused(`\`${s}\` may only contain A-Za-z0-9._/-.`)
  const formatted = await run("git", ["check-ref-format", "--branch", s], cwd, DEFAULT_TIMEOUT, signal)
  if (formatted.aborted) return { ok: false, error: "Continue cancelled. No branch was created." }
  if (!formatted.ok) return refused(`\`${s}\` is not a valid git branch name.`)
  return { ok: true, value: s }
}

// Backend for the Create PR chip. No push: the branch must already be on the
// remote. The title/base are validated first; an existing PR refuses before any
// create command runs.
export async function createPr(
  cwd: string,
  rawTitle: string | undefined,
  rawBase: string | undefined,
  rawBody?: string,
  signal?: AbortSignal,
): Promise<string> {
  let title = (rawTitle ?? "").trim()
  let base: string | undefined
  if (rawBase !== undefined && rawBase.trim() !== "") {
    const checked = checkRef("base", rawBase)
    if (!checked.ok) return checked.error
    base = checked.value
  }

  const existing = await run("gh", ["pr", "view", "--json", "number,url"], cwd, DEFAULT_TIMEOUT, signal)
  if (existing.ok) {
    const pr = parseJson<{ number?: number; url?: string }>(existing.out)
    const label =
      pr?.number !== undefined
        ? `#${pr.number}${typeof pr.url === "string" ? ` (${pr.url})` : ""}`
        : "already exists"
    return `Create PR refused: this branch already has a PR ${label}. No command was run.`
  }
  if (existing.aborted) return "Create PR cancelled."
  if (existing.timedOut) return "Create PR failed: timed out while checking for an existing PR."

  // Head + base, resolved once: the empty-title fallback and the same-branch
  // pre-flight both need the branch. The base is the caller's `--base` when it
  // supplied one, otherwise the repository default — never a guess: gh refuses
  // this combination with raw stderr, so refuse here with a classified sentence
  // instead. When either side is unknown, fall through and let gh decide.
  const head = await branchName(cwd, signal)
  const baseName = base !== undefined ? base : await defaultBaseBranch(cwd, signal)
  if (head.branch !== undefined && baseName !== undefined && head.branch === baseName) {
    return `Create PR refused: this branch is ${baseName} — there is nothing to open a PR against.`
  }

  if (title === "") {
    title = head.branch ?? ""
  }
  if (title === "") return "Create PR failed: no title was given and the current branch could not be determined."

  // A blank description keeps the original empty `--body=` exactly; a typed one
  // rides as one argv element, so spaces, quotes and newlines never reach a
  // shell (there is no shell: `run` uses execFile).
  const body = (rawBody ?? "").trim()
  const options = [`--title=${title}`, `--body=${body}`]
  if (base !== undefined) options.push(`--base=${base}`)

  const res = await run("gh", ["pr", "create", ...options], cwd, 120_000, signal)
  if (res.aborted) return "Create PR cancelled."
  if (res.timedOut) return "Create PR failed: gh pr create timed out."
  if (!res.ok) {
    // Typed first so the headline is a sentence, never raw gh stderr. `unknown`
    // keeps only a bounded first line.
    switch (classifyCreateError(res.err)) {
      case "not-pushed":
        return "Create PR refused: the branch is not on origin yet — push it first."
      case "no-commits":
        return "Create PR refused: there are no commits between the base branch and this branch."
      case "exists":
        return "Create PR refused: this branch already has a pull request."
      // gh's own same-branch refusal, reached only when the pre-flight above
      // could not resolve one side (so the name may be unknown here).
      case "same-branch":
        return `Create PR refused: this branch is ${baseName ?? "the base branch"} — there is nothing to open a PR against.`
      default:
        return `Create PR failed: ${firstLine(res.err).slice(0, MAX_SHORT) || "gh pr create exited non-zero"}`
    }
  }
  return res.out || "Create PR: created (no output)."
}

// Duplicated from oc-pr.ts prMerge, minus its permission assertion (there is no
// permission API in the Electron main process). Authorisation here is the
// panel's explicit two-step confirmation plus these checks:
//   - confirm is the literal "merge"
//   - the PR is addressed by a validated number AND its URL
//   - the URL's repository is the current repository
//   - the number matches the URL
// Then only: gh pr merge <number> --squash --auto
export async function mergePr(cwd: string, number: number, url: string, confirm: string): Promise<string> {
  if (confirm !== "merge") {
    return 'oc-pr-gui refused: no explicit confirmation. No command was run.'
  }
  if (!Number.isSafeInteger(number) || number <= 0) {
    return `oc-pr-gui refused: invalid PR number \`${String(number)}\`. No command was run.`
  }
  if (!PR_NUMBER_RE.test(String(number))) {
    return `oc-pr-gui refused: invalid PR number \`${String(number)}\`. No command was run.`
  }

  const raw = url.trim()
  const match = PR_URL_RE.exec(raw)
  if (!match || !match[1]) {
    return `oc-pr-gui refused: the PR URL must be https://github.com/<owner>/<repo>/pull/<number> (got \`${raw}\`). No command was run.`
  }
  if (Number(match[1]) !== number) {
    return `oc-pr-gui refused: the PR number \`${number}\` does not match the URL (\`${match[1]}\`). No command was run.`
  }

  const urlRepo = raw.slice("https://github.com/".length).split("/pull/")[0]?.toLowerCase() ?? ""

  // A URL names a repository; `gh pr merge <number>` always targets the current
  // one, so refuse unless this is the current repository.
  const current = await run("gh", ["repo", "view", "--json", "nameWithOwner"], cwd)
  const parsed = current.ok ? parseJson<{ nameWithOwner?: string }>(current.out) : undefined
  const nameWithOwner = typeof parsed?.nameWithOwner === "string" ? parsed.nameWithOwner.trim() : ""
  if (!current.ok || nameWithOwner === "") {
    return `oc-pr-gui refused: the current repository could not be resolved (${firstLine(current.err) || "no repo"}). No command was run.`
  }
  if (nameWithOwner.toLowerCase() !== urlRepo) {
    return `oc-pr-gui refused: the PR is in \`${urlRepo}\` but the current repository is \`${nameWithOwner}\`. No command was run.`
  }

  const cmd = ["pr", "merge", String(number), "--squash", "--auto"]
  const res = await run("gh", cmd, cwd, 120_000)
  if (!res.ok) return `pr_merge failed: ${firstLine(res.err) || "gh pr merge exited non-zero"}`
  return `${res.out || "merge requested"}\n\n(gh ${cmd.join(" ")})`
}


// Origin/local divergence for the chip tooltip, the Push row and the
// Commit + Push row. `files` is display text (status + path), capped at 50;
// `changes` is the uncapped count of the same porcelain entries, so the chip
// and the file-list heading never report the display cap as the total.
export type Divergence = {
  ahead: number
  behind: number
  dirty: boolean
  changes: number
  files: string[]
  noUpstream: boolean
  // The repository's default branch (origin/HEAD, else gh's defaultBranchRef).
  // Carried here because the GUI's Create/Push rows already gate on this reply
  // (`divergenceReady()`), so naming the base costs no extra IPC. FAIL CLOSED:
  // absent means the base is unknown and every caller behaves as it did before
  // this field existed — it is never defaulted to "main".
  base?: string
}

export async function readDivergence(cwd: string, signal?: AbortSignal): Promise<Divergence> {
  // Same single worktree read as readStatus (Tier B item 11): ahead, behind,
  // dirty and the file list all come from ONE `git status --porcelain=v2
  // --branch -z`, and the branch/upstream were resolved there. The two IPCs
  // share the in-flight computation, so a refresh spawns no git command twice.
  // The base is the one addition, and its fast path is a single local
  // `git symbolic-ref`; `gh repo view` runs only when origin/HEAD is unset.
  const [snap, base] = await Promise.all([worktreeSnapshot(cwd), defaultBaseBranch(cwd, signal)])
  const entries = snap.entries
  const bare: Divergence = {
    ahead: 0,
    behind: 0,
    dirty: entries.length > 0,
    changes: entries.length,
    files: porcelainFiles(entries),
    noUpstream: true,
    ...(base === undefined ? {} : { base }),
  }
  // A detached HEAD has no branch to compare; `origin/HEAD..HEAD` is never the
  // right range, so report 0/0 + noUpstream instead of building that ref.
  if (snap.head.branch === undefined) return bare
  if (snap.ahead === undefined || snap.behind === undefined) return bare
  return { ...bare, ahead: snap.ahead, behind: snap.behind, noUpstream: false }
}

type PushPlan = {
  argv: string[]
  // What the panel shows as the push result when git wrote nothing to stdout.
  label: string
}

// A bare `git push` follows `push.default=simple`, which refuses (exit 128,
// "The upstream branch of your current branch does not match…") whenever the
// configured upstream is not a remote ref with the local branch's own name.
// `continue/<stamp>` branches are created with `git switch -c … origin/<base>`
// and therefore start out tracking `origin/<base>`: an upstream exists, so the
// old `hasUpstream ? push : push -u` choice ran the bare form and failed.
// Decide from the branch's own config instead:
//   no upstream              -> `git push -u origin <branch>`
//   merge names this branch   -> `git push` (safe: `simple` accepts it)
//   merge names another ref   -> `git push -u <remote> <branch>` (same remote
//                                as configured, correct name; the `-u` repairs
//                                the upstream to self-tracking so the next push
//                                takes the plain path above)
// The remote is read from `branch.<branch>.remote` verbatim: a remote name may
// contain a slash, so it cannot be derived from the `origin/main`-shaped
// output of `rev-parse @{upstream}`.
async function planPush(cwd: string, branch: string): Promise<PushPlan> {
  const upstream = await run(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    cwd,
    5_000,
  )
  if (!upstream.ok || upstream.out === "") {
    return { argv: ["push", "-u", "origin", branch], label: `pushed -u origin ${branch}` }
  }
  const [remote, merge] = await Promise.all([
    run("git", ["config", "--get", `branch.${branch}.remote`], cwd, 5_000),
    run("git", ["config", "--get", `branch.${branch}.merge`], cwd, 5_000),
  ])
  if (merge.ok && merge.out === `refs/heads/${branch}`) return { argv: ["push"], label: "pushed" }
  const name = remote.ok && remote.out !== "" ? remote.out : "origin"
  return { argv: ["push", "-u", name, branch], label: `pushed -u ${name} ${branch}` }
}

// Two-step backend: the panel sends `confirm: "commit"` only after the user has
// seen the file list. Stages everything except the exclusions above, commits a
// snapshot and pushes. Nothing here force-pushes.
export async function commitAndPush(cwd: string, confirm: string): Promise<string> {
  if (confirm !== "commit") {
    return JSON.stringify({ ok: false, error: "oc-pr-gui refused: no explicit confirmation. No command was run." })
  }
  const head = await branchName(cwd)
  if (head.branch === undefined) {
    return JSON.stringify({ ok: false, error: "Commit + Push refused: HEAD is detached. No command was run." })
  }

  // `raw`: the default trim would strip the leading X-column space off the
  // first entry and shift its path by one character ("pps/...").
  const status = await run("git", ["status", "--porcelain", "-z"], cwd, DEFAULT_TIMEOUT, undefined, true)
  if (!status.ok) {
    // Detail only (`dialog.commitPushFailed` is added by the window). The period
    // is part of the detail because this failure reads as a full sentence in the
    // baseline: "Commit + Push failed: could not read the worktree status (…)."
    // The other failures below stay full sentences, so they travel as `error` and
    // the render site must not wrap them again.
    return JSON.stringify({
      ok: false,
      errorDetail: `could not read the worktree status (${firstLine(status.err) || "git status failed"}).`,
    })
  }
  const entries = parsePorcelain(status.out)
  if (entries.length === 0) {
    return JSON.stringify({ ok: false, error: "Commit + Push: nothing to commit." })
  }
  const paths = Array.from(new Set(entries.filter((entry) => !isExcludedPath(entry.path)).map((entry) => entry.path)))
  if (paths.length === 0) {
    return JSON.stringify({
      ok: false,
      error:
        "Commit + Push refused: every changed file is excluded (.env, .orch/, or a secret-shaped file). No command was run.",
    })
  }

  const added = await run("git", ["add", "-A", "--", ...paths], cwd, 30_000)
  if (!added.ok) {
    return JSON.stringify({
      ok: false,
      error: `Commit + Push failed: git add failed (${firstLine(added.err) || "git add exited non-zero"}).`,
    })
  }
  const staged = await run("git", ["diff", "--cached", "--name-only", "-z"], cwd)
  const committed = staged.ok ? staged.out.split("\0").filter((path) => path !== "").length : 0
  if (!staged.ok || committed === 0) {
    return JSON.stringify({ ok: false, error: "Commit + Push: nothing staged after the exclusions." })
  }

  const commit = await run("git", ["commit", "-m", "chore: wip snapshot (PR panel)"], cwd, 60_000)
  if (!commit.ok) {
    return JSON.stringify({
      ok: false,
      error: `Commit + Push failed after staging ${committed} file(s): git commit failed (${firstLine(commit.err) || "git commit exited non-zero"}).`,
    })
  }

  const plan = await planPush(cwd, head.branch)
  const pushed = await run("git", plan.argv, cwd, 120_000)
  if (!pushed.ok) {
    return JSON.stringify({
      ok: false,
      error: `Committed ${committed} file(s), but push failed: ${firstLine(pushed.err) || "git push exited non-zero"}.`,
    })
  }
  return JSON.stringify({
    ok: true,
    committed,
    pushed: pushed.out || plan.label,
  })
}

export async function pushBranch(cwd: string, confirm: string): Promise<string> {
  if (confirm !== "push") {
    return JSON.stringify({ ok: false, error: "oc-pr-gui refused: no explicit confirmation. No command was run." })
  }
  const head = await branchName(cwd)
  if (head.branch === undefined) {
    return JSON.stringify({ ok: false, error: "Push refused: HEAD is detached. No command was run." })
  }
  const plan = await planPush(cwd, head.branch)
  const pushed = await run("git", plan.argv, cwd, 120_000)
  if (!pushed.ok) {
    // Detail only (`dialog.pushFailed` is added by the window), exactly like the
    // status failure above in `commitAndPush`: the period stays on the detail so
    // a git failure still renders as the baseline sentence "Push failed: ….".
    // The guard refusals further up are full sentences and travel as `error`,
    // which the render site must not wrap.
    return JSON.stringify({ ok: false, errorDetail: `${firstLine(pushed.err) || "git push exited non-zero"}.` })
  }
  return JSON.stringify({ ok: true, pushed: pushed.out || plan.label })
}

// Per-directory auto-fix preference. Main owns the file so every window reads
// the same value; an unreadable file means "off", never a crash.
function autoFixFile(): string {
  const xdg = process.env.XDG_DATA_HOME
  const root = xdg !== undefined && xdg !== "" ? join(xdg, "opencode") : join(homedir(), ".local", "share", "opencode")
  return join(root, "oc-pr-gui-auto-fix.json")
}

function readAutoFixMap(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(readFileSync(autoFixFile(), "utf8")) as unknown
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true) out[key] = true
    }
    return out
  } catch {
    return {}
  }
}

export function autoFixState(directory: string, enabled?: boolean): string {
  const map = readAutoFixMap()
  if (enabled !== undefined) {
    if (enabled) map[directory] = true
    else delete map[directory]
    try {
      mkdirSync(join(autoFixFile(), ".."), { recursive: true })
      writeFileSync(autoFixFile(), `${JSON.stringify(map, null, 2)}\n`, "utf8")
    } catch (e) {
      return JSON.stringify({ enabled: map[directory] === true, error: message(e) })
    }
  }
  return JSON.stringify({ enabled: map[directory] === true })
}

// Per-directory reaper opt-in. Same file shape as the auto-fix map (directory
// -> boolean, XDG-aware) and the same "main owns it so every window agrees"
// rule. A MISSING file means DISABLED, the stranger-safety default: nothing is
// deleted until the user flips the panel's auto-tidy switch once, which writes
// the opt-in. Stored values are obeyed. A file that exists but cannot be read
// or parsed is different: it cannot prove an opt-in, so the reaper fails CLOSED
// (enabled false, known false) instead of guessing. Auto-fix stays
// fail-closed-off for its own reason: its action (running an agent) is not
// reversible by a single command.
function reaperFile(): string {
  const xdg = process.env.XDG_DATA_HOME
  const root = xdg !== undefined && xdg !== "" ? join(xdg, "opencode") : join(homedir(), ".local", "share", "opencode")
  return join(root, "oc-pr-gui-reaper.json")
}

// The tri-state read: absent, stored, or present-but-unreadable. Only a missing
// file is the documented default; parse errors, an unexpected shape and any
// other read failure are "unreadable", never an empty map.
function readReaperSettings(): ReaperSettingsRead {
  let text: string
  try {
    text = readFileSync(reaperFile(), "utf8")
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: "unreadable" }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "unreadable" }
  const map: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "boolean") map[key] = value
  }
  return { kind: "stored", map }
}

// Absence means disabled (default off); an explicit `true` opts this directory
// in; an unreadable file stays off too (fail closed, see reaperPreference).
function reaperEnabled(directory: string): boolean {
  return reaperPreference(readReaperSettings(), directory).enabled
}

export function reaperState(directory: string, enabled?: boolean): string {
  const read = readReaperSettings()
  if (enabled !== undefined) {
    // A corrupt file is replaced only by an explicit user toggle: this path is
    // reached from the switch, so the write is the repair and the requested
    // value wins. The default is OFF, so the ON state is what gets persisted
    // (`true` is the opt-in) and a disable drops the key instead of writing
    // `false` everywhere.
    // Known cost: an explicit toggle on an unparseable file starts from an
    // empty map, so other directories' stored opt-ins are discarded too — the
    // file is unparseable, and this is the only repair path.
    const map = read.kind === "stored" ? read.map : {}
    if (enabled) map[directory] = true
    else delete map[directory]
    try {
      mkdirSync(join(reaperFile(), ".."), { recursive: true })
      writeFileSync(reaperFile(), `${JSON.stringify(map, null, 2)}\n`, "utf8")
      return JSON.stringify({ enabled, known: true })
    } catch (e) {
      // The write did not land, so report the last readable state (fail closed
      // when the file is still unreadable) rather than the requested value.
      return JSON.stringify({ ...reaperPreference(read, directory), error: message(e) })
    }
  }
  return JSON.stringify(reaperPreference(read, directory))
}

// The base comes from gh or origin/HEAD, so validate it before it reaches
// `git switch`: same replay guard as PR refs (no leading "-", safe alphabet).
function checkContinueBase(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = raw.trim()
  const base = trimmed.startsWith("origin/") ? trimmed.slice("origin/".length) : trimmed
  if (base === "" || base.startsWith("-") || !REF_RE.test(base)) {
    return {
      ok: false,
      error: `Continue refused: the base branch \`${trimmed}\` is not a safe ref. No branch was created.`,
    }
  }
  return { ok: true, value: base }
}

// Post-merge base, shared by `continueWork` and `resetWorkspace`: the PR's
// baseRefName when gh resolves it, otherwise the branch behind origin/HEAD,
// otherwise `defaultBaseBranch` (origin/HEAD again, then gh's defaultBranchRef).
// Never guesses a name. The caller validates the result with
// checkContinueBase before it reaches git.
type BaseRefLookup =
  | { ok: true; base: string }
  | { ok: false; kind: "aborted" | "timeout" | "missing"; detail: string }

async function resolveBaseRef(cwd: string, signal?: AbortSignal): Promise<BaseRefLookup> {
  let base: string | undefined
  const pr = await run("gh", ["pr", "view", "--json", "baseRefName"], cwd, DEFAULT_TIMEOUT, signal)
  if (pr.aborted) return { ok: false, kind: "aborted", detail: "cancelled" }
  if (pr.ok) {
    const parsed = parseJson<{ baseRefName?: string }>(pr.out)
    const candidate = typeof parsed?.baseRefName === "string" ? parsed.baseRefName.trim() : ""
    if (candidate !== "") base = candidate
  }
  if (base !== undefined) return { ok: true, base }

  // A merged PR still resolves through gh; this fallback covers a missing PR
  // or a gh failure without guessing a branch name.
  const head = await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], cwd, DEFAULT_TIMEOUT, signal)
  if (head.aborted) return { ok: false, kind: "aborted", detail: "cancelled" }
  // A timeout already spent the whole budget; the shared resolver refuses to
  // fall back after a timeout for the same reason, so stop here too.
  if (head.timedOut) return { ok: false, kind: "timeout", detail: "refs/remotes/origin/HEAD" }
  if (head.ok && head.out !== "") return { ok: true, base: head.out.replace(/^refs\/remotes\//, "") }

  // Wave 5: the SAME resolver the panel uses to decide which branch the
  // Create/Push rows act on (`readDivergence`'s `base`). Coupling them is the
  // point — a base the GUI offers must also resolve in the backend, or the
  // panel offers an action this flow then refuses. Same reasoning as wave 4's
  // note in defaultBaseBranch about agreeing with the reaper. Only reached
  // when the PR base and origin/HEAD both failed, so a repo whose base already
  // resolves takes the identical path as before.
  const shared = await defaultBaseBranch(cwd, signal)
  if (shared !== undefined) return { ok: true, base: shared }
  if (signal?.aborted === true) return { ok: false, kind: "aborted", detail: "cancelled" }
  return { ok: false, kind: "missing", detail: firstLine(head.err) || "no base branch" }
}

// The repository's default branch, usable with NO open PR (unlike
// resolveBaseRef above, whose gh branch needs one). origin/HEAD first — one
// local `git symbolic-ref` — and gh's `defaultBranchRef` only when that ref is
// unset. Never guesses a name: every failure is `undefined`, and a caller that
// sees `undefined` must behave as if the base were unknown.
async function defaultBaseBranch(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  const head = await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], cwd, DEFAULT_TIMEOUT, signal)
  if (head.aborted) return undefined
  if (head.ok) {
    // Same strip as the reaper's tier-one read (`^refs/remotes/<remote>/`): the
    // result must be the BARE branch name so it compares equal to
    // `git branch --show-current` in both the GUI's onBase() and createPr's
    // head == base pre-flight. Stripping only `^refs/remotes/` would yield
    // `origin/main` here and both comparisons would be dead.
    const name = head.out.trim().replace(/^refs\/remotes\/[^/]+\//, "")
    // A bare "origin" cannot be a branch name; drop it instead of returning it.
    if (name !== "" && name !== "origin") return name
  }
  // A timeout already spent the whole budget; falling back would double it.
  if (head.timedOut) return undefined

  const repo = await run("gh", ["repo", "view", "--json", "defaultBranchRef"], cwd, DEFAULT_TIMEOUT, signal)
  if (repo.aborted || !repo.ok) return undefined
  // gh returns the Branch object; a plain string is accepted too so a gh
  // version that flattens the field still resolves.
  const parsed = parseJson<{ defaultBranchRef?: { name?: string } | string | null }>(repo.out)
  const ref = parsed?.defaultBranchRef
  const name = typeof ref === "string" ? ref.trim() : typeof ref?.name === "string" ? ref.name.trim() : ""
  return name === "" ? undefined : name
}

type StashListing =
  | { ok: true; entries: StashEntry[] }
  | { ok: false; aborted: boolean; timedOut: boolean; detail: string }

// `%H %gd %gs`: OID, ref and subject per line. The marker in the subject ties
// an entry to the push that created it, not just to "whatever is newest".
async function stashEntries(cwd: string, signal?: AbortSignal): Promise<StashListing> {
  const list = await run("git", ["stash", "list", "--format=%H %gd %gs"], cwd, DEFAULT_TIMEOUT, signal)
  if (!list.ok) {
    return {
      ok: false,
      aborted: list.aborted === true,
      timedOut: list.timedOut === true,
      detail: failureLine(list.err) || "git stash list exited non-zero",
    }
  }
  const entries: StashEntry[] = []
  for (const line of list.out.split("\n")) {
    const match = line.match(/^([0-9a-f]{7,64}) (stash@\{\d+\})(?: (.*))?$/)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      entries.push({ oid: match[1], ref: match[2], subject: match[3] ?? "" })
    }
  }
  return { ok: true, entries }
}

async function stashLookup(cwd: string, oid: string, signal?: AbortSignal): Promise<StashLookup> {
  const listing = await stashEntries(cwd, signal)
  if (!listing.ok) return { listed: false }
  const entry = listing.entries.find((candidate) => candidate.oid === oid)
  return entry === undefined ? { listed: true } : { listed: true, entry }
}

// ONE read of the worktree status, shared by every flow that must decide
// "is there uncommitted work" before it touches the tree. `zero` selects the
// `-z` form (and verbatim stdout, see `run`) whose entries the counting flows
// parse; the plain form keeps its raw emptiness check. The wording of each
// refusal stays at the call site: this returns only the facts.
type WorktreeRead =
  | { ok: true; entries: PorcelainEntry[]; text: string }
  | { ok: false; kind: "aborted" | "timeout" | "error"; detail: string }

async function readWorktree(cwd: string, zero: boolean, signal?: AbortSignal): Promise<WorktreeRead> {
  const res = await run(
    "git",
    zero ? ["status", "--porcelain", "-z"] : ["status", "--porcelain"],
    cwd,
    DEFAULT_TIMEOUT,
    signal,
    zero,
  )
  if (res.aborted) return { ok: false, kind: "aborted", detail: "" }
  if (res.timedOut) return { ok: false, kind: "timeout", detail: "" }
  if (!res.ok) return { ok: false, kind: "error", detail: firstLine(res.err) || "git status failed" }
  return { ok: true, entries: zero ? parsePorcelain(res.out) : [], text: res.out }
}

// Base resolution failure, shared by both post-merge flows. `kind` names the
// stage so each caller keeps its own sentence; `unsafe` carries both the raw
// base (reset prints it) and the validated refusal (continue prints it).
type BaseFailure =
  | { ok: false; kind: "aborted"; detail: "" }
  | { ok: false; kind: "timeout" | "missing"; detail: string }
  | { ok: false; kind: "unsafe"; base: string; error: string }

// `resolveBaseRef` + `checkContinueBase`: the base is only usable after both
// steps, and every caller refuses on the same three failures.
async function resolveBase(
  cwd: string,
  signal?: AbortSignal,
): Promise<{ ok: true; base: string } | BaseFailure> {
  const lookup = await resolveBaseRef(cwd, signal)
  if (!lookup.ok) {
    if (lookup.kind === "aborted") return { ok: false, kind: "aborted", detail: "" }
    if (lookup.kind === "timeout") return { ok: false, kind: "timeout", detail: lookup.detail }
    return { ok: false, kind: "missing", detail: lookup.detail }
  }
  const checked = checkContinueBase(lookup.base)
  if (!checked.ok) return { ok: false, kind: "unsafe", base: lookup.base.trim(), error: checked.error }
  return { ok: true, base: checked.value }
}

type BaseOutcome =
  | { ok: true; base: string }
  | BaseFailure
  | { ok: false; kind: "fetch-timeout" | "fetch-error"; command: string; detail: string }

// `git fetch` with the three failure branches every caller has to handle.
// `command` is the exact argv for the caller's message.
async function fetchBase(
  cwd: string,
  args: string[],
  timeout: number,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; kind: "aborted" | "timeout" | "error"; command: string; detail: string }> {
  const res = await run("git", args, cwd, timeout, signal)
  const command = `git ${args.join(" ")}`
  if (res.aborted) return { ok: false, kind: "aborted", command, detail: "" }
  if (res.timedOut) return { ok: false, kind: "timeout", command, detail: "" }
  if (!res.ok) return { ok: false, kind: "error", command, detail: firstLine(res.err) || "fetch exited non-zero" }
  return { ok: true }
}

// One base preamble: fetch, then resolve and validate. Only `continueWork` can
// fetch before it knows the base; `resetWorkspace` must validate the base
// first (it cannot fetch `origin <base>` otherwise) and refuses between the
// two, so it composes `resolveBase` + `fetchBase` in its own order.
async function fetchAndResolveBase(
  cwd: string,
  options: { prune: true; base?: never } | { prune?: false; base: string },
  signal?: AbortSignal,
): Promise<BaseOutcome> {
  const args =
    options.prune === true ? ["fetch", "origin", "--prune"] : ["fetch", "origin", options.base]
  const fetched = await fetchBase(cwd, args, DEFAULT_TIMEOUT, signal)
  if (!fetched.ok) {
    if (fetched.kind === "aborted") return { ok: false, kind: "aborted", detail: "" }
    return {
      ok: false,
      kind: fetched.kind === "timeout" ? "fetch-timeout" : "fetch-error",
      command: fetched.command,
      detail: fetched.detail,
    }
  }
  return resolveBase(cwd, signal)
}

type ContinueReply =
  | {
      ok: true
      branch: string
      base: string
      steps?: string[]
      stashed?: string
      // Compact three-way retention wording, computed by the main process from
      // the same lookup as `steps` so the toast cannot claim more than it knows.
      retention?: string
    }
  | {
      ok: false
      error: string
      steps?: string[]
      stashed?: string
      partial?: boolean
      branch?: string
      base?: string
    }

// Post-merge "Continue": never guess with uncommitted work, then start a clean
// branch at the PR's base. A dirty tree without `stash` is refused before fetch
// or switch can touch it.
//
// `stash: true` is the detached-workspace repair: the base is resolved first
// (so a base failure changes nothing), then when the tree is dirty the changes
// are stashed (`-u`, untracked included), the branch flow runs, and the stash is
// restored last by OID (`apply --index`; the entry is retained, never dropped).
// Nothing is forced and nothing is deleted: every restore path leaves the entry
// in place and reports its OID, because the branch itself was created. A
// failure after the stash but before the branch exists restores the worktree
// instead of leaving the changes only in the stack.
// `stash: false`/absent keeps the original refusal and reply shape unchanged.
export async function continueWork(
  cwd: string,
  signal?: AbortSignal,
  stash = false,
  rawBranch?: string,
): Promise<ContinueReply> {
  const steps: string[] = []
  const fail = (error: string): ContinueReply => (stash ? { ok: false, error, steps } : { ok: false, error })
  const done = (branch: string, base: string): ContinueReply =>
    stash ? { ok: true, branch, base, steps } : { ok: true, branch, base }
  // Once the stash exists, every later failure must name it: the user's work
  // is no longer in the worktree. `stashed` is the immutable OID; the ref is
  // only a convenience for this moment, since the shared stack can shift.
  let stashOid: string | undefined
  let stashRef: string | undefined
  const stashNote = (error: string): string =>
    stashOid === undefined
      ? error
      : `${error} Your changes are safe in the stash entry ${stashRef ?? ""} (${stashOid}); run \`git stash apply --index ${stashOid}\` after resolving.`

  // The dialog can name the branch. This validation runs before ANY mutation —
  // no fetch, no stash, no switch — so a bad or taken name leaves the worktree
  // exactly as it was. The second stage of it is a read-only `git
  // check-ref-format --branch`, which is what makes "invalid" mean git's own
  // grammar rather than REF_RE's approximation of it. A blank name falls
  // through to the timestamped default.
  let named: string | undefined
  if (rawBranch !== undefined && rawBranch.trim() !== "") {
    const checked = await checkBranchName(cwd, rawBranch, signal)
    if (!checked.ok) return fail(checked.error)
    // `branch --list` reads refs/heads and exits 0 either way, so "absent" is
    // an empty line list rather than a non-zero exit that `run` would report as
    // an error. User-supplied names make collisions far likelier than the
    // timestamped default, and `git switch -c` would fail only after the stash.
    const existing = await run(
      "git",
      ["branch", "--list", "--format=%(refname:short)", checked.value],
      cwd,
      DEFAULT_TIMEOUT,
      signal,
    )
    if (existing.aborted) return fail("Continue cancelled. No branch was created.")
    if (!existing.ok) {
      return fail(
        `Continue failed: could not check whether \`${checked.value}\` already exists (${firstLine(existing.err) || "git branch --list exited non-zero"}). No branch was created.`,
      )
    }
    if (existing.out !== "") {
      return fail(
        `Continue refused: the branch \`${checked.value}\` already exists. Pick another name. No branch was created.`,
      )
    }
    named = checked.value
  }

  // `-z` + raw only for the stash path, where the entry count is reported; the
  // default path keeps its original command and emptiness check exactly.
  const dirty = await readWorktree(cwd, stash, signal)
  if (!dirty.ok) {
    if (dirty.kind === "aborted") {
      return fail(
        stash
          ? "Continue cancelled before the worktree could be read. No branch was created."
          : "Continue cancelled. No branch was created.",
      )
    }
    if (dirty.kind === "timeout") {
      return fail("Continue failed: `git status --porcelain` timed out. No branch was created.")
    }
    return fail(
      `Continue failed: could not read the worktree status (${dirty.detail}). No branch was created.`,
    )
  }
  const entries = dirty.entries
  const isDirty = stash ? entries.length > 0 : dirty.text !== ""
  if (isDirty && !stash) {
    return fail(
      "Continue refused: the worktree has uncommitted changes. Commit or stash them before continuing. No branch was created.",
    )
  }

  // 1. Resolve the base BEFORE stashing. `git fetch` never reads or writes the
  // worktree, so the two are order-independent — and this order makes a base
  // failure a clean no-op. Resolving second used to run `stash push -u` first,
  // which removes the changes from the worktree, and then fail before any
  // branch existed to carry them: the work was left only in the stash stack.
  const baseRead = await fetchAndResolveBase(cwd, { prune: true }, signal)
  if (!baseRead.ok) {
    // No stash can exist yet, so these messages never need the stash note.
    if (baseRead.kind === "aborted") return fail("Continue cancelled. No branch was created.")
    if (baseRead.kind === "fetch-timeout") {
      return fail(`Continue failed: \`${baseRead.command}\` timed out. No branch was created.`)
    }
    if (baseRead.kind === "fetch-error") {
      return fail(`Continue failed: \`${baseRead.command}\` failed (${baseRead.detail}). No branch was created.`)
    }
    if (baseRead.kind === "timeout") {
      return fail("Continue failed: resolving `refs/remotes/origin/HEAD` timed out. No branch was created.")
    }
    if (baseRead.kind === "unsafe") return fail(baseRead.error)
    return fail(
      `Continue failed: could not resolve the PR base or origin/HEAD (${baseRead.detail}). No branch was created.`,
    )
  }
  const target = baseRead.base

  // 2. Stash next, while the branch flow has not touched the tree yet. The
  // stack is shared: record what is there now, and after the push only accept
  // a NEW entry carrying our marker, identified by OID.
  if (stash) {
    if (isDirty) {
      const marker = `oc-pr auto-stash ${new Date().toISOString()}`
      const beforePush = await stashEntries(cwd, signal)
      if (!beforePush.ok) {
        if (beforePush.aborted) {
          return fail("Continue cancelled before `git stash push`. No branch was created.")
        }
        if (beforePush.timedOut) {
          return fail("Continue failed: `git stash list` timed out before stashing. No branch was created.")
        }
        return fail(
          `Continue failed: could not read the stash list before stashing (${beforePush.detail}). No branch was created.`,
        )
      }
      const known = new Set(beforePush.entries.map((entry) => entry.oid))
      const stashed = await runStep(
        "git",
        ["stash", "push", "-u", "-m", marker],
        { cwd, signal },
        {
          aborted:
            "Continue cancelled during `git stash push`. Your changes are either still in the worktree or in a stash entry; run `git stash list` to check. No branch was created.",
          timeout:
            "Continue failed: `git stash push -u` timed out. Run `git stash list` to check whether an entry was created. No branch was created.",
          error: (stderr) =>
            `Continue failed: \`git stash push -u\` failed (${failureLine(stderr) || "git stash exited non-zero"}). No branch was created.`,
        },
      )
      if (!stashed.ok) {
        // `stash push` can exit non-zero AFTER it moved the changes into an
        // entry (a post-save cleanup failure). Treating that as "nothing was
        // saved" would strand the work in the stack with no way back, so a
        // plain error reconciles the stack exactly as the success path does:
        // find OUR entry by marker plus a new OID, then restore it. The read
        // and the restore ignore the signal on purpose — a cancelled run must
        // not block recovery, the same choice the switch-failure repair makes.
        // Abort/timeout keep their own wording: they already point at
        // `git stash list`, and git may have been killed mid-write.
        if (stashed.kind !== "error") return fail(stashed.message)
        const afterFailure = await stashEntries(cwd, undefined)
        const saved =
          afterFailure.ok
            ? afterFailure.entries.find((entry) => entry.subject.includes(marker) && !known.has(entry.oid))
            : undefined
        if (saved === undefined) {
          return fail(
            `${stashed.message} Could not identify a stash entry created by this run; run \`git status\` and \`git stash list\` to check whether your changes were saved.`,
          )
        }
        stashOid = saved.oid
        stashRef = saved.ref
        const restored = await run("git", ["stash", "apply", "--index", saved.oid], cwd, DEFAULT_TIMEOUT, undefined)
        return fail(
          restored.ok
            ? `${stashed.message} git had already saved your changes to the stash; they were restored to the worktree and the stash entry ${saved.ref} (${saved.oid}) is still listed.`
            : stashNote(stashed.message),
        )
      }
      const afterPush = await stashEntries(cwd, signal)
      if (!afterPush.ok) {
        return fail(
          `Continue failed: \`git stash push -u\` ran, but the new stash entry could not be listed (${afterPush.detail}). Run \`git stash list\` to find it. No branch was created.`,
        )
      }
      const created = afterPush.entries.find(
        (entry) => entry.subject.includes(marker) && !known.has(entry.oid),
      )
      // A bare "push succeeded" is not proof that anything was saved. Without a
      // new OID there is no identity to restore, so stop instead of guessing.
      if (created === undefined) {
        return fail(
          "Continue failed: `git stash push -u` reported success but created no new stash entry. Your changes may still be in the worktree; run `git status` and `git stash list` to check. No branch was created.",
        )
      }
      stashOid = created.oid
      stashRef = created.ref
      steps.push(`Stashed ${entries.length} uncommitted change(s) as ${created.ref} (${created.oid.slice(0, 12)})`)
    } else {
      steps.push("Nothing to stash — the worktree is clean.")
    }
  }

  const branch = named ?? `continue/${continueStamp()}`
  const switched = await runStep(
    "git",
    ["switch", "-c", branch, `origin/${target}`],
    { cwd, signal },
    {
      aborted: "Continue cancelled.",
      timeout: `Continue failed: \`git switch -c ${branch} origin/${target}\` timed out.`,
      error: (stderr) =>
        `Continue failed: \`git switch -c ${branch} origin/${target}\` failed (${firstLine(stderr) || "switch exited non-zero"}).`,
    },
  )
  if (!switched.ok) {
    // This is the only failure left between the stash and its restore, so undo
    // it here: no branch was created to carry the changes, and leaving them
    // solely in the stack would strand them. `apply --index` replays the same
    // commit and its staged/unstaged split, and keeps the entry listed. A
    // cancelled signal must not block the repair, so this run ignores it.
    if (stashOid === undefined) return fail(switched.message)
    const oid = stashOid
    const restored = await run("git", ["stash", "apply", "--index", oid], cwd, DEFAULT_TIMEOUT, undefined)
    return fail(
      restored.ok
        ? `${switched.message} Your changes were restored to the worktree; the stash entry ${stashRef ?? ""} (${oid}) is still listed.`
        : stashNote(switched.message),
    )
  }

  if (stash) steps.push(`Created ${branch} from origin/${target}`)
  // 3. Restore last, by identity: `apply --index` replays the exact commit and
  // its staged/unstaged split. The entry is never dropped — resolving a ref and
  // dropping it are separate git invocations, and a concurrent workspace can
  // shift positions in between, so a drop could delete someone else's work.
  // Retention is a duplicate, not a loss. A failed apply keeps the entry too.
  if (stashOid !== undefined) {
    const oid = stashOid
    const applied = await run("git", ["stash", "apply", "--index", oid], cwd, DEFAULT_TIMEOUT, signal)
    if (applied.ok) {
      // Report where the retained entry sits right now; the ref is never
      // reused, and a failed listing is not evidence the entry is gone. The
      // toast carries the same read in compact form, so it never asserts
      // "retained" when this lookup failed or found the entry gone.
      const lookup = await stashLookup(cwd, oid, signal)
      steps.push(retainedStashNote(lookup, oid))
      return {
        ok: true,
        branch,
        base: target,
        steps,
        stashed: oid,
        retention: retainedStashNote(lookup, oid, true),
      }
    }

    const reason = applied.aborted
      ? "the restore was interrupted"
      : applied.timedOut
        ? "`git stash apply --index` timed out"
        : failureLine(applied.err) ||
          (/CONFLICT/i.test(applied.out) ? "the stash did not apply cleanly (conflict)" : firstLine(applied.out)) ||
          "git stash apply --index exited non-zero"
    // Never assert safety on assumption. Verify the OID is still listed; the
    // abort signal may already be cancelled, so this read runs without it.
    const verified = await stashLookup(cwd, oid, undefined)
    // The advice depends on WHICH stage failed: an index-stage refusal applied
    // nothing and loops on `--index`, so the plain apply is the only command
    // that can make progress there. See `recoveryCommand`.
    const recovery = recoveryCommand(applied.err, oid)
    const head = `Branch ${branch} was created from origin/${target}, but restoring the stashed changes failed (${reason}).`
    const suffix =
      verified.entry !== undefined
        ? `No changes were lost: your changes are safe in the stash entry ${verified.entry.ref} (${oid}); run ${recovery}`
        : verified.listed
          ? `The stash entry ${oid} is no longer listed by \`git stash list\`; run \`git status\` to check whether your changes are in the worktree.`
          : `Could not verify retention of the stash entry ${oid} — the \`git stash list\` check failed. Check \`git stash list\` yourself; the entry was created as ${oid} and this flow dropped nothing. Run ${recovery}`
    return {
      ok: false,
      partial: true,
      branch,
      base: target,
      stashed: oid,
      error: `${head} ${suffix}`,
      steps,
    }
  }

  return done(branch, target)
}

// Enumeration result for `worktreeHoldingBranch`. "The listing failed" is its
// own outcome, distinct from "no worktree holds it": the delete path runs
// `git update-ref`, which has no checkout protection of its own, so there an
// unreadable list must be refused rather than read as unheld. The switch path
// keeps the old permissive reading, because git's own `switch` refuses a held
// branch regardless of what this enumeration said.
export type BranchHolderLookup =
  | { ok: true; path?: string }
  | { ok: false; detail: string; aborted: boolean }

// Every branch checked out anywhere in this repository, as branch -> worktree
// path. ONE `git worktree list` read shared by the reset's single-branch lookup
// and the reaper's whole-list scan. "The listing failed" stays its own outcome:
// `git update-ref -d` has no checkout protection of its own, so a failed read
// must be refused rather than read as "nothing is held".
type WorktreeHolders =
  | { ok: true; holders: Map<string, string> }
  | { ok: false; detail: string; aborted: boolean }

async function worktreeHolders(cwd: string, signal?: AbortSignal): Promise<WorktreeHolders> {
  const list = await run("git", ["worktree", "list", "--porcelain"], cwd, 5_000, signal)
  if (!list.ok) {
    return {
      ok: false,
      detail:
        firstLine(list.err) ||
        (list.aborted === true
          ? "cancelled"
          : list.timedOut === true
            ? "git worktree list timed out"
            : "git worktree list exited non-zero"),
      aborted: list.aborted === true,
    }
  }
  return { ok: true, holders: parseWorktreeList(list.out) }
}

// Porcelain blocks are separated by a blank line; `branch refs/heads/<name>`
// appears exactly for an attached worktree. First block for a branch wins, so
// this keeps the single-branch lookup's original "first match" answer.
function parseWorktreeList(raw: string): Map<string, string> {
  const holders = new Map<string, string>()
  for (const block of raw.split("\n\n")) {
    const lines = block.split("\n")
    const pathLine = lines.find((line) => line.startsWith("worktree "))
    const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"))
    if (pathLine === undefined || branchLine === undefined) continue
    const branch = branchLine.slice("branch refs/heads/".length)
    if (branch === "" || holders.has(branch)) continue
    holders.set(branch, pathLine.slice("worktree ".length))
  }
  return holders
}

// Path of the worktree that currently holds `branch` checked out, if any.
// git's own list decides the switch strategy in `resetWorkspace`, whose HEAD is
// the feature branch (step 1), so an entry for <base> names a different
// worktree.
async function worktreeHoldingBranch(
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<BranchHolderLookup> {
  const list = await worktreeHolders(cwd, signal)
  if (!list.ok) return { ok: false, detail: list.detail, aborted: list.aborted }
  const path = list.holders.get(branch)
  return path === undefined ? { ok: true } : { ok: true, path }
}

// Compare-and-swap delete of ONE local branch at a commit GitHub confirmed
// merged. Extracted from `resetWorkspace` so the reaper runs the same sequence
// — pre-check, CAS, post-check, zero-OID heal — instead of a second, weaker
// copy. The helper reports facts only; each caller keeps its own sentences and
// its own `steps`.
//
// `git update-ref -d` ignores worktrees, so the checkout git would refuse on is
// enumerated explicitly on both sides of the CAS: before it (a holder or a
// failed listing refuses) and after it (a holder or a failed listing restores
// the ref). The restore is a non-clobbering CAS-create: expected-old is the
// zero OID, so it only creates the ref while it is absent.
export type CasDeleteOutcome =
  | { ok: true }
  | { ok: false; kind: "aborted"; command: string }
  | { ok: false; kind: "timeout"; command: string }
  | { ok: false; kind: "pre-unreadable"; detail: string }
  | { ok: false; kind: "pre-held"; path: string }
  | { ok: false; kind: "moved"; detail: string }
  | { ok: false; kind: "refused"; detail: string }
  | { ok: false; kind: "post-check"; why: string; heal: "restored" | "exists" | "failed"; detail?: string }

async function casDeleteVerifiedBranch(
  cwd: string,
  branch: string,
  oid: string,
  signal?: AbortSignal,
): Promise<CasDeleteOutcome> {
  const ref = `refs/heads/${branch}`
  const command = `git update-ref -d ${ref} ${oid}`
  // Pre-check, immediately before the CAS: "unknown" is not "unheld".
  const pre = await worktreeHoldingBranch(cwd, branch, signal)
  if (!pre.ok) return { ok: false, kind: "pre-unreadable", detail: pre.detail }
  if (pre.path !== undefined) return { ok: false, kind: "pre-held", path: pre.path }
  const cas = await run("git", ["update-ref", "-d", ref, oid], cwd, DEFAULT_TIMEOUT, signal)
  if (cas.aborted) return { ok: false, kind: "aborted", command }
  if (cas.timedOut) return { ok: false, kind: "timeout", command }
  if (!cas.ok) {
    const detail = failureLine(cas.err) || "git update-ref -d exited non-zero"
    // git's own CAS failure: "… is at <new> but expected <old>".
    return /but expected/i.test(cas.err)
      ? { ok: false, kind: "moved", detail }
      : { ok: false, kind: "refused", detail }
  }
  // Post-check: a worktree can pick the branch up between the pre-check and the
  // CAS, and the CAS compares the OID only, never worktree HEADs. One pre-check,
  // one CAS, one post-check, no retry loop.
  const post = await worktreeHoldingBranch(cwd, branch, signal)
  if (post.ok && post.path === undefined) return { ok: true }
  const why = post.ok
    ? `a worktree started using \`${branch}\` while it was being deleted (${post.path})`
    : `could not enumerate worktrees after deleting \`${branch}\` (${post.detail}), so a checkout cannot be ruled out`
  const zero = "0000000000000000000000000000000000000000"
  const heal = await run("git", ["update-ref", ref, oid, zero], cwd, DEFAULT_TIMEOUT, signal)
  if (heal.ok) return { ok: false, kind: "post-check", why, heal: "restored" }
  // The zero-OID CAS-create refused because the ref exists again — git prints
  // "… is at <new> but expected 0000…" or "reference already exists" depending
  // on version — so it is left exactly as found (never overwritten).
  if (/but expected|already exists/i.test(heal.err)) {
    return { ok: false, kind: "post-check", why, heal: "exists" }
  }
  const detail = failureLine(heal.err) || (heal.timedOut ? "git update-ref timed out" : "git update-ref exited non-zero")
  return { ok: false, kind: "post-check", why, heal: "failed", detail }
}

// Guarded post-merge reset. Strictly ordered and stops at the first failure:
// 1) on a branch, 2) clean worktree, 3) commits outside origin/<base>, 4) switch
// to <base> and fast-forward only — or, when <base> is checked out in another
// worktree, land detached on origin/<base>, 5) delete the feature branch — by
// git's own merged check, or by a compare-and-swap on the commit GitHub
// confirmed merged, 6) prune stale worktree markers.
//
// Step 3 has two outcomes. Nothing ahead of origin/<base>: the branch is
// merged by git's own definition and nothing else is consulted. Something
// ahead: that alone cannot distinguish unmerged work from a squash merge, so
// `number` names the PR and one `gh pr view` decides — MERGED, same head
// branch, same head commit, or the reset refuses. No `number`, a gh failure or
// any mismatch refuses (fail closed), which is the pre-gh behaviour.
//
// Never touches remote refs and never removes a worktree directory: the
// unlinking cases are limited to a local branch that is either merged per git
// (`-d`) or confirmed merged on GitHub at the same commit (`-D`). `worktree
// prune` only drops administrative entries whose directory is already gone —
// this session's worktree directory is its cwd and must stay.
export async function resetWorkspace(
  cwd: string,
  confirm: string,
  signal?: AbortSignal,
  number?: number,
): Promise<string> {
  const steps: string[] = []
  const fail = (error: string) => JSON.stringify({ ok: false, error, steps })
  // Cancellation is not "nothing happened": a bounded command can finish just
  // as the abort lands, so name where it happened and keep `steps`.
  const cancelText = (command: string) =>
    `Reset cancelled during \`${command}\`. The interrupted command may still have completed; completed steps are listed above. Re-run Reset workspace to reconcile.`
  const cancel = (command: string) => fail(cancelText(command))
  if (confirm !== "reset") return fail("Reset refused: no explicit confirmation. No command was run.")

  // 1. A detached HEAD has no feature branch to compare or delete.
  const head = await branchName(cwd, signal)
  if (head.branch === undefined) {
    return fail("Reset refused: HEAD is detached, so there is no branch to reset. No command was run.")
  }
  const feature = head.branch

  // 2. Uncommitted work would be left behind on a branch that disappears.
  const status = await readWorktree(cwd, true, signal)
  if (!status.ok) {
    if (status.kind === "aborted") return cancel("git status --porcelain")
    if (status.kind === "timeout") return fail("Reset failed: `git status --porcelain` timed out. No command was run.")
    return fail(
      `Reset failed: could not read the worktree status (${status.detail}). No command was run.`,
    )
  }
  const entries = status.entries
  if (entries.length > 0) {
    const shown = entries.slice(0, 10).map((entry) => `${entry.status} ${entry.path}`)
    const more = entries.length > shown.length ? `\n…and ${entries.length - shown.length} more` : ""
    return fail(
      `Reset refused: the worktree has ${entries.length} uncommitted change(s). Commit or stash them first.\n${shown.join("\n")}${more}`,
    )
  }

  // 3. Base first, then fetch it: the count below must be measured against the
  // remote default/base, not a stale local ref.
  const resolved = await resolveBase(cwd, signal)
  if (!resolved.ok) {
    if (resolved.kind === "aborted") return cancel("resolving the base branch")
    if (resolved.kind === "timeout") {
      return fail("Reset failed: resolving `refs/remotes/origin/HEAD` timed out. No command was run.")
    }
    if (resolved.kind === "unsafe") {
      return fail(`Reset refused: the base branch \`${resolved.base}\` is not a safe ref. No command was run.`)
    }
    return fail(
      `Reset failed: could not resolve the PR base or origin/HEAD (${resolved.detail}). No command was run.`,
    )
  }
  const base = resolved.base
  if (feature === base) {
    return fail(`Reset refused: the current branch is \`${base}\` itself, so there is nothing to reset. No command was run.`)
  }

  const fetched = await fetchBase(cwd, ["fetch", "origin", base], 30_000, signal)
  if (!fetched.ok) {
    if (fetched.kind === "aborted") return cancel(fetched.command)
    if (fetched.kind === "timeout") {
      return fail(`Reset failed: \`${fetched.command}\` timed out. No command was run.`)
    }
    return fail(
      `Reset failed: \`${fetched.command}\` failed (${fetched.detail}). No command was run.`,
    )
  }
  steps.push(`Fetched origin/${base}`)

  const count = await runStep(
    "git",
    ["rev-list", "--count", `origin/${base}..${feature}`],
    { cwd, signal },
    {
      aborted: cancelText(`git rev-list --count origin/${base}..${feature}`),
      timeout: "Reset failed: counting commits ahead of the remote base timed out. No command was run.",
      error: (stderr) =>
        `Reset failed: could not count commits on \`${feature}\` outside origin/${base} (${firstLine(stderr) || "git rev-list exited non-zero"}). No command was run.`,
    },
  )
  if (!count.ok) return fail(count.message)
  const ahead = Number.parseInt(count.out, 10)
  if (!Number.isFinite(ahead)) {
    return fail(`Reset failed: could not read the commit count for \`${feature}\`. No command was run.`)
  }
  // Only a branch that is *not* merged per git needs GitHub's opinion, so the
  // fast path stays exactly as it was: no gh call, no force-delete.
  let forceDelete = false
  // The exact commit GitHub confirmed merged. Carried all the way to the delete
  // step, where it is the expected value of a compare-and-swap: if the ref
  // moved between verification and deletion (another process, a hook), the CAS
  // fails and nothing is removed.
  let verifiedOid: string | undefined
  if (ahead > 0) {
    // A squash merge leaves no trace of the head commit in origin/<base>, so
    // the count cannot tell it apart from unmerged work. One fresh read of the
    // PR is the authority. Without a number there is nothing to ask about, so
    // the verdict refuses with the unchanged count message.
    let pr: ResetPrFacts | undefined
    const prNumber = number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined
    if (prNumber !== undefined) {
      const viewed = await runStep(
        "gh",
        ["pr", "view", String(prNumber), "--json", "state,headRefName,headRefOid,mergedAt"],
        { cwd, signal },
        {
          aborted: cancelText(`gh pr view ${prNumber}`),
          timeout: (stderr) =>
            `Reset refused: could not read PR #${prNumber} from GitHub (${firstLine(stderr) || "gh pr view timed out"}). No branch was deleted.`,
          error: (stderr) =>
            `Reset refused: could not read PR #${prNumber} from GitHub (${firstLine(stderr) || "gh pr view exited non-zero"}). No branch was deleted.`,
        },
      )
      if (!viewed.ok) return fail(viewed.message)
      pr = resetPrFacts(parseJson<unknown>(viewed.out))
      if (pr === undefined) {
        return fail(
          `Reset refused: could not parse \`gh pr view ${prNumber}\`, so its merge state is unknown. No branch was deleted.`,
        )
      }
    }
    // The local tip is only read on this path, and a failed read is passed
    // through as "unknown" so the verdict refuses instead of comparing blanks.
    let localTip: string | undefined
    if (prNumber !== undefined) {
      const tip = await run("git", ["rev-parse", "--verify", `refs/heads/${feature}`], cwd, DEFAULT_TIMEOUT, signal)
      if (tip.aborted) return cancel(`git rev-parse refs/heads/${feature}`)
      if (tip.ok && tip.out.trim() !== "") localTip = tip.out.trim()
    }
    const verdict = resetVerdict({ ahead, number: prNumber, pr, localTip, feature, base })
    if (!verdict.proceed) return fail(verdict.reason ?? "Reset refused: the branch is not confirmed merged. No branch was deleted.")
    forceDelete = verdict.forceDelete
    // Only a verified delete is carried forward; `ahead == 0` never sets this
    // and keeps `git branch -d`.
    verifiedOid = verdict.forceDelete ? localTip : undefined
    if (forceDelete && localTip !== undefined && prNumber !== undefined) {
      steps.push(`Verified PR #${prNumber} merged on GitHub (head ${localTip.slice(0, 7)})`)
    }
  }

  // 4. Local base must be current. The usual path is `git switch <base>` then a
  // fast-forward only merge. In a linked worktree the base is commonly checked
  // out in the main working tree, where git refuses the switch; that is not a
  // failure to force through — land on origin/<base> detached instead, which is
  // the same content without touching the other worktree.
  // git's own `switch` is the protection on this path, so a failed enumeration
  // keeps the old permissive reading: treat the branch as not held and let
  // `git switch` refuse it, whose message is parsed just below. The delete path
  // below is the opposite — it cannot rely on git to check worktrees.
  const baseHolder = await worktreeHoldingBranch(cwd, base, signal)
  let elsewhere: string | undefined = baseHolder.ok ? baseHolder.path : undefined
  let detached = elsewhere !== undefined
  if (!detached) {
    const switched = await run("git", ["switch", base], cwd, 60_000, signal)
    if (switched.aborted) return cancel(`git switch ${base}`)
    if (switched.timedOut) return fail(`Reset failed: \`git switch ${base}\` timed out. No branch was deleted.`)
    if (switched.ok) {
      steps.push(`Switched to ${base}`)
    } else {
      // Older git wording ("already used by worktree at") is the same state.
      const parsed = /(?:already checked out at|already used by worktree at) '([^']+)'/.exec(switched.err)?.[1]
      if (parsed === undefined) {
        return fail(
          `Reset failed: could not switch to \`${base}\` (${failureLine(switched.err) || "git switch exited non-zero"}). No branch was deleted.`,
        )
      }
      elsewhere = parsed
      detached = true
    }
  }

  if (detached) {
    const landed = await runStep(
      "git",
      ["switch", "--detach", `origin/${base}`],
      { cwd, timeout: 60_000, signal },
      {
        aborted: cancelText(`git switch --detach origin/${base}`),
        timeout: `Reset failed: \`git switch --detach origin/${base}\` timed out. No branch was deleted.`,
        error: (stderr) =>
          `Reset failed: could not switch to \`${base}\` (${base} is checked out in ${elsewhere ?? "another worktree"}) and \`git switch --detach origin/${base}\` also failed (${failureLine(stderr) || "switch exited non-zero"}). No branch was deleted.`,
      },
    )
    if (!landed.ok) return fail(landed.message)
    // Detached at origin/<base> is already the remote content; the merge step
    // below would be a no-op, so it is skipped and the step says why.
    steps.push(`Switched to origin/${base} (detached — ${base} is checked out in ${elsewhere ?? "another worktree"})`)
  }

  if (!detached) {
    const fastForward = await runStep(
      "git",
      ["merge", "--ff-only", `origin/${base}`],
      { cwd, timeout: 60_000, signal },
      {
        aborted: cancelText(`git merge --ff-only origin/${base}`),
        timeout: `Reset failed: \`git merge --ff-only origin/${base}\` timed out. No branch was deleted.`,
        error: (stderr) =>
          `Reset stopped: local \`${base}\` is not a fast-forward of origin/${base} (${failureLine(stderr) || "git merge --ff-only exited non-zero"}). Nothing was forced; resolve that divergence manually.`,
      },
    )
    if (!fastForward.ok) return fail(fastForward.message)
    steps.push(`Fast-forwarded ${base} to origin/${base}`)
  }

  // 5. Two delete routes, both refusing rather than forcing.
  //   - `ahead == 0`: `git branch -d`, git's own merged check as the backstop.
  //   - verified merge: the branch's content is not in the base history, so
  //     `-d` would refuse and `-D` would remove whatever the ref points at by
  //     the time it runs. Instead the delete is a compare-and-swap on the exact
  //     commit GitHub confirmed merged: `git update-ref -d` succeeds only while
  //     the ref still equals `verifiedOid`. A ref that moved in the meantime
  //     fails the CAS and is left alone (nothing is re-verified or retried).
  // `update-ref -d` ignores worktrees, so the checkout git would refuse on is
  // enumerated explicitly on both sides of the CAS: before it (a holder or a
  // failed listing refuses) and after it (a holder or a failed listing restores
  // the ref). See the residual note at the end of that branch.
  if (verifiedOid !== undefined) {
    // The sequence and every refusal live in casDeleteVerifiedBranch; only the
    // sentences and the `steps` entry stay here, because they name this flow.
    const cas = await casDeleteVerifiedBranch(cwd, feature, verifiedOid, signal)
    if (!cas.ok) {
      switch (cas.kind) {
        case "aborted":
          return cancel(cas.command)
        case "timeout":
          // Deliberately the baseline sentence: it names the ref only, with no
          // expected OID, so the user-facing first line stays what it was
          // before this flow moved into casDeleteVerifiedBranch. The OID is
          // still in `cas.command` for the reaper's own log line.
          return fail(`Reset failed: \`git update-ref -d refs/heads/${feature}\` timed out.`)
        case "pre-unreadable":
          return fail(
            `Reset refused: could not enumerate worktrees before deleting \`${feature}\` (${cas.detail}), so a checkout cannot be ruled out. No branch was deleted.`,
          )
        case "pre-held":
          return fail(
            `Reset refused: \`${feature}\` is checked out in ${cas.path}, so it was not deleted. Nothing was forced.`,
          )
        case "moved":
          return fail(
            `Reset refused: \`${feature}\` moved after verification (expected ${verifiedOid}; ${cas.detail}). No branch was deleted — re-run Reset workspace to verify the new tip.`,
          )
        case "refused":
          return fail(
            `Reset stopped: could not delete \`${feature}\` at the verified commit (${cas.detail}); nothing else was forced.`,
          )
        case "post-check":
          if (cas.heal === "restored") {
            steps.push(`Restored refs/heads/${feature} at ${verifiedOid.slice(0, 7)}`)
            return fail(`Reset refused: ${cas.why}, so \`refs/heads/${feature}\` was restored at ${verifiedOid}.`)
          }
          if (cas.heal === "exists") {
            return fail(
              `Reset refused: ${cas.why}, and \`refs/heads/${feature}\` already exists again, so it was left untouched (never overwritten). Verify its tip with \`git log -1 ${feature}\` before continuing.`,
            )
          }
          // Loud by design: the branch was deleted and the restore did not happen.
          return fail(
            `Reset refused: ${cas.why}, and restoring \`refs/heads/${feature}\` at ${verifiedOid} FAILED (${cas.detail}). The ref is not restored — check \`git branch --list ${feature}\` and re-create it with \`git branch ${shellQuote(feature)} ${verifiedOid}\` if it is missing.`,
          )
      }
    }
    // Residual, stated precisely: a checkout landing between this post-check and
    // the function returning is the same check-then-act window `git branch
    // -d/-D` has (git lists worktrees, then unlinks). No git primitive here
    // closes it atomically. The CAS still makes this path strictly safer than
    // `-D`: `-D` would delete whatever the ref pointed at, while the CAS refuses
    // a moved ref and the post-check restores a ref that a checkout picked up
    // mid-delete.
  } else {
    const deleted = await runStep(
      "git",
      ["branch", "-d", feature],
      { cwd, signal },
      {
        aborted: cancelText(`git branch -d ${feature}`),
        timeout: `Reset failed: \`git branch -d ${feature}\` timed out.`,
        error: (stderr) =>
          `Reset stopped: git refused to delete \`${feature}\` (${failureLine(stderr) || "git branch -d exited non-zero"}); nothing was forced.`,
      },
    )
    if (!deleted.ok) return fail(deleted.message)
  }
  steps.push(`Deleted ${feature}`)

  // 6. Dead markers only. The worktree directory is this session's cwd, so it is
  // never removed here (`git worktree remove` is deliberately not called).
  const pruned = await runStep(
    "git",
    ["worktree", "prune"],
    { cwd, signal },
    {
      aborted: cancelText("git worktree prune"),
      timeout: "Reset stopped: `git worktree prune` timed out.",
      error: (stderr) =>
        `Reset stopped: \`git worktree prune\` failed (${firstLine(stderr) || "git worktree prune exited non-zero"}).`,
    },
  )
  if (!pruned.ok) return fail(pruned.message)
  steps.push("Pruned stale worktree markers")

  return JSON.stringify({ ok: true, steps })
}

// ---- Reaper: one pass over merged PR branches ------------------------------
// Deletes only local branches whose tip is EXACTLY the merged PR's head commit:
// that commit is already on GitHub, so nothing can be unpushed. Never switches
// branches, never touches the checked-out or a worktree-held branch, never
// removes a worktree directory (`git worktree prune` only drops administrative
// entries for directories that are already gone), and caps one pass at
// REAP_CAP deletions.
//
// Every delete runs through casDeleteVerifiedBranch — the same pre-check, CAS,
// post-check and zero-OID heal `resetWorkspace` uses — so a ref that moved and a
// ref a worktree picked up mid-delete are handled identically. Skips are
// computed by reapVerdict BEFORE any delete runs and a gh failure returns an
// empty pass, never a partial one. The integration branch may itself be
// nonstandard, so its name is read from origin/HEAD with a gh defaultBranchRef
// fallback; when neither is readable the whole pass aborts with zero deletes
// rather than protect nothing.
//
// Each reaped entry carries its exact restore command. `error` is the one
// additive field: present when a read failed or a delete could not be carried
// out, absent on a clean pass.
export async function reapBranches(cwd: string, signal?: AbortSignal): Promise<string> {
  const stopped = (error: string) => JSON.stringify({ reaped: [], skipped: [], truncated: false, error })
  // The opt-in is enforced here too, not only by the window that polls: a
  // stale window must not be able to delete after the user turned this off.
  if (!reaperEnabled(cwd)) {
    return JSON.stringify({ reaped: [], skipped: [], truncated: false, enabled: false })
  }

  const [refs, current, worktrees, origin, head] = await Promise.all([
    run(
      "git",
      ["for-each-ref", "refs/heads", "--format=%(refname:short)%00%(objectname)%00%(upstream:short)"],
      cwd,
      DEFAULT_TIMEOUT,
      signal,
    ),
    // `--show-current` prints nothing for a detached HEAD, and then NO branch
    // is current — the empty string must never be treated as a branch name.
    run("git", ["branch", "--show-current"], cwd, 5_000, signal),
    worktreeHolders(cwd, signal),
    run("git", ["config", "--get", "remote.origin.url"], cwd, 5_000, signal),
    // origin/HEAD names the integration branch to protect even when it is
    // neither checked out nor held. It is one tier of two: on a failed read the
    // gh fallback below runs, and only when BOTH fail does the pass abort.
    run("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], cwd, 5_000, signal),
  ])

  if (refs.aborted) return stopped("Reaper cancelled before reading the local branches. No branch was deleted.")
  if (refs.timedOut) {
    return stopped("Reaper failed: `git for-each-ref refs/heads` timed out. No branch was deleted.")
  }
  if (!refs.ok) {
    return stopped(
      `Reaper failed: could not read the local branches (${firstLine(refs.err) || "git for-each-ref exited non-zero"}). No branch was deleted.`,
    )
  }
  if (current.aborted) return stopped("Reaper cancelled before reading the current branch. No branch was deleted.")
  if (!current.ok) {
    return stopped(
      `Reaper failed: could not read the current branch (${firstLine(current.err) || "git branch --show-current exited non-zero"}). No branch was deleted.`,
    )
  }
  if (!worktrees.ok) {
    const why = worktrees.aborted
      ? "was cancelled"
      : `failed (${worktrees.detail}), so a checked-out branch cannot be ruled out`
    return stopped(`Reaper failed: reading the worktree list ${why}. No branch was deleted.`)
  }
  const repo = origin.ok ? repoFromRemote(origin.out) : undefined
  if (repo === undefined) {
    return stopped(
      `Reaper failed: could not resolve the repository from origin (${firstLine(origin.err) || "no origin remote"}). No branch was deleted.`,
    )
  }

  // ONE gh call for every merged PR. Newest-first as gh returns them; the
  // verdict only uses a name+commit match, so order cannot change a decision.
  const listed = await run(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      `${repo.owner}/${repo.name}`,
      "--state",
      "merged",
      "--limit",
      "100",
      "--json",
      "number,headRefName,headRefOid",
    ],
    cwd,
    DEFAULT_TIMEOUT,
    signal,
  )
  if (listed.aborted) return stopped("Reaper cancelled during `gh pr list`. No branch was deleted.")
  if (listed.timedOut) return stopped("Reaper failed: `gh pr list` timed out. No branch was deleted.")
  if (!listed.ok) {
    return stopped(
      `Reaper failed: could not read merged PRs (${firstLine(listed.err) || "gh pr list exited non-zero"}). No branch was deleted.`,
    )
  }
  const merged = reapPrs(parseJson<unknown>(listed.out))
  if (merged === undefined) {
    return stopped("Reaper failed: could not parse `gh pr list`, so its merge state is unknown. No branch was deleted.")
  }

  // Tier two of the default-branch read. gh is already authenticated for this
  // pass (it just listed the merged PRs), so one extra call is the cheap way to
  // protect a nonstandard default such as `production`. Both tiers failing is
  // NOT "no extra protection": the pass aborts with zero deletes, because a
  // repository whose default cannot be read is exactly where deleting the wrong
  // branch is unrecoverable at the integration level.
  const localDefault =
    head.ok && head.out.trim() !== "" ? head.out.trim().replace(/^refs\/remotes\/[^/]+\//, "") : undefined
  let ghDefault: string | undefined
  if (localDefault === undefined) {
    // The repository is given as the POSITIONAL argument: `gh repo view --help`
    // lists no `--repo`/`-R` flag (USAGE: `gh repo view [<repository>] [flags]`),
    // so the flag form would be rejected. The positional is also what pins the
    // lookup to `repo` resolved from origin above — the process cwd is the
    // caller's directory, not necessarily this repository.
    const view = await run(
      "gh",
      ["repo", "view", `${repo.owner}/${repo.name}`, "--json", "defaultBranchRef"],
      cwd,
      DEFAULT_TIMEOUT,
      signal,
    )
    if (view.ok) {
      const ref = parseJson<{ defaultBranchRef?: { name?: string } }>(view.out)?.defaultBranchRef?.name
      if (typeof ref === "string" && ref.trim() !== "") ghDefault = ref.trim()
    }
  }
  const defaultBranch = pickDefaultBranch(localDefault, ghDefault)
  if (!defaultBranch.ok) return stopped("default-branch-unreadable")

  const verdict = reapVerdict({
    branches: parseBranchRefs(refs.out),
    merged,
    current: current.out.trim(),
    held: [...worktrees.holders.keys()],
    defaultBranch: defaultBranch.branch,
  })

  const reaped: ReapedBranch[] = []
  const skipped: { branch: string; reason: string }[] = [...verdict.skipped]
  let error: string | undefined

  // A bounded command that timed out or was interrupted may still have finished,
  // so its outcome is read back rather than guessed. "" = ref absent, undefined
  // = the read itself failed.
  const refTip = async (branch: string): Promise<string | undefined> => {
    const read = await run(
      "git",
      ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`],
      cwd,
      DEFAULT_TIMEOUT,
      undefined,
    )
    if (!read.ok) return undefined
    return read.out.trim()
  }

  for (let index = 0; index < verdict.reaped.length; index += 1) {
    const candidate = verdict.reaped[index]!
    const out = await casDeleteVerifiedBranch(cwd, candidate.branch, candidate.oid, signal)
    if (out.ok) {
      reaped.push(candidate)
      continue
    }
    if (out.kind === "aborted" || out.kind === "timeout") {
      const tip = await refTip(candidate.branch)
      const what = out.kind === "aborted" ? "was interrupted" : "timed out"
      if (tip === "") {
        // The delete landed despite the missing reply: log it as reaped, with
        // its restore command, instead of pretending it was skipped.
        reaped.push(candidate)
        error ??= `Reaper: \`${out.command}\` ${what}, but the ref is gone — the delete completed. Restore it with \`${candidate.restore}\` if that was not intended.`
      } else if (tip === undefined) {
        skipped.push({ branch: candidate.branch, reason: "delete-unverified" })
        error ??= `Reaper: \`${out.command}\` ${what}, and the current tip of \`${candidate.branch}\` could not be read. Check \`git log -1 ${candidate.branch}\` before continuing.`
      } else if (tip === candidate.oid) {
        skipped.push({ branch: candidate.branch, reason: "delete-failed" })
        error ??= `Reaper: \`${out.command}\` ${what}; the branch still exists at its verified tip. Nothing else was forced.`
      } else {
        skipped.push({ branch: candidate.branch, reason: "moved" })
        error ??= `Reaper: \`${candidate.branch}\` moved while it was being deleted (expected ${candidate.oid}, found ${tip}); it was left alone.`
      }
      if (out.kind === "aborted") {
        for (const rest of verdict.reaped.slice(index + 1)) {
          skipped.push({ branch: rest.branch, reason: "cancelled" })
        }
        break
      }
      continue
    }
    switch (out.kind) {
      case "pre-unreadable":
        skipped.push({ branch: candidate.branch, reason: "held-unknown" })
        error ??= `Reaper: could not enumerate worktrees before deleting \`${candidate.branch}\` (${out.detail}), so it was left alone.`
        break
      case "pre-held":
        // A worktree picked the branch up after the list was read.
        skipped.push({ branch: candidate.branch, reason: "became-held" })
        break
      case "moved":
        skipped.push({ branch: candidate.branch, reason: "moved" })
        error ??= `Reaper: \`${candidate.branch}\` moved after verification (${out.detail}). It was left alone; re-run the pass to verify the new tip.`
        break
      case "refused":
        skipped.push({ branch: candidate.branch, reason: "delete-failed" })
        error ??= `Reaper: could not delete \`${candidate.branch}\` at the verified commit (${out.detail}); nothing else was forced.`
        break
      case "post-check":
        if (out.heal === "restored") {
          skipped.push({ branch: candidate.branch, reason: "restored" })
          break
        }
        if (out.heal === "exists") {
          skipped.push({ branch: candidate.branch, reason: "reappeared" })
          break
        }
        // Deleted, but the ref a worktree picked up mid-delete could not be
        // restored. The delete counts and its restore command is the fix.
        reaped.push(candidate)
        error ??= `Reaper: ${out.why}, and restoring \`refs/heads/${candidate.branch}\` at ${candidate.oid} FAILED (${out.detail}). Re-create it with \`${candidate.restore}\` if needed.`
        break
    }
  }

  // Dead markers only: a directory is never removed here.
  if (reaped.length > 0) {
    const pruned = await run("git", ["worktree", "prune"], cwd, DEFAULT_TIMEOUT, signal)
    if (!pruned.ok) {
      const detail =
        failureLine(pruned.err) || (pruned.timedOut ? "git worktree prune timed out" : "git worktree prune exited non-zero")
      error ??= `Reaper: \`git worktree prune\` failed (${detail}); the deleted branches are logged above and still restorable.`
    }
  }

  return JSON.stringify({
    reaped,
    skipped,
    truncated: verdict.truncated,
    ...(error === undefined ? {} : { error }),
  })
}

// Tier B item 9: one gh/git execution per in-flight read key. Two windows on
// the same directory, or the status/ahead pair a refresh sends together,
// share the single run instead of spawning twice.
//
// Key: `<generation> NUL <method> NUL <directory> NUL <extra>`, where extra
// is the PR url+number for `threads` and empty otherwise. The generation
// (module-level `readGen`) is bumped by every mutating method, so a read
// started after a Merge / Push / Commit / Create / Continue / Reset can never
// join a run that began before it (that is the one case where sharing would
// paint pre-action state). The same generation keys the worktree snapshot
// share, so the git half of a refresh cannot join pre-action state either.
//
// Lifecycle: the entry is the promise of the shared work, removed in `finally`
// when it settles, so the map never stores a result and never grows past the
// handful of keys actually in flight.
//
// Abort: the shared work runs WITHOUT a caller signal. A caller's abort (or
// the IPC layer cancelling its own reply) must not cancel the run other
// waiters are awaiting; every read is already bounded by its command
// timeout, so nothing can hang. A caller that aborted simply never paints
// the reply — the window's `if (!signal.aborted)` guard decides that, and
// its superseding request joins or reruns on its own.
const inFlight = new Map<string, Promise<unknown>>()
const shared = <T>(key: string, work: () => Promise<T>): Promise<T> => {
  const hit = inFlight.get(key)
  if (hit !== undefined) return hit as Promise<T>
  const pending = work().finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key)
  })
  inFlight.set(key, pending)
  return pending
}
export const readShared = <T>(method: string, directory: string, extra: string, work: () => Promise<T>): Promise<T> =>
  shared(`${readGen}\u0000${method}\u0000${directory}\u0000${extra}`, work)
// Side effects are never shared, but they invalidate reads: drop the PR
// number hint and move to a fresh generation when they settle.
export const mutateRead = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work()
  } finally {
    readGen += 1
    prNumber.clear()
  }
}
