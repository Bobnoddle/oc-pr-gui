# oc-pr-gui

OpenCode Desktop side panel: current branch's PR (state + checks) with a guarded
**Merge** button. Separate from `../oc-pr.ts`, which stays the agent-tool surface
and is not imported (single-file plugins are not importable).

## Layout

- `src/index.ts` — no-op server part (`Plugin.define`, id `oc-pr-gui`). Present
  because the v2.2.5 loader does not recognise a package that exports only
  `./gui-experimental`; `opencode plugin list` returns nothing in that case.
- `src/contract.ts` — `Ipc.define` bridge (window -> Electron main).
- `src/gui.tsx` — Solid panel, in-panel confirmation, `gh` in `main` (the window
  is sandboxed and cannot spawn processes).
- `dist/gui-experimental.cjs` — the built bundle OpenCode Desktop loads.

## Requirements

- **OpenCode Desktop 2.2.x** — the plugin is built against the 2.2.x plugin API.
- **`gh`**, signed in (`gh auth status`), for every PR read and merge.
- **`git`** on `PATH`; the panel reads the current branch and the merged-branch
  tidy deletes local branches through it.

Soft dependencies (used by the queued prompts, not by the panel itself):

- the **`pr-review`** skill — Review handoff;
- the **`advisor`** and **`pr-writer`** subagents — Review and Resolve handoffs.

Missing any of these does not break the panel: the handoff prompt degrades to a
plain instruction and the agent reports what it could not load.

## Build / check

From this directory:

```sh
bun install
bun run typecheck   # tsc --noEmit
bun run build       # writes dist/gui-experimental.cjs
bun run test        # bun test src
```

`devDependencies` pin `@opencode/plugin` at `2.2.5` to match the OpenCode
runtime, and `effect` at `4.0.6` so the SDK's type identities match.

## What you see

- A merged PR shows **Continue** (prepare the next change) and **Sign off**
  (close out the merged work) — no dead-end ghost buttons.
- Cleanup is automatic: the tidy pass deletes merged local branches and logs
  `git branch '<name>' '<oid>'` for each one, so any delete is undoable.
- Every destructive click is two-step: the first click arms, the second
  confirms.
- Handoff prompts are SHA-verified; gated plans require an approval token
  (`#resolve-413-9f2c1a`).
- Handoff buttons are one-shot per commit/state.
- Tidy is **off by default** until enabled.

## Merge safety

The button is a two-step action: **Merge** reveals a warning and a **Confirm
merge** button; only that second click calls `main`.

The dialog's merge primary (and **Merge & Reset**) is two-step too: the first
click only arms it (`armMerge`), relabeling it to **Confirm merge** / **Confirm
merge & reset** and showing the warning in the dialog body; the second click
runs the existing handler. The IPC confirmation literals are unchanged
(`confirm: "merge"` and `confirm: "reset"`), so `main` still refuses a call that
did not come through an explicit confirmation.

`main` then duplicates the `oc-pr.ts` validation:

- no merge unless the confirmation literal `merge` is present;
- PR number must be an integer, and its URL must match
  `https://github.com/<owner>/<repo>/pull/<number>`;
- number and URL must agree;
- the URL's repository must be the current `gh repo view` repository;
- only then: `gh pr merge <number> --squash --auto` (squash merge, matching how this repo's PRs are merged).

Difference from `oc-pr.ts`: there is no permission-assertion API in the Electron
main process, so this path relies on the explicit in-panel confirmation instead
of `ctx.permission.assert`. The agent tool `pr_merge` keeps its fail-closed
assertion.

## Merged branch tidy (reaper)

Merged work never survives locally, and the only way to lose something is by
clicking: the merged-state dialog no longer offers a "Back to main" ghost.
Instead, the window runs one automatic tidy pass per directory on the slow poll
tick (60 s, at most once per 10 minutes while the panel is hidden or idle):

- **One proof**: a local branch is deleted only when its tip equals the merged
  PR's head commit. A moved tip is unpushed work and is skipped.
- **Never switches branches**, and never touches the checked-out branch, a
  branch held by any worktree, the protected integration names (`main`,
  `master`, `trunk`, `develop`, `production`) or `origin/HEAD`.
- **Cap 5** per pass; the rest is the next pass's work (the panel does not
  repeat skips or truncation — they are routine).
- **Every delete logs its restore command** (`git branch <name> <oid>`) and the
  panel's last-pass line carries those commands on its title.

The switch inside the Merge flow — **Reset workspace after merge** — stays: it
is the one click that resets the workspace after an accepted merge. The reaper
tidy pass is preference-controlled by the panel's **Auto-tidy merged branches**
toggle: off until enabled once from the panel; per-directory opt-ins persist.

### How to undo

Each tidy deletes nothing you cannot restore with the command it logged:

```sh
git branch <name> <oid>
```

`<name>` and `<oid>` are exactly the values in the panel note's title. The
branch returns at the merged commit; nothing was rewritten.

## Agent handoffs

Fix, Review, Resolve, Sign off, Resolve conflicts and Continue queue a prompt
into the user's chat instead of acting themselves. Every prompt is
self-verifying and (where it gates a plan) approval-tokenized:

- Fix, Review, Resolve and Resolve conflicts end with an open-PR check naming
  the PR number and head commit (`gh pr view <n> --json state,headRefOid`); an
  agent that finds the PR moved, merged, or closed stops and reports instead of
  acting. When the panel has no head SHA the check compares against the branch
  tip (`git rev-parse`).
- Sign off ends with a merged-into-base check instead
  (`gh pr view <n> --json state,mergedAt,baseRefName`): the PR must still be
  merged into the base the plan was prepared against.
- Continue requires confirmation before any branch switch: an agent on any
  branch other than the named one — clean tree or not — reports the current
  branch and waits for instruction rather than switching.
- Fix handoff claims (one `${action}#${number}#${headSha}` key, action-prefixed
  so the six handoffs never block each other, with `nohead` standing in for a
  missing head sha) expire after 10 minutes. Expiry does not prove the first run
  finished: a manual Fix clicked after 10 minutes can duplicate an agent run
  that is still going. Accepted deliberately — a 10-minute silent failure is
  exactly what the retry affordance exists for, and the prompt's own
  stale-commit check refuses if the head has moved.
- Handoff buttons are one-shot per commit/state: a requested Fix, Review,
  Resolve, Resolve conflicts, Sign off or Continue renders disabled with an
  explanation and re-enables when the PR changes or after the 10-minute claim
  expires.
- Gated plans (Resolve, Sign off) require the user to quote an approval token
  such as `#resolve-413-9f2c1a` (action, PR number, first six SHA characters).
  A bare "go ahead" is explicitly not approval.
- Review keeps only its hard limits inline (COMMENT-only, never approve or
  request changes, never merge); the full review policy lives in the
  `pr-review` skill at `~/.config/opencode/skills/pr-review`.

## Verification limit

The desktop GUI cannot be loaded or rendered headlessly. After restarting
OpenCode Desktop, the PR tab should appear (pinned) in the session side panel.
