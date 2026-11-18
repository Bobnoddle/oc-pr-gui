#!/usr/bin/env bash
# resolve-threads.sh — the only write path that replies to and resolves review threads.
#
# Usage: resolve-threads.sh <pr-url|owner/repo#n> <commit-sha> <thread-id>...
#
# Rules enforced here, not left to the caller:
#   - <commit-sha> must equal the PR's current headRefOid. If it does not, the
#     fix is not pushed (or the caller passed a stale SHA) and *every* thread is
#     refused before any reply or resolve runs: resolve is all-or-nothing on the
#     commit check.
#   - every thread must belong to this PR and still be unresolved
#   - per thread: reply first (`addPullRequestReviewThreadReply`, body links the
#     pushed commit), then resolve (`resolveReviewThread`). Never the reverse.
#   - an already-resolved thread is skipped with a note, not counted as failure
#
# Exit: 0 every requested thread resolved or already resolved, 1 any failure
# (per-thread report on stdout/stderr), 2 usage.
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: resolve-threads.sh <pr-url|owner/repo#n> <commit-sha> <thread-id>...

  <pr-url>       https://github.com/OWNER/REPO/pull/N
  <commit-sha>   full 40-hex SHA of the pushed fix; must equal the PR's
                 current head commit exactly, otherwise nothing is touched
  <thread-id>    one or more PRRT_... review-thread node ids

For each thread: verify it belongs to the PR and is unresolved, reply with a
link to <commit-sha>, then resolve it. Prints one line per thread.
EOF
}

die() {
    printf 'resolve-threads: %s\n' "$*" >&2
    exit 1
}

if [[ $# -lt 3 ]]; then
    usage >&2
    exit 2
fi

target=$1
commit_sha=$2
shift 2
thread_ids=("$@")

owner=""
repo=""
number=""
if [[ $target =~ ^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/([0-9]+)([/?#].*)?$ ]]; then
    owner=${BASH_REMATCH[1]}
    repo=${BASH_REMATCH[2]}
    number=${BASH_REMATCH[3]}
elif [[ $target =~ ^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#([0-9]+)$ ]]; then
    owner=${BASH_REMATCH[1]}
    repo=${BASH_REMATCH[2]}
    number=${BASH_REMATCH[3]}
else
    die "target must be https://github.com/OWNER/REPO/pull/N or OWNER/REPO#N (got: $target)"
fi
slug="$owner/$repo"
expect="$slug#$number"

command -v gh >/dev/null 2>&1 || die "gh is not installed"

meta=$(gh pr view "$number" --repo "$slug" --json headRefOid,state,url --jq '[.headRefOid,.state,.url]|@tsv') ||
    die "could not read PR $expect"
IFS=$'\t' read -r head_sha pr_state pr_url <<<"$meta"

[[ -n $head_sha ]] || die "PR $expect has no head SHA"

# Exact head match only: a prefix, an empty string, or a non-hex value must
# never let a stale or guessed SHA through. 40 hex chars, either case, compared
# exactly (bash 3.2 has no ${var,,}, hence tr).
if [[ ! $commit_sha =~ ^[0-9a-fA-F]{40}$ ]]; then
    die "refused: commit SHA must be the full 40 hex characters of the pushed fix (got \"$commit_sha\"). No thread was touched."
fi
commit_lc=$(printf '%s' "$commit_sha" | tr '[:upper:]' '[:lower:]')
head_lc=$(printf '%s' "$head_sha" | tr '[:upper:]' '[:lower:]')
if [[ $commit_lc != "$head_lc" ]]; then
    die "refused: commit $commit_sha is not the PR's current head ($head_sha) — push the fix first. No thread was touched."
fi

commit_url="https://github.com/$owner/$repo/commit/$head_sha"
short_sha=${head_sha:0:12}
reply_body="Addressed in $commit_url (commit $short_sha)."

failures=0

for thread_id in "${thread_ids[@]}"; do
    if [[ ! $thread_id =~ ^PRRT_[A-Za-z0-9_=-]+$ ]]; then
        printf 'FAIL %s: not a review-thread node id (expected PRRT_...)\n' "$thread_id"
        failures=$((failures + 1))
        continue
    fi

    info=$(
        gh api graphql \
            -f query='query($id:ID!){node(id:$id){... on PullRequestReviewThread{id isResolved pullRequest{number repository{nameWithOwner}}}}}' \
            -F id="$thread_id" \
            --jq '[.data.node.isResolved, .data.node.pullRequest.number, .data.node.pullRequest.repository.nameWithOwner]|@tsv'
    ) || {
        printf 'FAIL %s: could not read the thread\n' "$thread_id"
        failures=$((failures + 1))
        continue
    }

    IFS=$'\t' read -r is_resolved thread_number thread_slug <<<"$info"

    if [[ $thread_slug == "null" || -z $thread_slug ]]; then
        printf 'FAIL %s: thread not found (deleted, or the id is not a review thread)\n' "$thread_id"
        failures=$((failures + 1))
        continue
    fi

    if [[ $thread_slug != "$slug" || $thread_number != "$number" ]]; then
        printf 'FAIL %s: belongs to %s#%s, not %s\n' "$thread_id" "$thread_slug" "$thread_number" "$expect"
        failures=$((failures + 1))
        continue
    fi

    if [[ $is_resolved == "true" ]]; then
        printf 'skip %s: already resolved\n' "$thread_id"
        continue
    fi

    # Reply first: a resolve without the commit link is not reviewable.
    if ! reply_url=$(
        gh api graphql \
            -f query='mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{url}}}' \
            -F thread="$thread_id" -F body="$reply_body" \
            --jq '.data.addPullRequestReviewThreadReply.comment.url'
    ); then
        printf 'FAIL %s: reply failed, thread left open\n' "$thread_id"
        failures=$((failures + 1))
        continue
    fi

    if ! resolved=$(
        gh api graphql \
            -f query='mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{isResolved}}}' \
            -F thread="$thread_id" \
            --jq '.data.resolveReviewThread.thread.isResolved'
    ); then
        printf 'FAIL %s: replied (%s) but resolve failed, thread left open\n' "$thread_id" "$reply_url"
        failures=$((failures + 1))
        continue
    fi

    if [[ $resolved != "true" ]]; then
        printf 'FAIL %s: replied (%s) but GitHub reports the thread still unresolved\n' "$thread_id" "$reply_url"
        failures=$((failures + 1))
        continue
    fi

    printf 'ok %s: replied (%s) and resolved at %s\n' "$thread_id" "$reply_url" "$short_sha"
done

if [[ $failures -gt 0 ]]; then
    printf 'resolve-threads: %s of %s thread(s) failed on %s\n' "$failures" "${#thread_ids[@]}" "$pr_url" >&2
    exit 1
fi

printf 'resolve-threads: all %s thread(s) resolved on %s\n' "${#thread_ids[@]}" "$pr_url"
