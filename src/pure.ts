// Pure helpers extracted verbatim from gui.tsx so `bun test` can cover them
// without loading Solid, the Electron bridge or child_process. Everything here
// is a total function of its arguments: no signals, no fs, no env, no process
// access. `parsePorcelain` is the one exception to "silent": it keeps the exact
// console.warn it always had when it repairs a trimmed status entry.

// Diagnostics surface verbatim in the confirm dialog; one git line must not
// become a wall of text.
const MAX_DIAG = 200

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function capDiag(text: string): string {
  return text.length <= MAX_DIAG ? text : `${text.slice(0, MAX_DIAG)}…`
}

export function firstLine(s: string): string {
  const line = s.trim().split("\n").find((l) => l.trim() !== "")
  return capDiag(line ? line.trim() : "")
}

// git prints multi-line hints before the real failure. Prefer the
// `fatal:`/`error:` line so a step message stays one actionable sentence.
export function failureLine(stderr: string): string {
  const line = stderr
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("fatal:") || l.startsWith("error:"))
  return capDiag(line ?? firstLine(stderr))
}

// A step's sentence is fixed for an abort, but a timeout or a failed command
// can carry git/gh's own first line, so a template may also be a function of
// stderr. `runStep` (git.ts) resolves either form through this.
export type StepText = string | ((stderr: string) => string)

export function stepText(text: StepText, stderr: string): string {
  return typeof text === "string" ? text : text(stderr)
}

export function parseJson<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

// The first field that actually carries a value. gh reports a queued or running
// CheckRun with `conclusion: ""`, and `??` treats that empty string as present,
// so the sibling `status: "IN_PROGRESS"` never gets read and a live run showed
// as an unknown state instead of pending. Blank means absent here; a genuinely
// missing field still falls through to the `unknown` default.
export function firstFilled(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = String(value ?? "").trim()
    if (text) return text
  }
  return undefined
}

// The approval token a gated handoff asks the user to quote back. The prompt
// the panel queues names it (`#resolve-413-9f2c1a`), so a bare "go ahead" in
// the chat cannot approve a plan the user has not read. The head SHA's first
// six characters disambiguate commits: two plans for one PR at different heads
// get different tokens. Without a SHA the token stays PR-scoped.
export function approvalToken(action: string, number: string, sha?: string): string {
  const short = sha === undefined ? "" : sha.trim().slice(0, 6)
  return short === "" ? `#${action}-${number}` : `#${action}-${number}-${short}`
}

export type Check = { name: string; state: string }

export function checkLine(check: any): Check {
  return {
    name: String(check?.name ?? check?.context ?? "check"),
    state: firstFilled(check?.state, check?.conclusion, check?.status) ?? "unknown",
  }
}

export const FAILING_STATES = new Set([
  "FAILURE",
  "FAILED",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
])
export const PENDING_STATES = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "EXPECTED", "REQUESTED"])
// `checkLine` reads a rollup entry from the first of state, conclusion, status
// that is not blank. A StatusContext contributes SUCCESS; a completed CheckRun
// contributes SUCCESS, NEUTRAL or SKIPPED. OK is accepted for gh-compatible
// producers. Anything else — including a missing state, a blank conclusion with
// no usable status and an unrecognized spelling — is unknown, never green.
export const PASS_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "OK"])

// The rule that won, named so a test can pin it without pinning English prose.
export type CheckKind = "failing" | "pending" | "none" | "unknown" | "green"

// Counts plus the i18n key for the visible label: gui.tsx applies ctx.t at the
// call site (the `toneWordKey` pattern), so this file stays text-free. The
// failing kind has two keys because English needs a singular and a plural form;
// both counted kinds interpolate their own count.
export type CheckSummary = {
  kind: CheckKind
  labelKey: string
  failing: boolean
  failingCount: number
  pending: number
  unknown: boolean
}

const NO_CHECKS: CheckSummary = {
  kind: "none",
  labelKey: "panel.checksNone",
  failing: false,
  failingCount: 0,
  pending: 0,
  unknown: false,
}

function computeChecks(list: Check[]): CheckSummary {
  const states = list.map((check) => check.state.toUpperCase())
  const failingCount = states.filter((state) => FAILING_STATES.has(state)).length
  if (failingCount > 0) {
    return {
      kind: "failing",
      labelKey: failingCount === 1 ? "panel.checksFailingOne" : "panel.checksFailing",
      failing: true,
      failingCount,
      pending: 0,
      unknown: false,
    }
  }
  const pending = states.filter((state) => PENDING_STATES.has(state)).length
  if (pending > 0) {
    return {
      kind: "pending",
      labelKey: "panel.checksPending",
      failing: false,
      failingCount: 0,
      pending,
      unknown: false,
    }
  }
  if (list.length === 0) return NO_CHECKS
  if (states.some((state) => !PASS_STATES.has(state))) {
    return {
      kind: "unknown",
      labelKey: "panel.checksUnknown",
      failing: false,
      failingCount: 0,
      pending: 0,
      unknown: true,
    }
  }
  return {
    kind: "green",
    labelKey: "panel.checksGreen",
    failing: false,
    failingCount: 0,
    pending: 0,
    unknown: false,
  }
}

// One summary per distinct checks array. A `PrOk` result is immutable per fetch,
// so the chip label, the chip state word, the banner tone and the dialog's fact
// row can all ask for the same summary without re-walking the list: the identity
// of `checks` is the cache key, and undefined is the shared empty summary.
const summaryCache = new WeakMap<Check[], CheckSummary>()

export function summarizeChecks(checks: Check[] | undefined): CheckSummary {
  if (checks === undefined) return NO_CHECKS
  const cached = summaryCache.get(checks)
  if (cached !== undefined) return cached
  const summary = computeChecks(checks)
  summaryCache.set(checks, summary)
  return summary
}


export type PorcelainEntry = { status: string; path: string }

// Status characters `git status --porcelain` can emit. Used only to recognise
// an entry whose leading X-column space was stripped by `run()`'s trim.
const PORCELAIN_STATUS_CHARS = " MADRCU?!"

// `git status --porcelain -z`: entries are NUL-separated and paths are never
// quoted. Every entry is "XY<space>PATH"; a rename/copy adds the origin path
// as the next field. A trimmed read (" M path" -> "M path") loses the X column
// and shifts the path left by one, so repair that exact shape and report the
// count through `stats` (callers may log it; a warning is always emitted).
export function parsePorcelain(raw: string, stats?: { repairs: number }): PorcelainEntry[] {
  const parts = raw.split("\0")
  const out: PorcelainEntry[] = []
  let repairs = 0
  for (let i = 0; i < parts.length; i++) {
    let entry = parts[i]
    if (entry === undefined || entry.length < 4) continue
    // trim() only touches the edges of the whole string, so at most the first
    // field lost its X column. The surviving shape is "Y<space>path": a known
    // status char, then the separator. A bare rename/copy origin path (always
    // a later field, and never status-shaped) cannot match this.
    if (
      i === 0 &&
      entry[2] !== " " &&
      entry[1] === " " &&
      PORCELAIN_STATUS_CHARS.includes(entry.charAt(0))
    ) {
      entry = ` ${entry}`
      repairs += 1
    }
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (status[0] === "R" || status[0] === "C") i += 1
    if (path !== "") out.push({ status, path })
  }
  if (stats) stats.repairs = repairs
  if (repairs > 0) {
    console.warn(
      `[oc-pr-gui] parsePorcelain repaired ${repairs} trimmed status entr${repairs === 1 ? "y" : "ies"} (X column was a space).`,
    )
  }
  return out
}

// Never staged by Commit + Push: `.env` (but `.env.example` is), `.orch/`,
// and secret-shaped files. Matched on the basename, so a nested `.env` is too.
export function isExcludedPath(path: string): boolean {
  const base = path.split("/").pop() ?? path
  if (base === ".env") return true
  if (path.split("/").includes(".orch")) return true
  if (base.endsWith(".pem") || base.endsWith(".key") || base.endsWith(".p12")) return true
  if (base.endsWith(".keystore") || base.startsWith("id_rsa")) return true
  if (base.toLowerCase().includes("credentials")) return true
  return false
}

// `continue/<YYYYMMDD-HHMM>` in local time, as the approved contract asks.
export function continueStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

// A stash entry as an immutable identity plus its position in the stack. The
// stack is shared by every worktree of the repository, so `stash@{0}` can name
// another workspace's work by the time the restore runs; only `oid` may be
// carried across the flow.
export type StashEntry = { oid: string; ref: string; subject: string }

// Where `oid` sits right now, for reporting only. `listed:false` means the
// listing itself failed, which must not be reported as "the entry is gone".
export type StashLookup = { listed: boolean; entry?: StashEntry }

// THE wording for what happened to a stash entry after a restore, in one place
// so the dialog steps and the toast cannot disagree. `lookup` is a
// point-in-time read, so the three states stay distinct: the entry is on the
// stack right now (quote its current ref), the listing succeeded and OUR oid is
// absent (say so factually), or the listing itself failed (say we could not
// verify — claim it neither retained nor gone).
// `compact` is the toast rendering: same three states, clause only.
export function retainedStashNote(lookup: StashLookup, oid: string, compact = false): string {
  if (lookup.entry !== undefined) {
    return compact
      ? `Stash entry retained: ${oid} (currently ${lookup.entry.ref}) — drop it with \`git stash drop ${lookup.entry.ref}\` when you no longer need it.`
      : `Restored stashed changes; stash entry retained: ${oid} (currently ${lookup.entry.ref}). Remove it once you no longer need it with \`git stash drop ${lookup.entry.ref}\`.`
  }
  if (lookup.listed) {
    return compact
      ? `Stash entry ${oid} is no longer listed by \`git stash list\` (nothing to clean up).`
      : `Restored stashed changes; the stash entry ${oid} is no longer listed by \`git stash list\` (nothing to clean up).`
  }
  return compact
    ? `Could not verify retention of the stash entry ${oid} — run \`git stash list\` to check; this flow dropped nothing.`
    : `Restored stashed changes; could not verify retention of the stash entry ${oid}. Check \`git stash list\` and drop it by position once you no longer need it.`
}

// Which recovery command a failed `git stash apply --index` must advertise.
// The apply fails at two different stages and they need opposite advice:
//
//   - INDEX stage: git could not rebuild the index from the stash entry's index
//     commit and refused the whole apply (`error: conflicts in index. Try
//     without --index.`; also the bare `Try without --index` hint). Nothing was
//     applied, so repeating `--index` loops on the same refusal forever. The
//     plain apply does restore the worktree and leaves ordinary UU conflicts to
//     resolve, but the staged/unstaged split is lost — that cost is said out
//     loud instead of being silently traded away.
//   - WORKTREE stage (or any other failure, including a timeout/abort): the
//     worktree changes are already there, so re-running the same `--index`
//     command once the conflicts are resolved is the repair that restores the
//     split as well — the wording stays exactly as it always was.
//
// Empty or unreadable stderr keeps that same `--index` default: it is the
// command that preserves the most, so an ambiguous failure never downgrades it.
// The returned clause starts at the command itself, so each sentence keeps its
// own `run`/`Run` verb and capitalization; only command+guidance varies.
export function recoveryCommand(stderr: string, oid: string): string {
  const indexStage = /conflicts in index/i.test(stderr) || /try without --index/i.test(stderr)
  return indexStage
    ? `\`git stash apply ${oid}\` instead of \`--index\` — git applied nothing at the index stage, so the staged/unstaged split is not restored. Resolve the conflicts, \`git add\` the result, and commit.`
    : `\`git stash apply --index ${oid}\` after resolving the conflict.`
}

// ---- Reset workspace: the merged-detection verdict -------------------------
// `resetWorkspace` refuses to delete a feature branch that has commits outside
// origin/<base>. That count is the right guard for an unmerged branch, but a
// squash merge never puts the PR head commit into the base history, so the
// count stays > 0 after the merge and the guard refused almost every real
// reset. Local git alone cannot tell "unmerged" from "squash-merged", so the
// caller asks GitHub once — and only when the count is > 0. Every answer other
// than a full match refuses, so an unreadable PR is never treated as merged.
// The caller gathers the facts (`git rev-list --count` already produced
// `ahead`; `gh pr view <n> --json state,headRefName,headRefOid,mergedAt`
// produces `pr`; `git rev-parse` produces `localTip`).
export type ResetPrFacts = {
  state?: string
  headRefName?: string
  headRefOid?: string
  mergedAt?: string | null
}

export type ResetVerdictInput = {
  ahead: number
  number?: number | undefined
  pr?: ResetPrFacts | undefined
  localTip?: string | undefined
  feature: string
  base: string
}

// `reason` is present exactly when `proceed` is false. `forceDelete` is true
// only for a squash-merged branch whose head is confirmed: `git branch -d`
// would refuse it, because its content is not in the base history.
export type ResetVerdict = { proceed: boolean; forceDelete: boolean; reason?: string }

// A field that must be text before it is compared. Never throws: a number, an
// object or a missing key reads as absent, so the caller's verdict refuses
// instead of the process throwing on `.trim()`.
function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

// `gh pr view --json` decodes to `unknown`. This is the one gate between that
// payload and `ResetPrFacts`, so a syntactically valid but wrong-shaped answer
// (`null`, `[]`, `"MERGED"`, `{"state":7}`) is rejected here and the caller
// reports its named refusal. `state` must be a string; `headRefName` and
// `headRefOid` are string-or-absent; `mergedAt` is string-or-null (gh prints
// null for a PR that never merged). A wrong-typed optional field invalidates
// the payload rather than being silently dropped — the reset is fail-closed.
export function resetPrFacts(raw: unknown): ResetPrFacts | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.state !== "string") return undefined
  const isText = (value: unknown) => typeof value === "string"
  const name = record.headRefName
  const oid = record.headRefOid
  const mergedAt = record.mergedAt
  if (name !== undefined && !isText(name)) return undefined
  if (oid !== undefined && !isText(oid)) return undefined
  if (mergedAt !== undefined && mergedAt !== null && !isText(mergedAt)) return undefined
  return {
    state: record.state,
    headRefName: name as string | undefined,
    headRefOid: oid as string | undefined,
    mergedAt: mergedAt as string | null | undefined,
  }
}

export function resetVerdict(input: ResetVerdictInput): ResetVerdict {
  // `ahead` is read on its own and decides the fast path BEFORE any other
  // field is touched: a branch with nothing ahead of the remote base is
  // merged per git, and no PR fact — present, absent or malformed — can
  // change that. Everything else is destructured only after this returns.
  const ahead = input.ahead
  const usable = typeof ahead === "number" && Number.isFinite(ahead)
  // Nothing ahead: the pre-gh behaviour is kept byte-identically (`branch -d`
  // is the backstop). A count that is not a usable number is not treated as
  // zero — that would take the delete path on a value nobody could read.
  if (usable && ahead <= 0) return { proceed: true, forceDelete: false }
  const { number, pr, localTip, feature, base } = input
  if (!usable) {
    return {
      proceed: false,
      forceDelete: false,
      reason: `Reset refused: could not read how far \`${feature}\` is ahead of origin/${base} (${String(ahead)}). No branch was deleted.`,
    }
  }
  // No PR number means nothing identifies the branch's PR, so the old refusal
  // stands unchanged — this is the fail-closed default.
  if (number === undefined || !Number.isInteger(number) || number <= 0) {
    return {
      proceed: false,
      forceDelete: false,
      reason: `Reset refused: \`${feature}\` has ${ahead} commit(s) not in origin/${base}. Merge or push them first; no branch was deleted.`,
    }
  }
  // gh failed, timed out, printed something unparseable or a payload this
  // layer cannot read: unknown is not merged. (The caller turns the raw gh
  // error line into its own message.)
  if (pr === undefined || pr === null || typeof pr !== "object" || Array.isArray(pr)) {
    return {
      proceed: false,
      forceDelete: false,
      reason: `Reset refused: could not read PR #${number} from GitHub, so its merge state is unknown. No branch was deleted.`,
    }
  }
  // Typed as ResetPrFacts, but every read below goes through `textField`, so a
  // wrong-typed field refuses instead of throwing: this layer returns verdicts.
  const facts: ResetPrFacts = pr
  // `state` is authoritative; `mergedAt` is read for the same picture but never
  // gates, so a merged PR can never be refused for a missing timestamp.
  const state = textField(facts.state).toUpperCase()
  if (state !== "MERGED") {
    // Covers a queued `--auto` merge, an open PR and a closed-unmerged one.
    return {
      proceed: false,
      forceDelete: false,
      reason: `Reset refused: PR #${number} is not merged yet — reset after it lands. No branch was deleted.`,
    }
  }
  const headName = textField(facts.headRefName)
  if (headName !== feature) {
    return {
      proceed: false,
      forceDelete: false,
      reason: `Reset refused: PR #${number} is from \`${headName === "" ? "an unknown branch" : headName}\`, not \`${feature}\`. No branch was deleted.`,
    }
  }
  const tip = textField(localTip)
  if (tip === "") {
    return {
      proceed: false,
      forceDelete: false,
      reason: `Reset refused: could not read the local tip of \`${feature}\`, so the merged commit cannot be confirmed. No branch was deleted.`,
    }
  }
  const headOid = textField(facts.headRefOid)
  if (headOid === "" || headOid !== tip) {
    return {
      proceed: false,
      forceDelete: false,
      reason: `Reset refused: branch moved after the merge (head ${headOid === "" ? "unknown" : headOid} ≠ local ${tip}). No branch was deleted.`,
    }
  }
  return { proceed: true, forceDelete: true }
}

// ---- Reaper: the merged-branch tidy pass ------------------------------------
// The reaper deletes local branches whose PR is merged. Its one proof is tip
// equality: a local branch whose commit is EXACTLY the merged PR's head commit
// carries no work that is not already on GitHub, so the delete is safe and the
// logged `git branch <name> <oid>` restore command is a complete undo. Every
// other state — a different tip, no merged PR, the checked-out branch, a
// worktree-held branch — is a named skip, never a delete.
export const REAP_CAP = 5

// One line of `git for-each-ref refs/heads` output: the short name and the full
// object name. Upstream is read by the same format but not needed for the
// verdict, so it is not carried here.
export type ReapBranch = { branch: string; oid: string }

// The merged-PR fields the verdict compares. Deliberately narrow: no state
// field is needed because `gh pr list --state merged` already selected them.
export type ReapPr = { number: number; headRefName: string; headRefOid: string }

export type ReapReason =
  | "current"
  | "held"
  | "protected"
  | "no-merged-pr"
  | "unpushed-tip"

// `restore` is quoted verbatim in the log and is the exact undo: recreating the
// ref at the same commit. `number` names the merged PR that proved it.
export type ReapedBranch = { branch: string; number: number; oid: string; restore: string }

export type ReapSkip = { branch: string; reason: ReapReason }

export type ReapVerdictInput = {
  // In `for-each-ref` order, so a capped pass is deterministic.
  branches: ReapBranch[]
  merged: ReapPr[]
  // Empty when HEAD is detached: then NO branch is current. Passing the empty
  // string (rather than undefined) deliberately matches no branch.
  current?: string | undefined
  // Short names checked out in any worktree, this one included.
  held: string[]
  // origin/HEAD's branch, when it could be read. An integration branch is never
  // a reap candidate even when it is neither checked out nor held.
  defaultBranch?: string | undefined
  cap?: number | undefined
}

export type ReapVerdict = {
  reaped: ReapedBranch[]
  skipped: ReapSkip[]
  truncated: boolean
}

// The isExcludedPath-style safety list for branches: names that must never be
// deleted even when a merged PR's head happens to match. A local copy of an
// integration branch is cheap to restore but expensive to lose while a script
// or a hook still expects it.
export function isProtectedBranch(name: string): boolean {
  const branch = name.trim().toLowerCase()
  return branch === "main" || branch === "master" || branch === "trunk" || branch === "develop"
}

// The integration branch the reaper must protect beyond the fixed names. Other
// repositories use `production` or any other nonstandard default, so the only
// honest source is what the repository itself says: origin/HEAD first (local,
// and already needed by the reset flow), then GitHub's `defaultBranchRef`.
// `ok: false` means both reads failed, and the pass must not run at all —
// "no extra protection" would let a nonstandard default branch be deleted.
export type DefaultBranchPick = { ok: true; branch: string } | { ok: false }

export function pickDefaultBranch(
  originHead: string | undefined,
  ghDefault: string | undefined,
): DefaultBranchPick {
  const local = (originHead ?? "").trim()
  if (local !== "") return { ok: true, branch: local }
  const remote = (ghDefault ?? "").trim()
  if (remote !== "") return { ok: true, branch: remote }
  return { ok: false }
}

// Tri-state read of the reaper's preference file -> effective preference.
//   - missing: the documented default is OFF, so the reaper does not run. A
//     fresh install must not delete anything before the user has opted in once.
//   - stored: obey the stored boolean for this directory (an explicit `true` is
//     the opt-in, an explicit `false` keeps it off).
//   - unreadable: FAIL CLOSED. The reaper must not act when it cannot prove the
//     user opted in, so `enabled: false` and `known: false`; the panel toggle
//     shows Off and the window skips the pass entirely.
export type ReaperSettingsRead =
  | { kind: "missing" }
  | { kind: "stored"; map: Record<string, boolean> }
  | { kind: "unreadable" }

export type ReaperPreference = { enabled: boolean; known: boolean }

export function reaperPreference(read: ReaperSettingsRead, directory: string): ReaperPreference {
  if (read.kind === "unreadable") return { enabled: false, known: false }
  if (read.kind === "missing") return { enabled: false, known: true }
  return { enabled: read.map[directory] === true, known: true }
}

// Write-side sibling of `reaperPreference`: what the panel's auto-tidy switch
// is allowed to show once a save attempt has resolved. The click paints an
// optimistic state, so the reply is the only authority that can leave the
// switch On, and only when it is a proven readable write: `known: true` AND
// `enabled: true`. Everything else fails CLOSED to Off — an `error` reply, an
// unreadable or unknown shape, and a thrown IPC — because `known: false` means
// the preference cannot be proven, and an unproven preference must never let a
// pass delete branches.
export type TidyToggleOutcome = { enabled: boolean; known: boolean; error?: string }

export function tidyToggleOutcome(reply: unknown, threw: boolean): TidyToggleOutcome {
  if (threw) return { enabled: false, known: false }
  if (reply === null || typeof reply !== "object" || Array.isArray(reply)) {
    return { enabled: false, known: false }
  }
  const record = reply as Record<string, unknown>
  if (record.error !== undefined) {
    return { enabled: false, known: false, error: String(record.error) }
  }
  if (record.known !== true) return { enabled: false, known: false }
  return { enabled: record.enabled === true, known: true }
}

// One shell-safe word. A branch name may contain `;`, `$`, backticks and even a
// single quote (git only forbids space, `~^:?*[\`, `..`, `@{` and control
// characters), so pasting a restore command built from a raw name could run a
// second command. Single quotes keep everything literal; an embedded quote is
// closed, escaped and reopened as `'\''`.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

// `git for-each-ref --format '%(refname:short)%00%(objectname)%00%(upstream:short)'`
// output: one branch per line, NUL-separated fields. A malformed line is
// dropped rather than guessed at — a branch this layer cannot read is not a
// candidate.
export function parseBranchRefs(raw: string): ReapBranch[] {
  const out: ReapBranch[] = []
  for (const line of raw.split("\n")) {
    const [name, oid] = line.split("\0")
    const branch = (name ?? "").trim()
    const tip = (oid ?? "").trim()
    if (branch === "" || tip === "") continue
    out.push({ branch, oid: tip })
  }
  return out
}

// `gh pr list --json number,headRefName,headRefOid` decodes to `unknown`. This
// is the one gate between that payload and `ReapPr[]`: a syntactically valid
// but wrong-shaped element invalidates the WHOLE payload (`undefined`), which
// the caller reports as a gh failure and deletes nothing for. An empty array is
// a valid answer ("no merged PRs"), not a failure.
export function reapPrs(raw: unknown): ReapPr[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ReapPr[] = []
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined
    const record = entry as Record<string, unknown>
    const number = record.number
    const name = record.headRefName
    const oid = record.headRefOid
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return undefined
    if (typeof name !== "string" || name.trim() === "") return undefined
    if (typeof oid !== "string" || oid.trim() === "") return undefined
    out.push({ number, headRefName: name.trim(), headRefOid: oid.trim() })
  }
  return out
}

export function reapVerdict(input: ReapVerdictInput): ReapVerdict {
  const cap = typeof input.cap === "number" && Number.isInteger(input.cap) && input.cap >= 0 ? input.cap : REAP_CAP
  const current = (input.current ?? "").trim()
  const held = new Set(input.held)
  const defaultBranch = (input.defaultBranch ?? "").trim()
  // A branch name can be reused across PRs (branch, merge, branch again). Keep
  // every merged PR per name: the candidate needs ONE whose head commit is the
  // local tip, while "no merged PR at all" and "tips disagree" stay distinct.
  const mergedByName = new Map<string, ReapPr[]>()
  for (const pr of input.merged) {
    const name = pr.headRefName.trim()
    if (name === "") continue
    const list = mergedByName.get(name)
    if (list === undefined) mergedByName.set(name, [pr])
    else list.push(pr)
  }
  const reaped: ReapedBranch[] = []
  const skipped: ReapSkip[] = []
  let truncated = false
  for (const candidate of input.branches) {
    const branch = candidate.branch.trim()
    const oid = candidate.oid.trim()
    if (branch === "" || oid === "") continue
    // The order is strongest guard first: a branch that is current or held is
    // never classified as a candidate, whatever gh says about it.
    if (current !== "" && branch === current) {
      skipped.push({ branch, reason: "current" })
      continue
    }
    if (held.has(branch)) {
      skipped.push({ branch, reason: "held" })
      continue
    }
    if (isProtectedBranch(branch) || (defaultBranch !== "" && branch === defaultBranch)) {
      skipped.push({ branch, reason: "protected" })
      continue
    }
    const prs = mergedByName.get(branch)
    if (prs === undefined || prs.length === 0) {
      skipped.push({ branch, reason: "no-merged-pr" })
      continue
    }
    const match = prs.find((pr) => pr.headRefOid === oid)
    if (match === undefined) {
      skipped.push({ branch, reason: "unpushed-tip" })
      continue
    }
    // Ordering is the for-each-ref order: the cap takes the first N names, and
    // `truncated` reports the rest without pretending they were skipped for a
    // reason of their own.
    if (reaped.length >= cap) {
      truncated = true
      continue
    }
    reaped.push({ branch, number: match.number, oid, restore: `git branch ${shellQuote(branch)} ${oid}` })
  }
  return { reaped, skipped, truncated }
}

// ---- Decision layer: facts in, keys/tones out ------------------------------
// Everything below is a total function of a plain PrFacts record. gui.tsx keeps
// the signal reads (`actionKind()`, `view()`), the i18n call (`ctx.t`) and the
// chip's count interpolation at the call site, so these rules can be tested
// without a reactive scope while the rendered text stays byte-identical.

// One state -> tone mapping for the banner, the dialog rows and the titlebar
// summary (and any future polling), so one PR state never reads two ways.
// `review` is an open-PR state: unresolved review threads outrank pending
// checks but not failing checks or conflicts.
export type PrTone =
  | "create"
  | "pending"
  | "green"
  | "failing"
  | "review"
  | "conflicts"
  | "unknown"
  | "merged"
  | "closed"
  | "error"

// The plain facts the decision layer consumes. Exactly what `prTone`,
// `chipStage` and `stateTone` read today: the upper-cased PR state, the
// conflict predicate, three check-summary fields and whether unresolved review
// work exists. Thread *counts* stay in gui.tsx (the chip's label
// interpolation); only the positive-count predicate is a fact.
export type PrFacts = {
  state: string
  conflicts: boolean
  failing: boolean
  pending: number
  unknown: boolean
  reviewWork: boolean
}

export function hasConflicts(pr: { mergeable?: string; mergeStateStatus?: string }): boolean {
  const mergeable = (pr.mergeable ?? "").toUpperCase()
  const status = (pr.mergeStateStatus ?? "").toUpperCase()
  return mergeable === "CONFLICTING" || status === "DIRTY" || status === "CONFLICTING"
}

// The one "has review work" rule: only a positive unresolved count promotes.
// A missing count (not counted yet) and `null` (the query failed) are unknown,
// never work — and never a reason to hide it either.
export function hasReviewWork(threads: { unresolved?: number } | null | undefined): boolean {
  return (threads?.unresolved ?? 0) > 0
}

export function facts(pr: {
  state?: string
  mergeable?: string
  mergeStateStatus?: string
  checks?: Check[]
  reviewThreads?: { unresolved: number } | null
}): PrFacts {
  const checks = summarizeChecks(pr.checks)
  return {
    state: (pr.state ?? "").toUpperCase(),
    conflicts: hasConflicts(pr),
    failing: checks.failing,
    pending: checks.pending,
    unknown: checks.unknown,
    reviewWork: hasReviewWork(pr.reviewThreads),
  }
}

// Banner/dialog/titlebar tone order: terminal states first, then conflicts,
// then failing, then review, pending and unknown.
export function prTone(f: PrFacts): PrTone {
  if (f.state === "MERGED") return "merged"
  if (f.state === "CLOSED") return "closed"
  if (f.conflicts) return "conflicts"
  if (f.failing) return "failing"
  if (f.reviewWork) return "review"
  if (f.pending > 0) return "pending"
  if (f.unknown) return "unknown"
  return "green"
}

export type ActionKind =
  | "detached"
  | "merged"
  | "failing"
  | "conflicts"
  | "merge"
  | "dirty"
  | "push"
  | "create"
  | "error"

export type ChipStage = "review" | "failing" | "conflicts" | "pending" | "unknown" | "open"

// The single stage the chip reports. The word, the aria colour namespace and
// the visible label all read this one order, so the chip can never show two
// facts at once: Review items > Failing > Conflicts > Pending > Unknown > Open
// (all green / no checks). Merged, Closed, Error, Detached and Checking never
// reach here, so open items cannot displace their word. Note this order is
// deliberately DIFFERENT from prTone's: the banner puts conflicts above failing,
// the chip puts failing above conflicts.
export function chipStage(f: PrFacts): ChipStage {
  if (f.reviewWork) return "review"
  if (f.failing) return "failing"
  if (f.conflicts) return "conflicts"
  if (f.pending > 0) return "pending"
  if (f.unknown) return "unknown"
  return "open"
}

export type ToneName = "green" | "redSoft" | "red" | "blue" | "amber" | "purple" | "neutral" | "none"

// The primary fill normally equals the colour the titlebar chip shows for the
// same repo state, so this stays in sync with the chip's word table. The one
// exception is the resolve-active row, which never reaches this function: it
// fills redSoft unconditionally. `kind` is actionKind() from gui.tsx.
export function stateTone(kind: ActionKind | undefined, f: PrFacts): ToneName {
  switch (kind) {
    case "detached":
      return "neutral"
    case "merged":
      return "purple"
    case "failing":
      return "redSoft"
    case "conflicts":
      return "red"
    case "merge": {
      // chipStateWord's precedence is Review items > Failing > Conflicts >
      // Pending > Unknown > Open; actionKind already excludes failing and
      // conflicts here. Review items cannot reach this arm: gui.tsx renders the
      // tone-filled primary inside `<Show when={!resolveActive()}>`, and the
      // resolve overlay owns redSoft unconditionally. So the stage is Pending,
      // Unknown or Open, read through the same predicate — not a copy.
      const stage = chipStage(f)
      if (stage === "pending") return "amber"
      if (stage === "unknown") return "neutral"
      return "green"
    }
    case "dirty":
      // Starting work, not waiting: blue in both branches. The chip's no-PR
      // row reads No PR (blue) whether the tree is dirty or the branch is
      // merely unpushed, so no split remains here.
      return "blue"
    case "push":
      return "blue"
    case "create":
      return "blue"
    case "error":
      return "neutral"
    default:
      // Unreachable while an action is known; the bare class keeps the primary
      // unstyled rather than inventing a fifth hex.
      return "none"
  }
}

// Poll cadence for an open PR. The poll NEVER stops while a poll-worthy result
// exists (the titlebar chip keeps needing freshness); this only chooses the
// delay before the next tick:
// - fast while the user can see the side region (the panel is mounted and its
//   tab is selected) or while the PrActions dialog is mounted (the dialog has
//   no timer of its own and rides this same tick);
// - slow while both are closed, where only the chip reads the result.
// The decision is a pure function of those two signals so the rule is pinned by
// tests instead of living in a closure next to a setTimeout.
export const POLL_MS_FAST = 18_000
export const POLL_MS_SLOW = 60_000

export function pollDelay(visible: boolean, dialogOpen: boolean): number {
  return visible || dialogOpen ? POLL_MS_FAST : POLL_MS_SLOW
}

// The reaper rides the SLOW poll tick and may delete branches, so one pass per
// directory per ten minutes is enough: a merged branch that appears mid-window
// is tidied on the next slow tick, and a failing pass retries on the one after
// that instead of on every tick. The window owns this clock; `tidyDue` is pure
// so the boundary is pinned by a test rather than a setTimeout.
export const TIDY_COOLDOWN_MS = 10 * 60 * 1000

// Is a pass due? `lastPassMs` is undefined until this window's first pass (a
// fresh window tidies immediately), and a timestamp in the future — clock skew
// or a restored window — reads as "not due" so it can never turn into a retry
// loop. The boundary itself is due: ten minutes after the last start is a new
// pass.
export function tidyDue(lastPassMs: number | undefined, nowMs: number, cooldownMs: number): boolean {
  if (lastPassMs === undefined) return true
  return nowMs - lastPassMs >= cooldownMs
}

// The panel's last-pass facts, extracted from the raw `reap` reply. `undefined`
// means the reply itself was unreadable, so the previous note is kept rather
// than claiming the repository is tidy. A failure is a suffix, never a
// replacement: a pass can delete branches and then fail at `git worktree
// prune`, and the restore commands are still the undo the user was promised.
export type TidyNote = { branches: string[]; restores: string[]; failed: boolean }

export function tidyNote(reply: unknown): TidyNote | undefined {
  if (reply === null || typeof reply !== "object" || Array.isArray(reply)) return undefined
  const record = reply as Record<string, unknown>
  const reaped = Array.isArray(record.reaped) ? record.reaped : []
  const branches: string[] = []
  const restores: string[] = []
  for (const entry of reaped) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue
    const branch = (entry as Record<string, unknown>).branch
    const restore = (entry as Record<string, unknown>).restore
    if (typeof branch === "string" && branch !== "") branches.push(branch)
    if (typeof restore === "string" && restore !== "") restores.push(restore)
  }
  const failed = typeof record.error === "string" && record.error !== ""
  return { branches, restores, failed }
}

// Auto-fix handoff claims, keyed `${number}#${headSha}`. The manual button and
// the poll share one key, so a click cannot enqueue bytes the poll already
// queued. The store used to be a Set, which made a delivered-then-failed fix
// block a manual retry at the same SHA forever; a timestamped claim expires.
//
// Ten minutes: the poll is edge-triggered and never re-queues while the same
// failure persists, so within one run of the same head SHA the claim's only job
// is to stop the manual/poll double-queue a few seconds apart — one second would
// do. The extra order of magnitude covers the delivery round-trip on a loaded
// desktop and still ends well before a user waits around to retry: long enough
// that a live agent is not prompted twice, short enough that a failed handoff
// is retryable without restarting OpenCode.
//
// Accepted limitation: expiry does not prove the first run finished. A manual
// Fix clicked after the TTL can duplicate an agent run that is still going.
// Accepted deliberately — a 10-minute silent failure is exactly the case the
// retry affordance exists for, and the prompt's own stale-commit check limits
// the damage (it refuses if the head has moved).
export const CLAIM_TTL_MS = 10 * 60 * 1000

// Read-only half: is the claim still inside its TTL? `nowMs` and `ttlMs` are
// arguments so the boundary is testable with a clock instead of a fake timer.
export function claimActive(
  claims: ReadonlyMap<string, number>,
  key: string,
  nowMs: number,
  ttlMs: number = CLAIM_TTL_MS,
): boolean {
  const claimedAt = claims.get(key)
  return claimedAt !== undefined && nowMs - claimedAt < ttlMs
}

// Claim `key` unless an unexpired claim already holds it. A successful claim
// writes `nowMs`, which is also the refresh a re-claim after expiry performs.
// Returns false when the existing claim is still valid (nothing is written).
export function tryClaim(
  claims: Map<string, number>,
  key: string,
  nowMs: number,
  ttlMs: number = CLAIM_TTL_MS,
): boolean {
  // Expired entries are otherwise never removed, so the map would keep one dead
  // timestamp per PR#sha forever. Sweeping here (there is no timer in this
  // module) costs one pass over a tiny map — one entry per PR#sha in flight —
  // and keeps the read-only claimActive free of writes.
  for (const [heldKey, claimedAt] of claims) {
    if (nowMs - claimedAt >= ttlMs) claims.delete(heldKey)
  }
  if (claimActive(claims, key, nowMs, ttlMs)) return false
  claims.set(key, nowMs)
  return true
}

// Ownership-checked release: delete only when `token` is still the value the
// map holds. A claim can therefore only ever release itself — a caller whose
// claim expired and was replaced by a newer claim (a legitimate re-claim after
// the TTL) must not delete its successor, which would re-open the double-queue
// the claim exists to prevent. Returns whether the entry was removed.
export function releaseClaim(
  claims: Map<string, number>,
  key: string,
  token: number | undefined,
): boolean {
  if (token === undefined) return false
  if (claims.get(key) !== token) return false
  return claims.delete(key)
}

// One claim key per handoff state: action, PR number, head sha. Two different
// actions never block each other (`fix#413#abc` and `review#413#abc` are
// independent), and a PR whose status carried no head sha still gets a stable
// key — `nohead` rather than a trailing empty segment — so "same state" keeps
// its meaning when the panel is showing a branch tip instead of a commit. The
// one handoff whose prompt tolerates a missing PR number (Continue, which prints
// `?`) keys it as `?` instead of inventing a number.
export function handoffClaimKey(
  action: string,
  number: number | undefined,
  sha: string | undefined,
): string {
  const head = sha !== undefined && sha !== "" ? sha : "nohead"
  return `${action}#${number ?? "?"}#${head}`
}

// The tone -> state-word key table. gui.tsx applies ctx.t to the returned key,
// so the word stays localized while this selection is testable. The default arm
// is the error key, matching the original switch.
export function toneWordKey(tone: PrTone): string {
  switch (tone) {
    case "create":
      return "panel.stateCreate"
    case "pending":
      return "panel.statePending"
    case "green":
      return "panel.stateOpen"
    case "failing":
      return "panel.stateFailing"
    case "review":
      return "panel.stateReviewItems"
    case "conflicts":
      return "panel.stateConflicts"
    case "unknown":
      return "panel.stateUnknown"
    case "merged":
      return "panel.stateMerged"
    case "closed":
      return "panel.stateClosed"
    default:
      return "panel.stateError"
  }
}

// ---------------------------------------------------------------------------
// Main-process read helpers (Tier B items 7 and 11).
//
// A refresh used to spend six git spawns (three for the branch/HEAD triple in
// `branchName`, three for divergence) plus two gh round trips (`gh pr view` for
// status and a separate GraphQL call for review threads). The parsers below
// read ONE `git status --porcelain=v2 --branch -z` and ONE folded GraphQL reply
// into exactly the shapes gui.tsx already maps, so the duplicate work is gone
// without changing what the window sees.
// ---------------------------------------------------------------------------

export type WorktreeSnapshot = {
  branch?: string
  // Full oid. gui.tsx shortens it where a short sha used to be displayed.
  commit?: string
  detached: boolean
  upstream?: string
  // Present only when an upstream is configured (`# branch.ab`). gui.tsx falls
  // back to the old `origin/<branch>` probe in exactly that case, so a branch
  // without an upstream keeps its previous numbers.
  ahead?: number
  behind?: number
  entries: PorcelainEntry[]
}

// `git status --porcelain=v2 --branch -z`. Header lines start with `# branch.`;
// entries are NUL-separated and (because of `-z`) never quoted, so a path with
// spaces stays the final field of its record. Field counts before the path:
// 7 for an ordinary entry, 8 for a rename/copy (whose origin path is the NEXT
// NUL record, exactly like v1), 9 for an unmerged entry.
export function parseStatusSnapshot(raw: string): WorktreeSnapshot {
  const out: WorktreeSnapshot = { detached: false, entries: [] }
  const parts = raw.split("\0")
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i]
    if (record === undefined || record === "") continue
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice("# branch.oid ".length).trim()
      // `(initial)` is an unborn branch: a branch name with no commit yet.
      if (oid !== "" && oid !== "(initial)") out.commit = oid
      continue
    }
    if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length).trim()
      if (head === "(detached)") out.detached = true
      else if (head !== "" && head !== "(unknown)") out.branch = head
      continue
    }
    if (record.startsWith("# branch.upstream ")) {
      const upstream = record.slice("# branch.upstream ".length).trim()
      if (upstream !== "") out.upstream = upstream
      continue
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /^\+(\d+) -(\d+)$/.exec(record.slice("# branch.ab ".length).trim())
      if (match !== null) {
        out.ahead = Number.parseInt(match[1] ?? "", 10)
        out.behind = Number.parseInt(match[2] ?? "", 10)
      }
      continue
    }
    if (record.startsWith("# ")) continue

    const kind = record.charAt(0)
    if (kind === "1" || kind === "2" || kind === "u") {
      const parsed = snapshotEntry(record, kind === "1" ? 7 : kind === "2" ? 8 : 9)
      if (parsed === undefined) continue
      // v2 spells "unmodified" as "."; v1 used a space. Reproduce the v1 shape
      // so the file list and `dirty` read the same from both.
      if (kind === "2") i += 1
      out.entries.push({ status: parsed.xy.replace(/\./g, " "), path: parsed.path })
      continue
    }
    if (kind === "?") {
      const path = record.slice(2)
      if (path !== "") out.entries.push({ status: "??", path })
    }
  }
  return out
}

function snapshotEntry(record: string, fields: number): { xy: string; path: string } | undefined {
  let rest = record.slice(2)
  const tokens: string[] = []
  for (let n = 0; n < fields; n++) {
    const space = rest.indexOf(" ")
    if (space === -1) return undefined
    tokens.push(rest.slice(0, space))
    rest = rest.slice(space + 1)
  }
  if (rest === "") return undefined
  return { xy: tokens[0] ?? "", path: rest }
}

// Display lines for the diverged-file list, capped exactly as before.
export function porcelainFiles(entries: PorcelainEntry[]): string[] {
  return entries.slice(0, 50).map((entry) => `${entry.status} ${entry.path}`)
}

// Owner/repo from the origin remote URL. gh needs the base repository to run
// the folded query, and reading it from git is one local spawn instead of a
// network `gh repo view`. Local-path remotes (no host) return undefined, which
// sends the caller down the untouched dual-path fallback.
export function repoFromRemote(raw: string): { owner: string; name: string } | undefined {
  const text = raw.trim()
  if (text === "") return undefined
  let path: string | undefined
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(text)
  if (scheme !== null) path = scheme[1]
  else {
    // scp-like: git@host:owner/repo.git
    const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(text)
    if (scp !== null) path = scp[1]
  }
  if (path === undefined) return undefined
  const trimmed = path.replace(/\/+$/, "").replace(/\.git$/i, "")
  const parts = trimmed.split("/")
  const name = parts[parts.length - 1]
  const owner = parts[parts.length - 2]
  if (owner === undefined || name === undefined) return undefined
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name)) return undefined
  return { owner, name }
}

// The same fields `gh pr view --json number,url,title,state,isDraft,mergeable,
// mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,baseRefName`
// returns, read in ONE GraphQL call together with `reviewThreads`.
//
// `statusCheckRollup` is the PULLREQUEST-level field, verified live against gh
// 2.103.3 (the `commits.nodes[].commit.statusCheckRollup` form is deliberately
// not used). `headRefName` is read only as the stale-number guard in gui.tsx;
// the window never sees it.
const PR_NODE_SELECTION =
  "number url title state isDraft mergeable mergeStateStatus reviewDecision headRefOid baseRefName headRefName " +
  "statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name conclusion status} ... on StatusContext{context state}}}} " +
  "reviewThreads(first:100){nodes{isResolved}}"

export const FOLDED_PR_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){${PR_NODE_SELECTION}}}}`

// Branch-keyed resolution. `pullRequests(headRefName:)` is the authoritative
// lookup for a branch, and it must be EXPLICITLY ordered: with no `orderBy` the
// API returned an arbitrary row, and these repositories keep merged branches
// (delete_branch_on_merge=false), so a reused branch carries an old merged PR
// next to the new open one. Newest first, then `pickBranchPr` prefers the open
// row. `first:10` (not 1) is what makes the preference possible in one call.
export const BRANCH_PR_QUERY = `query($owner:String!,$repo:String!,$head:String!){repository(owner:$owner,name:$repo){pullRequests(headRefName:$head,states:[OPEN,MERGED,CLOSED],first:10,orderBy:{field:CREATED_AT,direction:DESC}){nodes{${PR_NODE_SELECTION}}}}}`

// The rows arrive newest-first. An OPEN PR wins: on a reused branch the panel
// must show the work in progress, never the old merged PR that shares the branch
// name. With no open PR the newest row is the answer, which is also the
// merged-PR display path (and Continue-from-merged reads MERGED from here).
export function pickBranchPr(nodes: unknown): any | undefined {
  if (!Array.isArray(nodes)) return undefined
  const rows = nodes.filter((node) => node !== null && typeof node === "object")
  if (rows.length === 0) return undefined
  const open = rows.find((node: any) => String(node?.state ?? "").toUpperCase() === "OPEN")
  return open ?? rows[0]
}

export type GhPrFields = {
  number?: number
  url?: string
  title?: string
  state?: string
  isDraft?: boolean
  mergeable?: string
  mergeStateStatus?: string
  reviewDecision?: string
  headRefOid?: string
  baseRefName?: string
  headRefName?: string
  statusCheckRollup?: unknown[]
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

// GraphQL node -> the exact field set the `gh pr view` path produces. Two
// normalisations matter: a rollup context is flattened into gh's CheckRun /
// StatusContext shape (so `checkLine` sees the same keys), and a null
// reviewDecision becomes "", which is what gh prints for "no decision".
export function prFromGraphql(node: any): GhPrFields | undefined {
  if (node === null || typeof node !== "object") return undefined
  if (typeof node.number !== "number") return undefined
  const contexts = node?.statusCheckRollup?.contexts?.nodes
  const rollup: unknown[] = Array.isArray(contexts)
    ? contexts.slice(0, 100).map((context: any) =>
        context?.__typename === "StatusContext"
          ? { context: context?.context, state: context?.state }
          : { name: context?.name, conclusion: context?.conclusion, status: context?.status },
      )
    : []
  return {
    number: node.number,
    url: text(node.url),
    title: text(node.title),
    state: text(node.state),
    isDraft: node.isDraft === true,
    mergeable: text(node.mergeable),
    mergeStateStatus: text(node.mergeStateStatus),
    reviewDecision: text(node.reviewDecision) ?? "",
    headRefOid: text(node.headRefOid),
    baseRefName: text(node.baseRefName),
    headRefName: text(node.headRefName),
    statusCheckRollup: rollup,
  }
}

export function foldThreads(node: any): { unresolved: number } | undefined {
  const nodes = node?.reviewThreads?.nodes
  if (!Array.isArray(nodes)) return undefined
  return { unresolved: nodes.filter((thread: any) => thread?.isResolved !== true).length }
}

// Which key the folded query uses. A remembered number wins: it is one lookup
// shape for every PR, and it is the only one that finds a fork PR (whose head
// branch lives in another repository, where `pullRequests(headRefName:)` on the
// base repo cannot see it). Without a number the branch is the only key.
export type FoldKey =
  | { kind: "number"; number: number }
  | { kind: "branch"; branch: string }
  | { kind: "none" }

export function foldKey(input: { branch?: string; memo?: number }): FoldKey {
  if (typeof input.memo === "number" && Number.isInteger(input.memo) && input.memo > 0) {
    return { kind: "number", number: input.memo }
  }
  if (input.branch !== undefined && input.branch !== "") return { kind: "branch", branch: input.branch }
  return { kind: "none" }
}

// The single decision point between the folded reply and the untouched dual
// path. Everything that can go wrong (gh failure, timeout, GraphQL error, null
// PR, zero PRs for the branch, a payload that does not parse, a remembered
// number that no longer belongs to this branch) lands on `fallback`, and the
// caller then runs exactly the pre-Tier-B code. `revalidate` is the one outcome
// that asks for another folded query: the remembered number answered, but the PR
// is not open any more, so the ordered branch lookup has to decide.
export type FoldOutcome =
  | { kind: "folded"; pr: GhPrFields; threads: { unresolved: number } }
  | { kind: "cancelled" }
  | { kind: "revalidate" }
  | { kind: "fallback"; why: string }

export function foldOutcome(
  result: { ok: boolean; out: string; aborted?: boolean; timedOut?: boolean },
  key: FoldKey,
  branch?: string,
): FoldOutcome {
  if (result.aborted === true) return { kind: "cancelled" }
  if (result.timedOut === true) return { kind: "fallback", why: "timeout" }
  if (!result.ok) return { kind: "fallback", why: "gh failed" }
  const payload = parseJson<any>(result.out)
  const repository = payload?.data?.repository
  if (repository === null || typeof repository !== "object") return { kind: "fallback", why: "unparsable" }

  let node: any
  if (key.kind === "number") {
    node = repository.pullRequest
    if (node === null || node === undefined) return { kind: "fallback", why: "no-pr" }
  } else if (key.kind === "branch") {
    const nodes = repository.pullRequests?.nodes
    if (!Array.isArray(nodes)) return { kind: "fallback", why: "unparsable" }
    // Zero rows is the fork case as well as the no-PR case: the base repo has no
    // PR whose head is this branch name. The dual path resolves both.
    if (nodes.length === 0) return { kind: "fallback", why: "no-pr" }
    node = pickBranchPr(nodes)
    if (node === undefined) return { kind: "fallback", why: "no-pr" }
  } else {
    return { kind: "fallback", why: "no-key" }
  }

  // A remembered number is a hint, not a fact: after a branch switch or a new
  // PR on the same branch it can point at the wrong PR. Both keys carry
  // headRefName, so a mismatch falls back to the authoritative branch lookup.
  const head = text(node?.headRefName)
  if (branch !== undefined && head !== undefined && head !== branch) {
    return { kind: "fallback", why: "stale-number" }
  }

  // Fast-path rule (item 7 / gate finding 1): a remembered number may only
  // answer while its PR is OPEN. A merged or closed PR on a reused branch means
  // the branch may already carry a newer open one, so the ordered branch query
  // decides instead of the hint. The branch key never revalidates.
  if (key.kind === "number" && String(node?.state ?? "").toUpperCase() !== "OPEN") {
    return { kind: "revalidate" }
  }

  const pr = prFromGraphql(node)
  if (pr === undefined) return { kind: "fallback", why: "unparsable" }
  const threads = foldThreads(node)
  // Threads are part of the folded contract; a reply without them is not the
  // reply that was asked for, so the dual path (which counts them separately)
  // takes over rather than painting a status with an unknown count.
  if (threads === undefined) return { kind: "fallback", why: "unparsable" }
  return { kind: "folded", pr, threads }
}
