---
name: pr-review
description: >-
  Review a pull request, deliver one verdict, and post the findings to GitHub as
  a comment review. Also runs the resolution flow for open review threads once
  the user approves the plan. Use when asked to review a PR, give a PR verdict,
  run an independent review of a branch or diff, or resolve PR review items.
  Gathers PR facts, delegates the verdict to the advisor subagent by default,
  posts issues as a COMMENT review (never approve/request-changes), and resolves
  threads only after a fix commit is pushed. Triggers: "review PR #", "review
  pull request", "PR verdict", "is this PR ready", "independent review",
  "resolve review items", "resolve PR threads".
---

# PR Review

**Output:** one verdict first, then findings ordered by severity. Real issues are
also posted to the PR as a single comment review; nothing is ever approved or
merged by this skill.

## Gather

Collect facts before forming any opinion; never guess a number, check state, or file line.

`main` has no shell: delegate these read-only commands to a worker with `gh`
(`code-worker`) and ask for the verbatim output, or a compact summary with the
exact values.

- `gh pr view <number> --json number,title,state,isDraft,reviewDecision,mergeable,mergeStateStatus,baseRefName,headRefName,headRefOid,statusCheckRollup,url` — PR state, review decision, mergeability, checks, head SHA.
- `gh pr diff <number>` — the actual change under review. Read the changed files in the worktree when the diff alone is ambiguous.
- `git fetch origin <base>` then `git rev-list --left-right --count origin/<base>...HEAD` — how far the branch has diverged; a stale base changes the review.
- `gh pr checks <number>` — failing, pending, and skipped checks by name.
- Repository conventions (test/lint commands, style) from `AGENTS.md` / `README` — judge the diff against the project's own rules.

If a fact is unavailable, say so in the review rather than inventing it.

## Independence

Default: delegate the review verdict itself to the `advisor` subagent — a different model family from the author of the change, which is the point.

- Give the advisor the PR number, base/head, the gathered facts, and the diff (or its path); ask for one verdict plus findings with `file:line`.
- If the `advisor` subagent is unavailable (permission denied, no such agent) or errors, fall back to reviewing in-session.
- Always state which mode ran: `Review mode: advisor` or `Review mode: in-session (advisor unavailable — <reason>)`.

## Verdict + Post

Lead with exactly one of, phrased as your own comment on the diff — a statement,
never an answer to a yes/no question:

- `Ready to merge` — nothing blocks it.
- `Not ready to merge — <X>` — one concrete blocker named in the sentence.

Never open with `No, not until <X>` or any yes/no phrasing: it reads as a reply
to the review request rather than a comment on the code.

Then findings, blockers first. Severity is carried by **order**, never by a bracket
tag (blocker > major > minor > nit). One finding per comment, in this shape:

- Symptom — one sentence saying what actually breaks.
- Why it is wrong — anchored at `path:line` (`src/x.ts:42`), naming the symbol.
- The fix — the concrete change, specific enough to apply.

**Voice.** It must read like a senior dev's comment on the diff, not a report about it:

- The first line is the verdict. Never open with process or state ("checked out the
  branch", "CI is green", "tests pass") — start with what you think of the change.
- No meta-commentary: no "everything else checked out", no "LGTM", no "as an AI".
  Unlisted findings stay unlisted.
- No approval language — "ship it" / "looks good" / thumbs-up are out; the verdict
  line already covers it.
- Concrete over general: name the symbol, the line, the command. "`retry()` at
  src/x.ts:42 has no cap" beats "retries could be improved".
- Plain text. No emoji, no bracket tags, no severity chips, no headings.

**Then post the issues to GitHub automatically.** This is part of the review, not
a separate confirmation step. Write the findings to a temp JSON file and
delegate one command to the `pr-writer` subagent via `task`:

```json
{
  "reviewedSha": "<full 40-hex SHA of the commit the findings were gathered against>",
  "summary": "2-4 sentences in your own voice: the verdict line plus the blocking reason, written as a comment on the diff rather than an answer to a question",
  "findings": [
    { "path": "src/x.ts", "line": 42, "body": "Retry loop never terminates: a closed socket re-enters `while (true)` with no cap. At src/x.ts:42 nothing bounds the attempts, so one dead connection pins a worker indefinitely. Cap attempts at 3 with backoff." }
  ]
}
```

```sh
~/.config/opencode/skills/pr-review/bin/post-review.sh <pr-url|owner/repo#n> <findings-json-file>
```

`post-review.sh` is the only way a review is posted here. It:

- requires `reviewedSha` to be the full 40-hex SHA you reviewed and to equal the
  PR's **current `headRefOid`**. If the head moved between gathering and posting
  it refuses the post ("head moved … re-review the new head") — findings for
  commit A never land on commit B;
- posts exactly one **COMMENT** review bound to that SHA (`commitOID`) — never
  approve, never request changes; the GraphQL mutation it sends has no
  APPROVE/REQUEST_CHANGES branch;
- turns every finding with `path` + `line` into an **inline review thread**,
  which is the only shape GitHub's `reviewThreads` exposes. A body-only review
  would never be visible to the modal, so `Resolve Review Items` would never
  fire — this is why findings are anchored, not summarised;
- appends findings without a usable path/line to the summary body instead;
- closes each review with only a `<!-- agent-review <reviewedSha> -->` marker (no
  attribution footer — the body reads as a plain comment on the diff), and prints `already-posted`
  (exit 0) when that SHA already has one. Re-post only after new commits move
  `headRefOid`;
- prints `no-findings` (exit 0) and posts nothing when `findings` is empty — a
  clean review is the normal path, not an error;
- refuses a merged/closed PR (GitHub rejects reviews there).

`line` must be a line inside the diff hunk, otherwise GitHub rejects the whole
review and nothing is posted.

Dedupe is **best effort per host**: one review per head SHA is enforced by the
marker plus an atomic local lock that serialises check+post on this machine. The
lock fails closed — any existing lock means "someone may be mid-post", so the
script refuses regardless of age and prints the lock path to remove by hand if a
previous run crashed (no automatic stale-lock stealing; a slow live post must
never lose its lock). Two machines (or another tool bypassing the wrapper) can
still post at the same instant, so treat the marker as the record, not as a
global guarantee.

Posting rules:

- Post only when real issues exist. No issues → empty `findings`; the script
  prints `no-findings` and the chat verdict is the whole deliverable.
- `main` has no shell. Delegate the `post-review.sh` call to `pr-writer` and have
  it report the printed result. Pass the findings **file path**, never the body
  on the command line; keep tokens and secret values out of logs and history.
  The delegated command must be the bare script invocation — no shell suffix
  (`; echo`, `&&`, pipes, redirects): permission rules match the whole command
  line, and compounds are denied.

Close with the verification actually performed (tests/lint run, or "not run") and
whether the review was posted. The shape follows the `review-summary` skill; load
it when the caller wants that exact format. If there are no findings:
`No findings.` after the verdict.

## Resolution

Trigger: the user's explicit **"Go ahead"** after you have presented a resolution
plan in chat. The plan is mandatory: list each open thread, the fix you intend,
and the files involved, then stop and wait. Never start changing code or resolving
threads before that approval.

List the open threads (id, path, first comment) before planning — `main` has no
shell, so delegate this read-only query to a worker with `gh` (`code-worker`):

```sh
gh api graphql -f query='
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){ nodes { id isResolved comments(first:1){ nodes { path body } } } }
    }
  }
}' -F owner=<owner> -F repo=<repo> -F number=<number>
```

After approval, in this order:

1. **Fix** each issue the user approved (implementation workers, blanket bash).
   Never touch a thread the fixes do not address.
2. **Commit and push** the fixes (never force-push) and record the pushed SHA.
3. **Resolve** with one delegated command per batch of addressed threads:

   ```sh
   ~/.config/opencode/skills/pr-review/bin/resolve-threads.sh <pr-url|owner/repo#n> <pushed-sha> <thread-id>...
   ```

   For each thread the script requires `<pushed-sha>` to be a **full 40-hex**
   SHA (prefixes, empty strings and non-hex values are refused), verifies it
   equals the PR's **current `headRefOid`** exactly (refusing *all* threads
   otherwise), verifies the thread belongs to this PR and is still unresolved,
   replies with the commit link, then resolves it — reply first, per thread. It
   skips an already-resolved thread with a note and exits non-zero if any
   thread failed.

Rules:

- Never resolve a thread before the fix commit is pushed.
- Never resolve a thread without replying on it first.
- Never resolve a thread whose issue the fixes did not address.
- If a thread cannot be resolved (permission, deleted thread, needs a product
  decision), report which thread and why, and leave it open.
- `main` has no shell: `resolve-threads.sh` runs only through the `pr-writer`
  subagent via `task`, as with the review post above.

## Modal affordances

The PR panel (`oc-pr-gui`) exposes both flows:

- `Review` — queues this review (gather, advisor verdict, comment post).
- `Resolve Review Items` — the filled primary when the PR is **open** and has
  unresolved review threads; queues the resolution flow above, plan and approval
  included. The chip may still show the count on a merged/closed PR, but the
  Resolve affordance is withheld there so it cannot displace `Continue on new
  branch` / `Create branch`.

## Never

- Never approve or request changes through a GitHub review state.
- Never resolve a review thread without the pushed fix commit and a reply on it.
- Never post more than one review per head SHA.
- Never merge, force-push, or promise a merge as part of a review or resolution.
- Never present a finding you did not observe in the diff or the worktree.
