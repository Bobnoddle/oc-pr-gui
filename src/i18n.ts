// The plugin’s English copy, moved out of gui.tsx so it can be read (and
// tested) without loading Solid or the plugin host. Content is unchanged from
// the inline `en` catalog that `Plugin.define` consumed; `index.ts` lists this
// file in GUI_SOURCES so editing it still warns about a stale bundle.
//
// `Catalog` types a locale as `Readonly<Record<string, string>>`, so these keys
// are not a literal union: `ctx.t(key: string)` accepts any string and a missing
// key renders as the raw key. The i18n test pins the count and the exact values.
export const en = {
    "panel.title": "PR",
    "panel.checking": "Checking…",
    "panel.none": "No pull request for this branch.",
    "panel.noPr": "No PR yet for {{branch}}",
    "panel.notRepo": "Not a git repository",
    "panel.detached": "Detached HEAD at {{commit}} — no branch to open a pull request from.",
    "panel.detachedNoCommit": "Detached HEAD — no branch to open a pull request from.",
    "panel.timeout": "Timed out while checking for a PR.",
    "panel.statusError": "Could not read PR status.",
    "panel.mergeConflicts": "Merge conflicts — resolve locally before merging.",
    "panel.showOutput": "Show gh output",
    "panel.retry": "Retry",
    "panel.refresh": "Refresh",
    "panel.create": "Create PR",
    "panel.creating": "Creating…",
    "panel.commitFirst": "Commit + push first.",
    "panel.merge": "Merge",
    "panel.confirm": "Confirm merge",
    "panel.cancel": "Cancel",
    "panel.warning":
      "This runs `gh pr merge --squash --auto` for this PR in the current repository. Confirm to continue.",
    "panel.checks": "Checks",
    // The check-summary labels. `summarizeChecks` (./pure) picks the key and
    // supplies the count; these are the en forms it renders verbatim.
    "panel.checksFailingOne": "1 test failure",
    "panel.checksFailing": "{{count}} test failures",
    "panel.checksPending": "{{count}} pending",
    "panel.checksNone": "no checks",
    "panel.checksUnknown": "unknown",
    "panel.checksGreen": "all green",
    "panel.autoFixQueued": "Auto-fix queued",
    "panel.branch": "Branch",
    "panel.stateCreate": "no PR",
    "panel.statePending": "pending",
    "panel.stateOpen": "open",
    "panel.stateFailing": "failing",
    "panel.stateReviewItems": "review items",
    "panel.stateConflicts": "conflicts",
    "panel.stateUnknown": "checks unknown",
    "panel.stateMerged": "merged",
    "panel.stateClosed": "closed",
    "panel.stateError": "error",
    "chip.checking": "Checking pull request…",
    "chip.detached": "detached HEAD",
    "chip.noPr": "No pull request for this branch",
    "chip.merged": "Pull request merged",
    "chip.open": "Pull request",
    "chip.closed": "Pull request closed",
    "dialog.detachedBranch": "detached HEAD ({{commit}})",
    "dialog.detachedNoCommit": "detached HEAD",
    "dialog.create": "Create PR",
    "dialog.checkingAhead": "Checking the branch…",
    "dialog.checkingTitle": "Pull request status",
    "dialog.notPushed": "Branch not pushed to origin yet.",
    "dialog.ahead": "{{count}} commits not pushed.",
    "dialog.created": "Pull request created",
    "dialog.resolveConflicts": "Resolve conflicts",
    "dialog.mergeUnavailable": "Merge is not available for this pull request right now.",
    // A state that offers a handoff but has no PR number cannot name one in the
    // prompt; the handler refuses instead of printing "PR #".
    "dialog.noPrNumber": "No pull request number available — refresh and try again.",
    // The dialog captured its session at open; if that session moved to another
    // directory the prompt would land in the wrong project.
    "dialog.staleSession":
      "This dialog belongs to a different project directory. Close it and reopen from the session you want to act on.",
    "dialog.merged": "Merge requested",
    "dialog.commitPush": "Commit + Push",
    "dialog.commitPushFiles": "Files to commit ({{count}}):",
    "dialog.stashFiles": "Files to stash ({{count}}):",
    "dialog.uncommittedFiles": "Uncommitted files ({{count}}):",
    "dialog.noFiles": "(no files)",
    "dialog.filesMore": "…and {{count}} more files",
    "dialog.commitPushDone": "Committed {{count}} file(s) · {{pushed}}",
    // `errorDetail` carries its own final period where the baseline sentence
    // had one; the template itself never adds punctuation, so the exception
    // catch path renders `message(e)` verbatim.
    "dialog.commitPushFailed": "Commit + Push failed: {{error}}",
    "dialog.pushDone": "Pushed: {{result}}",
    "dialog.pushFailed": "Push failed: {{error}}",
    "dialog.continue": "Continue on new branch",
    "dialog.continueKeepChanges": "Continue on new branch & keep changes",
    "dialog.continuePrompt":
      "PR #{{number}} merged. You're now on {{branch}} (fresh from {{base}}) — continue the work here. If you are currently on a branch other than {{branch}}, report the current branch and wait for my instruction before switching.",
    "dialog.continueFailed": "Continue failed: {{error}}",
    "dialog.signOff": "Sign off",
    "dialog.signOffPrompt":
      "Prepare to sign off on merged PR #{{number}} ({{branch}} merged into {{base}}). Work in two layers. Layer 1 — gather, verify, prepare, but change nothing: run git status and git diff; establish this repo's delivery topology — what production deploys from (a base branch such as master, or a prod/release branch that bundles releases);" +
      "\nthen trace every change in the PR to the furthest verifiable stage of that pipeline — merged, base-branch CI green (the PR's own pre-merge checks do not prove the base is green), deployed with a production review when topology and access allow, or the integration branch when releases bundle changes — verifying 100% of shipped commits reach that stage, with no spot checks." +
      "\nClassify all {{count}} uncommitted/untracked file(s) as (a) part of the merged work that was missed, (b) an unrelated leftover, or (c) a disposable artifact. Then classify the direction as immediate sign-off, deployment change needed, or code change / follow-up PR needed; directions may combine, so name a primary and list every item." +
      "\nPrepare only the safe next step for that direction: draft the exact commands, verify the Railway project link and ssh reachability with explicit --project and --environment where relevant, and at most create one unused branch named signoff/<topic> — never switch to it, never push, never mutate the deployment, and never print secret values (names only)." +
      "\nLayer 2 — present exactly one outcome: \"Signed off\" with a per-stage checklist (for immediate sign-off there is nothing to prepare; when the destination is a release train, add a deferred-stage note recording what the next release must verify); or \"Prepared: deployment change\" / \"Prepared: follow-up PR\" listing every prepared artifact (branch, verified link, probe results) and each action you will take on approval; or \"Sign-off blocked: <reason>\" when preparation itself failed, stating what stopped it." +
      "\nName anything you could not verify rather than assuming it. Wait for my explicit \"Go ahead {{token}}\" — a bare \"go ahead\" that does not quote this token is not approval, so ask me to confirm which plan; after my {{token}} approval, execute exactly the prepared plan — deployment mutations happen only now, and a follow-up branch or PR goes through the normal flows delegated to a shell worker. Never merge, and never start anything not in the plan. {{stale}}",

    "dialog.signOffResult": "Sign off: {{delivery}}",
    "dialog.signOffFailed": "Sign off failed: {{error}}",
    "dialog.createBranch": "Create branch from base",
    "dialog.createBranchDone": "Created {{branch}} from {{base}} — continue the work here.",
    "dialog.createBranchFailed": "Create branch failed: {{error}}",
    "dialog.stashCreate": "Create branch & keep changes",
    "dialog.stashCreateDone":
      "Created {{branch}} from {{base}} and restored your changes. {{retention}}",
    "dialog.stashCreateDoneNoStash": "Created {{branch}} from {{base}} and restored your changes.",
    "dialog.stashCreateFailed": "Create branch & keep changes failed.",
    "dialog.stashRestoreFailed": "Branch created, but the stash was not restored: {{error}}",
    "dialog.resetFailed": "Reset failed: {{error}}",
    "dialog.mergeReset": "Merge & Reset",
    "dialog.confirmMergeReset": "Confirm merge & reset",
    "dialog.mergeResetAsk": "Reset workspace after merge",
    "dialog.mergeResetFailed": "Merge requested, but the reset failed: {{error}}",
    "dialog.mergeRequestFailed": "Merge request failed: {{error}}",
    // Every handoff prompt ends with one of these clauses: the agent re-reads
    // the PR's live state before acting, so a stale panel can never make it
    // push, resolve, sign off, or approve against the wrong head. Without a
    // head SHA the check compares against the branch tip instead.
    "dialog.staleOpen":
      "Before acting, verify PR #{{number}} is still open on commit {{sha}} with `gh pr view {{number}} --json state,headRefOid`; if not, stop and report what changed instead of acting.",
    "dialog.staleOpenBranch":
      "Before acting, verify PR #{{number}} is still open on branch {{branch}}: run `gh pr view {{number}} --json state,headRefOid` and compare headRefOid against the branch tip from `git rev-parse {{branch}}`; if not, stop and report what changed instead of acting.",
    "dialog.staleMerged":
      "Before anything else, verify PR #{{number}} is still merged into {{base}} with `gh pr view {{number}} --json state,mergedAt,baseRefName`; if not, stop and report.",
    "dialog.fix": "Fix Errors",
    "dialog.fixPrompt":
      "CI is failing on {{branch}} (PR #{{number}}). Diagnose the failing check, fix it, run the tests locally, then commit and push. {{stale}}",
    "dialog.fixFailed": "Fix Errors failed: {{error}}",
    "dialog.queued": "Queued",
    "dialog.sent": "Sent",
    // An unknown/future delivery value (or a reply that omits one) must not claim
    // the prompt was sent.
    "dialog.pending": "Pending — the agent will report in the chat",
    // One-shot handoff buttons: while the claim for this PR state is live the
    // button renders disabled with this line as its title/aria-label.
    "dialog.handoffDone":
      "Already requested for this state — the agent has it. It re-enables when the PR changes or after 10 minutes.",
    "dialog.fixResult": "Fix Errors: {{delivery}}",
    "dialog.review": "Review",
    "dialog.reviewPrompt":
      "Review PR #{{number}} ({{head}} → {{base}}). Load the `pr-review` skill and follow it exactly, including its delegation rules and posting rules. Hard limits that hold even if the skill fails to load: post a COMMENT review only — never approve, never request changes; never merge; lead with the verdict. {{stale}}",
    "dialog.reviewResult": "Review: {{delivery}}",
    "dialog.reviewFailed": "Review failed: {{error}}",
    "dialog.resolve": "Resolve Review Items",
    "dialog.resolvePrompt":
      "PR #{{number}} has {{count}} unresolved review thread(s). Load the `pr-review` skill and follow its Resolution section. First present a resolution plan and wait for my explicit \"Go ahead {{token}}\" — change nothing and resolve no thread before that approval. After approval: implement the fixes, commit and push them, then delegate the `pr-review` skill's `resolve-threads.sh` wrapper to the `pr-writer` subagent for the threads the pushed fix addressed (it replies with the commit link before resolving, and refuses a stale head SHA). Never resolve a thread the fixes did not address. If a thread cannot be resolved, report which and why. A bare \"go ahead\" that does not quote this token is not approval — ask me to confirm which plan. {{stale}}",
    "dialog.resolveResult": "Resolve: {{delivery}}",
    "dialog.resolveFailed": "Resolve failed: {{error}}",
    "dialog.conflictsPrompt":
      "PR #{{number}} has merge conflicts against {{base}}. Check out {{head}}, run git fetch origin, merge origin/{{base}} into it, resolve every conflict, run the test suite, then commit the merge and push {{head}}. Never merge the PR and never force-push. {{stale}}",
    "dialog.conflictsResult": "Resolve conflicts: {{delivery}}",
    "dialog.conflictsFailed": "Resolve conflicts failed: {{error}}",
    "dialog.metaNoNumber": "{{head}} → {{base}}",
    "dialog.metaOpensGithub": "Open PR #{{number}} on GitHub",
    "dialog.factChecks": "Checks",
    "dialog.factReview": "Review",
    "dialog.factConflicts": "Conflicts",
    "dialog.chipChecksPassing": "Checks passing",
    "dialog.chipChecksFailing": "Checks failing",
    "dialog.chipChecksPending": "Checks pending",
    "dialog.chipChecksUnknown": "Checks not run",
    "dialog.checksUnknown": "Checks state unknown",
    "dialog.chipReviewApproved": "Review approved",
    "dialog.chipReviewPending": "Review pending",
    "dialog.chipReviewChanges": "Changes requested",
    "dialog.chipReviewNone": "No review",
    "dialog.chipThreadsOpen": "{{n}} open items",
    "dialog.chipThreadsOpenTitle": "{{n}} unresolved review item(s)",
    "dialog.chipThreadsClear": "No unresolved review items",
    "dialog.chipConflicts": "Merge conflicts",
    "dialog.chipConflictsNone": "No conflicts",
    "dialog.chipConflictsUnknown": "Conflicts unknown",
    "dialog.chipChanges": "Changes ({{count}})",
    "dialog.chipChangesUncommitted": "Uncommitted",
    "dialog.chipChangesTitle": "{{count}} uncommitted change(s)",
    "confirm.detachedTitle": "Create branch from base?",
    "confirm.mergedTitle": "Continue from PR #{{number}}?",
    "confirm.failingTitle": "Fix failing checks on PR #{{number}}?",
    "confirm.conflictsTitle": "Resolve conflicts on PR #{{number}}?",
    "confirm.mergeTitle": "Merge PR #{{number}}?",
    "confirm.dirtyTitle": "Commit + push?",
    "confirm.pushTitle": "Push & open a PR?",
    "confirm.createTitle": "Open a PR for {{branch}}?",
    "confirm.errorTitle": "PR status failed",
    "confirm.retry": "Retry",
    "confirm.pushThenCreate": "Push, then Create PR",
    "confirm.pushOnly": "Push only",
    "confirm.progressPushing": "Pushing…",
    "confirm.progressCreating": "Creating PR…",
    "confirm.progressReset": "Merge requested; resetting the workspace…",
    "panel.openInGitHub": "Open in GitHub",
    "panel.autoFix": "Auto-fix failing checks",
    "panel.autoFixOn": "On",
    "panel.autoFixOff": "Off",
    // The reaper's panel copy. `panel.tidied` is the one-line last-pass summary
    // (three names max, then an ellipsis); `panel.tidyRestore` is its title,
    // one logged `git branch <name> <oid>` command per line.
    "panel.tidy": "Auto-tidy merged branches",
    "panel.tidied": "Tidied merged branches: {{list}}",
    "panel.tidyFailed": "Tidy pass failed — will retry",
    "panel.tidyRestore": "Restore: {{cmds}}",
    "chip.pushFirst": "Push first",
    "chip.unpushed": "{{count}} unpushed",
    "chip.commitPush": "Commit + push",
}
