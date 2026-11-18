#!/usr/bin/env bash
# post-review.sh — the only write path that posts an agent PR review.
#
# Usage: post-review.sh <pr-url|owner/repo#n> <findings-json-file>
#
# Findings file shape (strict):
#   {
#     "reviewedSha": "<40 hex chars — the commit the findings were gathered against>",
#     "summary": "one paragraph, plain text",
#     "findings": [
#       { "path": "src/file.ts", "line": 12, "body": "what is wrong + fix" },
#       { "body": "finding with no usable path/line" }
#     ]
#   }
#
# What it does:
#   - refuses anything but a local file path; the file *contents* are the only
#     payload (never shell args, so code snippets and apostrophes are safe)
#   - requires `reviewedSha` to be a full 40-hex SHA and to equal the PR's
#     *current* headRefOid. If the head moved between gathering and posting the
#     review is refused: findings for commit A must never land on commit B
#   - binds the posted review to that SHA (`commitOID`) and keys its dedupe
#     marker on it (`<!-- agent-review <sha> -->`), so a repeat prints
#     `already-posted` and exits 0 without touching GitHub
#   - empty `findings` prints `no-findings` and exits 0: a clean review posts
#     nothing, it is not an error
#   - a finding with a usable path + line becomes an inline thread
#     (addPullRequestReview -> threads:[{path,line,body}]), which is the only
#     shape GitHub's reviewThreads exposes, so the modal can count and resolve
#     it. Findings without a usable path/line are appended to the summary body
#   - event is hard-coded COMMENT. APPROVE / REQUEST_CHANGES are never sent:
#     the mutation below has no branch that can emit them
#   - dedupe is best-effort per machine: an atomic mkdir lock serialises
#     check+post for this PR on this host, and review discovery is cursor
#     paginated. The lock fails closed (no auto-stale-steal): a crashed run's
#     lock is removed by hand, per the refusal message. Two machines (or another
#     tool holding no lock) posting at the same instant can still produce two
#     reviews; that residual race is accepted — the marker keeps it visible and
#     a human can clean up
#
# Exit: 0 posted / already-posted / no-findings, 1 failure (nothing posted), 2 usage.
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: post-review.sh <pr-url|owner/repo#n> <findings-json-file>

  <pr-url>             https://github.com/OWNER/REPO/pull/N
  owner/repo#n         same PR, short form
  <findings-json-file> local JSON:
                       {"reviewedSha": "<40 hex>", "summary": "...",
                        "findings": [{"path": "...", "line": 12, "body": "..."}]}

Posts one COMMENT review bound to `reviewedSha`, which must be the PR's current
head commit. Prints the review URL, `already-posted` (that head already carries
an agent review), or `no-findings` (findings was empty — nothing is posted).
Never approves and never requests changes.
EOF
}

die() {
    printf 'post-review: %s\n' "$*" >&2
    exit 1
}

if [[ $# -ne 2 ]]; then
    usage >&2
    exit 2
fi

target=$1
findings_file=$2

[[ -f $findings_file ]] || die "findings file not found: $findings_file"
[[ -r $findings_file ]] || die "findings file is not readable: $findings_file"

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

command -v gh >/dev/null 2>&1 || die "gh is not installed"
command -v python3 >/dev/null 2>&1 || die "python3 is required to build the GraphQL payload"

meta=$(gh pr view "$number" --repo "$slug" --json headRefOid,state,url,id --jq '[.headRefOid,.state,.url,.id]|@tsv') ||
    die "could not read PR $slug#$number"
IFS=$'\t' read -r head_sha pr_state pr_url pr_node_id <<<"$meta"

[[ -n $head_sha ]] || die "PR $slug#$number has no head SHA"
[[ -n $pr_node_id ]] || die "PR $slug#$number has no GraphQL node id"

tmp_root="${TMPDIR:-/tmp}"
tmp_root="${tmp_root%/}"
payload=$(mktemp "$tmp_root/post-review.XXXXXX.json")
lock_dir="$tmp_root/oc-pr-review-${owner}-${repo}-${number}.lock"
# Ownership token: the only thing that may authorise deleting the lock dir.
lock_token="$$-$(date +%s)-$RANDOM"
lock_owned=0
cleanup() {
    rm -f "$payload"
    # Delete the lock only when the token on disk is this process's: a rival
    # may have replaced the directory, and that replacement is not ours to
    # remove. A missing/unreadable token also means "not ours" (fail closed).
    if [[ $lock_owned -eq 1 ]]; then
        local on_disk
        on_disk=$(cat "$lock_dir/token" 2>/dev/null || true)
        if [[ $on_disk == "$lock_token" ]]; then
            rm -rf "$lock_dir"
        fi
    fi
}
trap cleanup EXIT

# Validate + normalise the findings file and build the whole GraphQL request
# body. Everything user-supplied goes through json.dumps: no shell quoting.
counts=$(
    python3 - "$findings_file" "$pr_node_id" "$payload" <<'PY'
import json
import re
import sys

findings_path, pr_node_id, payload_path = sys.argv[1:4]

QUERY = (
    "mutation($pullRequestId:ID!,$commitOID:GitObjectID,$body:String!,$threads:[DraftPullRequestReviewThread!]){"
    " addPullRequestReview(input:{pullRequestId:$pullRequestId,commitOID:$commitOID,event:COMMENT,"
    " body:$body,threads:$threads})"
    " { pullRequestReview { url state commit { oid } } } }"
)

# No attribution footer: the body must read as a plain comment on the diff.
SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")


def fail(message):
    print(f"post-review: findings file: {message}", file=sys.stderr)
    sys.exit(2)


try:
    with open(findings_path, encoding="utf-8") as handle:
        data = json.load(handle)
except (OSError, json.JSONDecodeError) as exc:
    fail(f"not readable JSON ({exc})")

if not isinstance(data, dict):
    fail("top level must be an object {\"reviewedSha\", \"summary\", \"findings\"}")

reviewed_sha = data.get("reviewedSha")
if not isinstance(reviewed_sha, str) or SHA_RE.match(reviewed_sha) is None:
    fail("\"reviewedSha\" must be the full 40-hex commit the findings were gathered against")
reviewed_sha = reviewed_sha.lower()

summary = data.get("summary")
if not isinstance(summary, str) or summary.strip() == "":
    fail("\"summary\" must be a non-empty string")

findings = data.get("findings")
if not isinstance(findings, list):
    fail("\"findings\" must be an array")

threads = []
fallbacks = []
for index, finding in enumerate(findings):
    where = f"findings[{index}]"
    if not isinstance(finding, dict):
        fail(f"{where} must be an object")

    body = finding.get("body")
    if not isinstance(body, str) or body.strip() == "":
        fail(f"{where}.body must be a non-empty string")

    path = finding.get("path")
    line = finding.get("line")
    usable_path = isinstance(path, str) and path.strip() != ""
    usable_line = isinstance(line, int) and not isinstance(line, bool) and line > 0

    if usable_path and usable_line:
        threads.append({"path": path.strip(), "line": line, "body": body})
        continue

    # No usable anchor: keep the finding, but in the summary body only.
    if usable_path:
        fallbacks.append(f"- {path.strip()} — {body}")
    else:
        fallbacks.append(f"- {body}")

lines = [summary.strip()]
if fallbacks:
    lines.extend(["", "Findings without a file:line anchor:", *fallbacks])
# Dedupe marker stays last and byte-identical; nothing else closes the body.
lines.extend(["", f"<!-- agent-review {reviewed_sha} -->"])
review_body = "\n".join(lines)

payload = {
    "query": QUERY,
    "variables": {
        "pullRequestId": pr_node_id,
        "commitOID": reviewed_sha,
        "body": review_body,
        "threads": threads,
    },
}
with open(payload_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)

print(f"{reviewed_sha} {len(threads)} {len(fallbacks)}")
PY
) || die "findings file is not valid; nothing was posted"

read -r reviewed_sha inline_count fallback_count <<<"$counts"

reviewed_lc=$(printf '%s' "$reviewed_sha" | tr '[:upper:]' '[:lower:]')
head_lc=$(printf '%s' "$head_sha" | tr '[:upper:]' '[:lower:]')
if [[ $reviewed_lc != "$head_lc" ]]; then
    die "head moved between gathering and posting: review is bound to $reviewed_sha but the PR head is now $head_sha. Nothing was posted — re-review the new head."
fi

if [[ $inline_count -eq 0 && $fallback_count -eq 0 ]]; then
    printf 'no-findings %s\n' "$pr_url"
    exit 0
fi

# State check after validation: a bad findings file is reported as a bad file
# even on a merged PR, and no review is ever attempted there.
[[ $pr_state == "OPEN" ]] ||
    die "PR $slug#$number is $pr_state; reviews can only be posted to an open pull request (nothing was posted)"

marker="<!-- agent-review $reviewed_sha -->"

# Atomic mkdir lock: serialises check+post for this PR on this host. Bash 3.2
# (macOS) has no flock, and shlock's PID semantics do not survive this use; a
# token-stamped directory is the portable primitive. The lock FAILS CLOSED:
# any existing directory means "someone may be mid-post", so a rival refuses
# regardless of age. There is no auto-stale-steal — a 120s steal could take a
# lock from a slow live operation, and a half-initialised lock has no timestamp
# to judge. A crashed run's lock is removed by hand (the refusal message says
# how), which is the only recovery path.
acquire_lock() {
    if mkdir "$lock_dir" 2>/dev/null; then
        # Claim ownership before writing: cleanup then compares tokens and can
        # never remove a directory that was replaced underneath us.
        lock_owned=1
        printf '%s\n' "$lock_token" >"$lock_dir/token"
        date +%s >"$lock_dir/ts"
        return 0
    fi
    return 1
}

acquire_lock ||
    die "another post-review.sh holds the lock for $slug#$number (lock $lock_dir). Nothing was posted. If a previous run crashed, remove that directory manually and retry."

# Cursor-paginated discovery: `reviews(last:100)` silently missed a marker once
# a PR had more reviews than that.
existing=$(
    gh api graphql --paginate \
        -f query='query($owner:String!,$repo:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviews(first:100,after:$endCursor){pageInfo{hasNextPage endCursor}nodes{body}}}}}' \
        -F owner="$owner" -F repo="$repo" -F number="$number" \
        --jq '.data.repository.pullRequest.reviews.nodes[]?.body // empty'
) || die "could not list the PR's existing reviews; nothing was posted"

# Plain substring test, not `grep -q` on a pipe: a pipeline whose consumer exits
# on the first match returns SIGPIPE (141) under `pipefail`, which would read as
# "no match" on large paginated output and let a duplicate review through.
if [[ $existing == *"$marker"* ]]; then
    printf 'already-posted %s\n' "$pr_url"
    exit 0
fi

if ! review_url=$(
    gh api graphql --input "$payload" \
        --jq '.data.addPullRequestReview.pullRequestReview.url'
); then
    die "GitHub rejected the review (see the GraphQL error above); nothing was posted"
fi

[[ -n $review_url && $review_url != "null" ]] || die "GitHub returned no review URL; check the PR manually"

printf 'posted %s (%s inline thread(s), %s summary-only finding(s), bound to %s)\n' \
    "$review_url" "$inline_count" "$fallback_count" "$reviewed_sha"
