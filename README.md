# oc-pr-gui

OpenCode Desktop side panel: current branch's PR (state + checks) with a guarded
**Merge** button. Separate from the `oc-pr` plugin at
`~/.config/opencode/plugins/oc-pr.ts`, which stays the agent-tool surface and is
not imported (single-file plugins are not importable).

## Install

Install from the registry:

```sh
opencode plugin add oc-pr-gui
```

That installs the package **and** writes the entry to the **global**
`~/.config/opencode/opencode.jsonc` `plugins` array. Restart Desktop
afterwards. Verified end-to-end on Desktop 2.3.0 / CLI `2.2.5`.

Verify with `opencode plugin list` — expect a row `oc-pr-gui  local  <path>`.
Run it twice if needed — the first run in a fresh cwd can print
`No plugins found`.

### Installing from source

1. Clone into the global plugins directory:

   ```sh
   git clone https://github.com/Bobnoddle/oc-pr-gui.git ~/.config/opencode/plugins/oc-pr-gui
   ```

2. Install its dependencies. A full `bun install` is required — the server entry
   imports `@opencode/plugin` at load time:

   ```sh
   cd ~/.config/opencode/plugins/oc-pr-gui && bun install
   ```

3. `bun run build` is only needed if you change `src/`. The committed
   `dist/gui-experimental.cjs` is byte-identical to a fresh build.

4. Add the **absolute** path to the **global** config
   `~/.config/opencode/opencode.jsonc`, inside its existing `"plugins"` array:

   ```jsonc
   {
     "plugins": [
       "/Users/<you>/.config/opencode/plugins/oc-pr-gui"
     ]
   }
   ```

   Desktop reads GUI plugins from the global config only: an entry in a
   project-local `opencode.json` loads the server part but not the Desktop panel.

5. Restart OpenCode Desktop.

6. Verify as above: `opencode plugin list` — expect a row
   `oc-pr-gui  local  <that path>`.

### Why not `opencode plugin add github:…`?

`opencode plugin add github:Bobnoddle/oc-pr-gui` fails on CLI `2.2.5` with
`git dep preparation failed` — the `https` form fails the same way. Its bundled
npm child dies during git-dep preparation, so nothing is cloned or configured.
On the same CLI `2.2.5` a registry install does succeed (`opencode plugin add
zod`). A config-level `"plugins": ["github:…"]` entry is silently ignored by
`plugin list`. The registry install above (`opencode plugin add oc-pr-gui`) is
the supported path; the source route is the fallback.

### Uninstall

To disable: remove the path entry from `"plugins"` in
`~/.config/opencode/opencode.jsonc` and restart Desktop. To uninstall fully,
also delete the clone directory. Nothing else is written outside
`~/.local/share/opencode/oc-pr-gui-auto-fix.json` and
`~/.local/share/opencode/oc-pr-gui-reaper.json` (the per-directory panel
opt-ins, under `$XDG_DATA_HOME/opencode` when that variable is set), which you
can delete too.

## Requirements

- **OpenCode Desktop 2.3.0** (CLI `2.2.5`) — the plugin is built against the
  2.2.5 plugin API and verified loading on Desktop 2.3.0; older 2.2.x is
  untested.
- **`gh`**, signed in (`gh auth status`), for every PR read and merge.
- **`git`** on `PATH`; the panel reads the current branch and the merged-branch
  tidy deletes local branches through it.
- **Bun** on `PATH` — the install step runs `bun install` and a rebuild from
  `src/` runs `bun run build`.
- The target repository must have a GitHub **`origin`** remote. Every read path
  resolves the repo from `origin`; without it the panel reports "could not
  resolve the repository from origin" and shows nothing.

Soft dependencies (used by the queued prompts, not by the panel itself):

- the **`pr-review`** skill — bundled with the plugin and registered only when
  no skill with that id already exists; a copy you installed yourself wins.
  The bundled copy is a vendored snapshot of the author's skill and can drift
  from your own — your existing copy always wins and the bundled one is only a
  fallback for fresh installs;
- the **`advisor`** and **`pr-writer`** subagents — recommended external deps
  for the Review and Resolve handoffs.

Missing any of these does not break the panel: the handoff prompt degrades to a
plain instruction and the agent reports what it could not load.

## Development

From this directory:

```sh
bun install
bun run typecheck   # tsc --noEmit
bun run build       # writes dist/gui-experimental.cjs
bun run test        # bun test src
```

CI: `.github/workflows/ci.yml` runs typecheck, tests, and a dist-freshness check on every push/PR.

`@opencode/plugin` is a runtime `dependency` pinned at `2.2.5` to match the
OpenCode runtime: the server entry imports it at load, so it has to ship.
`devDependencies` stay development-only — `effect` at `4.0.6` so the SDK's type
identities match, plus the rest of the build toolchain.

## What you see

- A merged PR shows **Continue on new branch** (**Continue on new branch & keep
  changes** when the tree is dirty) to prepare the next change, and **Sign off**
  to close out the merged work — no dead-end ghost buttons.
- Cleanup is automatic: the tidy pass deletes merged local branches and logs
  `git branch '<name>' <oid>` for each one, so any delete is undoable.
- **Merge** is the two-step action (**Merge & Reset** too, since it resets the
  workspace after the same confirmation): the first click arms and relabels the
  primary, the second confirms. Commit + Push and Reset also refuse to run
  without their confirmation literal (the dirty row reads **Commit & push to
  <base>** when you are on the default branch). The handoff buttons — **Fix**,
  **Review**, **Resolve**, **Resolve conflicts**, **Continue**, **Sign off** —
  queue a prompt on one click and are one-shot per commit instead.
- On the repository's default branch the rows that assume a PR can be opened are
  swapped: **Move to new branch** for a dirty tree, **Push to <base>** for an
  unpushed one, and **Create branch from base** where **Create PR** would be,
  with **Commit & push to <base>** as the ghost. A branch cannot open a PR
  against itself, so these offer the step that makes one possible instead of an
  action `gh` would refuse; an unresolved default branch keeps the old rows.
  Create PR also refuses head == base itself, without calling `gh pr create`.
- The confirm dialog takes a **branch name** when the click will create a branch
  (prefilled with the `continue/<timestamp>` it would have picked), and a **PR
  title** (prefilled with the branch) plus a **description** when it will open a
  PR. Leave a field empty and the old automatic behaviour stays: the timestamped
  name, the branch name as title, no description. A name that is invalid or
  already exists is refused before anything is touched: no fetch, no stash, no
  branch — git's own `check-ref-format` decides what counts as valid.
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
  branch held by any worktree, the fixed integration names (`main`, `master`,
  `trunk`, `develop`), the repository's own integration branch (read from
  `origin/HEAD`, falling back to GitHub's default branch), or `origin/HEAD`
  itself. A pass aborts entirely when neither source can be read.
- **Cap 5** per pass; the rest is the next pass's work (the panel does not
  repeat skips or truncation — they are routine).
- **Every delete logs its restore command** (`git branch '<name>' <oid>`) and
  the panel's last-pass line carries those commands on its title.

The switch inside the Merge flow — **Reset workspace after merge** — stays: it
is the one click that resets the workspace after an accepted merge. The reaper
tidy pass is preference-controlled by the panel's **Auto-tidy merged branches**
toggle: off until enabled once from the panel; per-directory opt-ins persist.

### How to undo

Each tidy deletes nothing you cannot restore with the command it logged:

```sh
git branch '<name>' <oid>
```

`<name>` and `<oid>` are exactly the values in the panel note's title. The
branch name is single-quoted because git allows `$`, `;` and quotes in a name;
the quotes are required to keep the logged line paste-safe. The branch returns
at the merged commit; nothing was rewritten.

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
  A bare "go ahead" is explicitly not approval. The queued prompt prints its own
  token in its `Go ahead #…` line — copy that line back, including the token; a
  reply without it is rejected as not-approval.
- Review keeps only its hard limits inline (COMMENT-only, never approve or
  request changes, never merge); the full review policy lives in the bundled
  `pr-review` skill (`skills/pr-review/SKILL.md`), registered only when you do
  not already have a skill with that id. That bundle is a vendored snapshot of
  the author's skill and can drift from your own — your existing copy always
  wins and the bundled one is only a fallback for fresh installs. The `advisor`
  and `pr-writer` subagents remain recommended external deps for the
  Review/Resolve handoffs.

## Verification limit

The desktop GUI cannot be loaded or rendered headlessly. After restarting
OpenCode Desktop, the PR tab should appear (pinned) in the session side panel.

## Layout

- `src/index.ts` — no-op server part (`Plugin.define`, id `oc-pr-gui`). Present
  because the v2.2.5 loader does not recognise a package that exports only
  `./gui-experimental`; `opencode plugin list` returns nothing in that case.
- `src/contract.ts` — `Ipc.define` bridge (window -> Electron main).
- `src/gui.tsx` — Solid panel, in-panel confirmation, `gh` in `main` (the window
  is sandboxed and cannot spawn processes).
- `dist/gui-experimental.cjs` — the built bundle OpenCode Desktop loads.
