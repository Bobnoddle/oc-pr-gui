import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

// Window <-> Electron-main bridge.
//
// The window is sandboxed and cannot spawn processes, so `gh` runs in the
// desktop app's main process (`main` in gui.tsx). The Ipc id must be the plugin
// id (`oc-pr-gui`, from package.json) or under it.
export const PrPanel = Ipc.define({
  id: "oc-pr-gui",
  methods: {
    // Returns JSON: PrData from gui.tsx.
    status: {
      input: Schema.Struct({ directory: Schema.String }),
      output: Schema.String,
    },
    // `confirm` is the literal "merge": the panel only sends it after the
    // user's explicit second click. Anything else is refused in main.
    merge: {
      input: Schema.Struct({
        directory: Schema.String,
        number: Schema.Number,
        url: Schema.String,
        confirm: Schema.Literal("merge"),
      }),
      output: Schema.String,
    },
    // Backend only for now: the Create PR chip in the panel calls this when
    // `status` reports there is no PR for the branch. All optional fields are
    // validated in main before they reach gh's argv. `body` is the confirm
    // dialog's description field; omitted or blank keeps the empty `--body=`
    // this method used to send.
    create: {
      input: Schema.Struct({
        directory: Schema.String,
        title: Schema.optional(Schema.String),
        base: Schema.optional(Schema.String),
        body: Schema.optional(Schema.String),
      }),
      output: Schema.String,
    },
    // Origin/local divergence: ahead, behind, dirty, the number of changed
    // entries and the capped porcelain file list. `ahead` enables Create PR and
    // the Push row; `dirty` enables Commit + Push; `behind` is an informational
    // context line. The output is JSON: { ahead, behind, dirty, changes, files,
    // noUpstream, base? } — every field of `Divergence` in git.ts. `changes` is
    // the entry count (`files` is capped, so its length is not the count).
    // `base` is the repository default branch (absent = unknown, never a guess).
    ahead: {
      input: Schema.Struct({ directory: Schema.String }),
      output: Schema.String,
    },
    // Unresolved review threads for one PR, counted after `status` has painted:
    // the GraphQL call is decoration and must not hold the panel back. `url`
    // names the base repository and is validated in main before it reaches the
    // query. The output is JSON: { unresolved } | null (null = unknown).
    threads: {
      input: Schema.Struct({
        directory: Schema.String,
        url: Schema.String,
        number: Schema.Number,
      }),
      output: Schema.String,
    },
    // Snapshot commit of everything except `.env`, `.orch/` and secret-shaped
    // files, then push. `confirm` is the literal "commit": the panel only sends
    // it after the user has reviewed the file list.
    commitPush: {
      input: Schema.Struct({
        directory: Schema.String,
        confirm: Schema.Literal("commit"),
      }),
      output: Schema.String,
    },
    // Push existing commits. `confirm` is the literal "push".
    push: {
      input: Schema.Struct({
        directory: Schema.String,
        confirm: Schema.Literal("push"),
      }),
      output: Schema.String,
    },
    // Per-directory opt-in for "Auto-fix failing checks". Omit `enabled` to
    // read; the output is JSON: { enabled }. Persisted by main to
    // ~/.local/share/opencode/oc-pr-gui-auto-fix.json.
    autoFix: {
      input: Schema.Struct({
        directory: Schema.String,
        enabled: Schema.optional(Schema.Boolean),
      }),
      output: Schema.String,
    },
    // Per-directory opt-in for the branch reaper. Omit `enabled` to read; the
    // output is JSON: { enabled, known }. `enabled` is trustworthy only when
    // `known` is true, and a MISSING file means DISABLED (the opposite of the
    // old default): a fresh install deletes nothing until the user flips the
    // panel's auto-tidy switch once, which writes the opt-in. Stored values are
    // obeyed, and every reaper delete is reversible through the restore command
    // it logs. A file that exists but cannot be read or parsed fails CLOSED
    // ({ enabled: false, known: false }) — it cannot prove the user opted in, so
    // the pass does not run and the panel's switch shows Off until an explicit
    // toggle writes the file again. Persisted by main to
    // ~/.local/share/opencode/oc-pr-gui-reaper.json.
    reaper: {
      input: Schema.Struct({
        directory: Schema.String,
        enabled: Schema.optional(Schema.Boolean),
      }),
      output: Schema.String,
    },
    // One tidy pass over MERGED PR branches in `directory`'s repository. Main
    // never switches branches, never touches the checked-out or a worktree-held
    // branch, and deletes only when the local tip is exactly the merged PR's
    // headRefOid. At most 5 branches per pass. The output is JSON:
    // { reaped: [{ branch, number, oid, restore }], skipped: [{ branch, reason }],
    // truncated }. `restore` is the exact `git branch` command that brings the
    // deleted branch back.
    reap: {
      input: Schema.Struct({ directory: Schema.String }),
      output: Schema.String,
    },
    // After a merge, start a fresh branch from the PR's base so work can go on
    // without reusing the merged branch. Main refuses a dirty worktree, fetches,
    // resolves the base and runs `git switch -c <branch>`. `branch` is the
    // optional name from retained backend callers (the GUI no longer supplies
    // one): blank falls back to `continue/<timestamp>`,
    // and an invalid or already-taken name is refused before any mutation. The
    // reply is JSON: { ok: true, branch, base } | { ok: false, error }.
    continueWork: {
      input: Schema.Struct({
        directory: Schema.String,
        stash: Schema.optional(Schema.Boolean),
        branch: Schema.optional(Schema.String),
      }),
      output: Schema.String,
    },
    // Guarded post-merge reset, sent only after the user clicks `Reset
    // workspace` (or `Merge & Reset` once the merge call was accepted).
    // `confirm` is the literal "reset". Main refuses a detached HEAD, a dirty
    // worktree, a branch with commits not in the fetched remote base, and a
    // local base that is not a fast-forward of origin; it never forces and
    // never removes the worktree directory. `number` is optional and additive:
    // it names the PR so main can confirm via `gh pr view` that the branch was
    // squash-merged, which is the only way a branch with commits outside the
    // base can still be deleted. Omitted or unmatched, the reset refuses. The
    // reply is JSON: { ok: true, steps: string[] } | { ok: false, error, steps }.
    resetWorkspace: {
      input: Schema.Struct({
        directory: Schema.String,
        confirm: Schema.Literal("reset"),
        number: Schema.optional(Schema.Number),
      }),
      output: Schema.String,
    },
  },
})

// A gh failure is usually not an error worth showing raw: a branch without a
// PR and a directory outside a repository are normal states. Only anything
// else is a genuine failure. Mirrored in oc-pr.ts (a single-file plugin cannot
// import this module) and covered by a unit check.
export type GhErrorKind = "none" | "not-repo" | "error"

// Why `status` has no PR to show. `detached` is a normal state too: the HEAD
// commit exists but no branch does, so gh cannot resolve a pull request and is
// never asked. Kept beside GhErrorKind so the window and main agree.
export type PrFailureReason = GhErrorKind | "timeout" | "cancelled" | "detached"

export function classifyGhError(stderr: string): GhErrorKind {
  const s = stderr.toLowerCase()
  if (s.includes("no pull requests found for branch")) return "none"
  if (s.includes("not a git repository") || s.includes("no git repository")) return "not-repo"
  return "error"
}

// A `gh pr create` failure that the user can act on. `exists` is usually caught
// by createPr's pre-check; it covers the race where the PR appears between the
// check and the create. `same-branch` is the head == base refusal, which
// createPr's pre-flight normally catches first. Anything else stays a bounded
// raw first line.
export type CreateErrorKind = "not-pushed" | "no-commits" | "exists" | "same-branch" | "unknown"

export function classifyCreateError(stderr: string): CreateErrorKind {
  const s = stderr.toLowerCase()
  if (s.includes("must first push the current branch")) return "not-pushed"
  if (s.includes("no commits between")) return "no-commits"
  if (s.includes("already exists") || s.includes("a pull request for")) return "exists"
  // gh: `head branch "main" is the same as base branch "main", cannot create a
  // pull request`. Anchored at the start and paired with the full comparison
  // phrase so an unrelated line mentioning a base branch cannot match.
  if (/^head branch .+ is the same as base branch .+, cannot create a pull request/.test(s)) return "same-branch"
  return "unknown"
}
