// One-shot agent-handoff claims: one `action#number#headSha` key per handoff
// state, shared by the manual button and any automatic path (Fix). These pin
// the TTL contract (a claim stops blocking once stale, and re-claiming refreshes
// it) and the key format, with an explicit clock so the boundary is tested
// without fake timers. gui.tsx owns the wiring; these tests own the rule.
// @ts-expect-error -- this repo has no bun-types; `bun test` provides the module at runtime.
import { describe, expect, test } from "bun:test"
import { claimActive, CLAIM_TTL_MS, handoffClaimKey, releaseClaim, tryClaim } from "../pure"

const SHA = "9f2c1a2b"
const KEY = handoffClaimKey("fix", 413, SHA)

describe("handoff claim keys", () => {
  test("an action-prefixed key names action, PR and head sha", () => {
    expect(KEY).toBe("fix#413#9f2c1a2b")
  })

  test("a missing head sha keys as nohead, not an empty segment", () => {
    expect(handoffClaimKey("fix", 413, undefined)).toBe("fix#413#nohead")
    expect(handoffClaimKey("fix", 413, "")).toBe("fix#413#nohead")
    // A real sha and the no-head state are different states.
    expect(handoffClaimKey("fix", 413, SHA)).not.toBe(handoffClaimKey("fix", 413, undefined))
  })

  test("a missing PR number keys as ? instead of inventing one", () => {
    expect(handoffClaimKey("continue", undefined, SHA)).toBe("continue#?#9f2c1a2b")
  })

  test("branch claims are directory- and source-scoped, PR claims are unchanged", () => {
    const one = handoffClaimKey("branch", undefined, undefined, "/w/one\u0000create\u0000main:clean")
    const two = handoffClaimKey("branch", undefined, undefined, "/w/two\u0000create\u0000main:clean")
    const other = handoffClaimKey("branch", undefined, undefined, "/w/one\u0000stash\u0000main:dirty")
    // The same sha in two worktrees, and two states in one, never collide.
    expect(new Set([one, two, other]).size).toBe(3)
    // No scope keeps every PR key byte-identical to before.
    expect(handoffClaimKey("fix", 413, SHA)).toBe("fix#413#9f2c1a2b")
  })

  test("a scoped claim suppresses its duplicate and releases only its own token", () => {
    const claims = new Map<string, number>()
    const scope = "/w/one\u0000create\u0000main:clean"
    const key = handoffClaimKey("branch", undefined, undefined, scope)
    expect(tryClaim(claims, key, 0)).toBe(true)
    expect(tryClaim(claims, key, 0)).toBe(false)
    const other = handoffClaimKey("branch", undefined, undefined, "/w/two\u0000create\u0000main:clean")
    expect(tryClaim(claims, other, 0)).toBe(true)
    expect(releaseClaim(claims, key, 0)).toBe(true)
    expect(claimActive(claims, other, 0)).toBe(true)
    // Expiry re-enables the same scoped state, so a refused queue can retry.
    expect(claimActive(claims, other, CLAIM_TTL_MS)).toBe(false)
    expect(tryClaim(claims, other, CLAIM_TTL_MS)).toBe(true)
  })

  test("different actions or states never share a claim", () => {
    const claims = new Map<string, number>()
    expect(tryClaim(claims, KEY, 0)).toBe(true)
    for (const action of ["review", "resolve", "conflicts", "signOff", "continue"]) {
      const key = handoffClaimKey(action, 413, SHA)
      expect(claimActive(claims, key, 0)).toBe(false)
      expect(tryClaim(claims, key, 0)).toBe(true)
    }
    // A new head sha on the same action is a new state, so it is claimable.
    expect(claimActive(claims, handoffClaimKey("fix", 413, "deadbeef"), 0)).toBe(false)
    // The same state on another PR is a new state too.
    expect(claimActive(claims, handoffClaimKey("fix", 414, SHA), 0)).toBe(false)
  })
})

describe("handoff claim TTL", () => {
  test("the TTL is ten minutes", () => {
    expect(CLAIM_TTL_MS).toBe(600_000)
  })

  test("the first claim wins and a second inside the TTL is refused", () => {
    const claims = new Map<string, number>()
    expect(tryClaim(claims, KEY, 1_000)).toBe(true)
    expect(tryClaim(claims, KEY, 1_000 + CLAIM_TTL_MS - 1)).toBe(false)
    // A refused claim writes nothing: the timestamp still belongs to the first.
    expect(claims.get(KEY)).toBe(1_000)
  })

  test("a refused claim does not extend the TTL", () => {
    const claims = new Map<string, number>()
    tryClaim(claims, KEY, 0)
    tryClaim(claims, KEY, CLAIM_TTL_MS - 1)
    expect(claimActive(claims, KEY, CLAIM_TTL_MS)).toBe(false)
  })

  test("expiry is exact at the TTL boundary", () => {
    const claims = new Map<string, number>()
    tryClaim(claims, KEY, 0)
    expect(claimActive(claims, KEY, CLAIM_TTL_MS - 1)).toBe(true)
    expect(claimActive(claims, KEY, CLAIM_TTL_MS)).toBe(false)
    expect(tryClaim(claims, KEY, CLAIM_TTL_MS)).toBe(true)
  })

  test("a re-claim after expiry refreshes the timestamp", () => {
    const claims = new Map<string, number>()
    tryClaim(claims, KEY, 0)
    const later = CLAIM_TTL_MS * 2
    expect(tryClaim(claims, KEY, later)).toBe(true)
    expect(claims.get(KEY)).toBe(later)
    // The refreshed claim suppresses for another full TTL from `later`.
    expect(claimActive(claims, KEY, later + CLAIM_TTL_MS - 1)).toBe(true)
    expect(claimActive(claims, KEY, later + CLAIM_TTL_MS)).toBe(false)
  })

  test("an absent key is not active", () => {
    const claims = new Map<string, number>()
    expect(claimActive(claims, KEY, 0)).toBe(false)
  })

  test("an expired entry is physically evicted, not just ignored", () => {
    const claims = new Map<string, number>()
    tryClaim(claims, handoffClaimKey("fix", 413, "old"), 0)
    expect(claims.has("fix#413#old")).toBe(true)
    // Any claim sweeps first, so an unrelated claim is enough to evict it.
    expect(tryClaim(claims, KEY, CLAIM_TTL_MS)).toBe(true)
    expect(claims.has("fix#413#old")).toBe(false)
    expect(claims.size).toBe(1)
  })

  test("a caller-supplied ttl overrides the default", () => {
    const claims = new Map<string, number>()
    tryClaim(claims, KEY, 0, 10)
    expect(claimActive(claims, KEY, 9, 10)).toBe(true)
    expect(claimActive(claims, KEY, 10, 10)).toBe(false)
  })
})

describe("handoff claim ownership", () => {
  // The auto-fix scenario: a claim whose prompt call is still pending past the
  // TTL, while a manual Fix legitimately re-claims the same expired key. When
  // the original call finally fails, its release must not delete the manual
  // claim — otherwise the next poll can queue a duplicate fix.
  test("a stale token cannot release a re-claimed entry", () => {
    const claims = new Map<string, number>()
    const t0 = 1_000
    expect(tryClaim(claims, KEY, t0)).toBe(true)
    const t1 = t0 + CLAIM_TTL_MS
    expect(tryClaim(claims, KEY, t1)).toBe(true)
    // The original claim's late release is a no-op against the newer owner.
    expect(releaseClaim(claims, KEY, t0)).toBe(false)
    expect(claims.has(KEY)).toBe(true)
    expect(claims.get(KEY)).toBe(t1)
    expect(claimActive(claims, KEY, t1)).toBe(true)
    // The owner still releases itself.
    expect(releaseClaim(claims, KEY, t1)).toBe(true)
    expect(claims.has(KEY)).toBe(false)
  })

  test("an absent token or a different key releases nothing", () => {
    const claims = new Map<string, number>()
    tryClaim(claims, KEY, 0)
    expect(releaseClaim(claims, KEY, undefined)).toBe(false)
    expect(releaseClaim(claims, handoffClaimKey("fix", 413, "other"), 0)).toBe(false)
    expect(claims.get(KEY)).toBe(0)
    expect(releaseClaim(claims, KEY, 0)).toBe(true)
  })
})
