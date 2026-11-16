import { createEffect, createSignal, ErrorBoundary, onCleanup, Show, untrack } from "solid-js"
import { createKeyed, createLatest, Panel, Plugin, Style, TitlebarItem, usePanel } from "@opencode/plugin/gui"
import type { DialogHandle, MountedSession } from "@opencode/plugin/gui"
import { join } from "node:path"
import { PrPanel } from "./contract"
// The main-process half lives in ./git: every process spawn and every cache
// only `main` touches. This import is STATIC so the IPC ids in ./contract stay
// type-checked against the functions that actually serve them; nothing imported
// here is called from `setup` or a window component. They are reached through
// `ctx.main(PrPanel)` only, and split.test.ts pins that.
import {
  autoFixState,
  commitAndPush,
  continueWork,
  countReviewThreads,
  createPr,
  MAX_SHORT,
  mergePr,
  mutateRead,
  pushBranch,
  readDivergence,
  readShared,
  readStatus,
  reapBranches,
  reaperState,
  repoFromUrl,
  resetWorkspace,
  type Divergence,
  type PrData,
  type PrOk,
} from "./git"
// Pure helpers live in ./pure so `bun test` can cover them without Solid or
// Electron. Their bodies moved verbatim; gui.tsx only imports them now.
import {
  approvalToken,
  chipStage,
  claimActive,
  CLAIM_TTL_MS,
  facts as prFacts,
  handoffClaimKey,
  hasConflicts,
  hasReviewWork,
  message,
  parseJson,
  POLL_MS_SLOW,
  pollDelay,
  prTone,
  releaseClaim,
  stateTone as stateToneOf,
  summarizeChecks,
  TIDY_COOLDOWN_MS,
  tidyDue,
  tidyNote,
  tidyToggleOutcome,
  toneWordKey,
  tryClaim,
  type Check,
  type PrTone,
  type TidyToggleOutcome,
} from "./pure"
import { en } from "./i18n"
import { PALETTE, PR_STYLE } from "./style"

// oc-pr-gui: an OpenCode Desktop side panel with the current branch's PR and a
// guarded Merge button.
//
// This is a separate, GUI-only plugin. It does NOT import oc-pr.ts (a single-file
// plugin is not importable): the small validation helpers in ./git are duplicated
// from oc-pr.ts and must stay behaviour-compatible with it.
//
// Two processes evaluate this file:
//   - every desktop window runs `setup` (Solid UI, sandboxed, no child_process)
//   - the Electron main process runs `main` (Node, spawns `gh`)
// The spawns themselves are in ./git. `execFile` is an inert placeholder in the
// window, and this file no longer imports it at all: only `main` reaches the
// process-spawning half, through the bindings it imports from ./git.

// The decision layer (facts -> prTone/chipStage/stateTone/tone word) lives in
// ./pure so it is testable with plain records. Re-exported so this module's
// public surface is unchanged.
export { prTone }
export type { PrTone }

export default Plugin.define({
  i18n: { en },

  setup(ctx) {
    const [tick, setTick] = createSignal(0)
    const [confirming, setConfirming] = createSignal(false)
    const [busy, setBusy] = createSignal(false)
    const [result, setResult] = createSignal<{ directory: string; text: string }>()
    const [autoFixNote, setAutoFixNote] = createSignal<{ directory: string; text: string }>()
    // The auto-fix toggle used to be a row in the action dialog; it now lives
    // on the side panel, so its saved value is mirrored here.
    const [panelAutoFix, setPanelAutoFix] = createSignal<boolean | undefined>()
    // The reaper's switch, mirrored the same way. Its default is OFF (missing
    // preference file), so `undefined` reads as disabled until the first read
    // lands.
    const [panelTidy, setPanelTidy] = createSignal<boolean | undefined>()

    // Auto-fix bookkeeping, owned by this window: enabled is cached per
    // directory and lastFailing makes this a transition (not every poll).
    const autoFixEnabled = new Map<string, boolean>()
    const lastFailing = new Map<string, boolean>()

    // Tidy-pass bookkeeping, also window-side: the preference cache mirrors
    // `autoFixEnabled`, `tidyLast` is the cooldown clock per directory,
    // `tidyInFlight` keeps a second slow tick from overlapping a pass, and
    // `tidySummary` is the panel's one-line note for the last pass.
    const reaperEnabled = new Map<string, boolean>()
    const tidyLast = new Map<string, number>()
    const tidyInFlight = new Set<string>()
    const [tidySummary, setTidySummary] = createSignal<{
      directory: string
      branches: string[]
      restores: string[]
      failed: boolean
    }>()

    // Agent-handoff claims: one timestamped entry per action + PR + head sha
    // (see handoffClaimKey in ./pure). A claim is the one-shot rule every
    // handoff button shares — the same state is requested once, a different
    // number/sha or the TTL makes it requestable again. The map stays plain so
    // the rules remain the testable claimActive/tryClaim; `claimsBump` is the
    // reactive half: every claim, release and expiry bumps it, and each
    // disabled button reads it, so a dialog observes the claim without a timer
    // of its own or a poll.
    const handoffClaims = new Map<string, number>()
    // Ownership proof returned by claimHandoff: the key it claimed plus the
    // timestamp token written into `handoffClaims`. Release only deletes when the
    // map still holds this exact token, so a stale claim cannot delete a newer
    // one that legitimately re-claimed the same state after expiry.
    type HandoffClaim = { key: string; token: number }
    const [claimsBump, setClaimsBump] = createSignal(0)
    let claimExpiryTimer: ReturnType<typeof setTimeout> | undefined

    // Re-arm the single expiry timer for the soonest live claim. Expiry is not
    // a map mutation, so without this the greyed button would stay grey until
    // some unrelated signal repainted the dialog. One timer over a map that
    // holds a few entries is cheaper than a ticker, and the recursive re-arm
    // leaves it unarmed once nothing is left to expire.
    const armClaimExpiry = (): void => {
      if (claimExpiryTimer !== undefined) clearTimeout(claimExpiryTimer)
      claimExpiryTimer = undefined
      const now = Date.now()
      let soonest = Number.POSITIVE_INFINITY
      for (const claimedAt of handoffClaims.values()) {
        const remaining = claimedAt + CLAIM_TTL_MS - now
        if (remaining > 0 && remaining < soonest) soonest = remaining
      }
      if (soonest === Number.POSITIVE_INFINITY) return
      claimExpiryTimer = setTimeout(() => {
        claimExpiryTimer = undefined
        // An expired entry stays in the map until the next tryClaim sweeps it;
        // claimActive already reads it as inactive, so a bump and a re-arm is
        // all the repaint needs.
        setClaimsBump((value) => value + 1)
        armClaimExpiry()
      }, soonest)
    }
    onCleanup(() => {
      if (claimExpiryTimer !== undefined) clearTimeout(claimExpiryTimer)
    })

    // Claim one handoff for the current state. Returns the owning claim — its
    // key plus the token tryClaim wrote — or undefined when a live claim already
    // holds it, in which case the caller must queue nothing (the disabled button
    // is the first line, this is the guard that also covers a racing or
    // programmatic second call).
    const claimHandoff = (
      action: string,
      number: number | undefined,
      sha: string | undefined,
      // Directory + source state for handoffs that are not PR-scoped (branch
      // creation). Omitted for the PR handoffs, whose key is already the PR
      // state.
      scope?: string,
    ): HandoffClaim | undefined => {
      const key = handoffClaimKey(action, number, sha, scope)
      const token = Date.now()
      if (!tryClaim(handoffClaims, key, token)) return undefined
      armClaimExpiry()
      // tryClaim writes in place; the bump is what repaints every button that
      // reads the claim state.
      setClaimsBump((value) => value + 1)
      // `token` is exactly what tryClaim wrote for a successful claim, so the
      // caller holds the ownership proof for this entry.
      return { key, token }
    }

    // Release a claim so the exact handoff can be requested again. Ownership
    // checked, because a claim can only ever release itself: if this claim
    // expired and another path re-claimed the same state, the map now holds that
    // newer token and this release must be a no-op (deleting it would let a
    // third call double-queue). A no-op also when the key is already absent.
    const releaseHandoff = (claim: HandoffClaim | undefined): void => {
      if (claim === undefined || !releaseClaim(handoffClaims, claim.key, claim.token)) return
      armClaimExpiry()
      setClaimsBump((value) => value + 1)
    }

    // Reactive read: the bump makes this re-evaluate on claim/release/expiry.
    const handoffClaimed = (
      action: string,
      number: number | undefined,
      sha: string | undefined,
      scope?: string,
    ): boolean => {
      claimsBump()
      return claimActive(handoffClaims, handoffClaimKey(action, number, sha, scope), Date.now())
    }

    const session = () => ctx.sessions.current()
    const directory = () => session()?.directory

    // Live check for a session captured at dialog open. `MountedSession` is
    // frozen: `directory` never changes on the object, and a move yields a NEW
    // object (SDK host-apis), so `props.session.directory === props.targetDir`
    // only proves where the session was, not where it is after an await. Resolve
    // the id in the live list instead — a moved session reports another
    // directory and a closed one is gone. `location` is undefined while the
    // server has not reported it; the routed session is the one live object that
    // carries its directory directly, so it answers for itself in that window.
    // An unknown directory still fails closed like a mismatch: the prompt would
    // otherwise land somewhere unproven.
    const sessionTargets = (sessionID: string, targetDir: string): boolean => {
      const live = ctx.sessions.list().find((entry) => entry.id === sessionID)
      if (live === undefined) return false
      const routed = ctx.sessions.current()
      const liveDir = live.location?.directory ?? (routed?.id === sessionID ? routed.directory : undefined)
      return liveDir === targetDir
    }

    // Last-good results, one entry per directory: a directory switch paints the
    // previous result for that directory immediately while its fetch runs, and
    // the entry is overwritten on every resolved fetch. There is no TTL, and a
    // lookup is only ever made for its own directory, so directory A's result
    // can never appear under B.
    const snapshots = new Map<string, { pr?: PrData; divergence?: Divergence; at?: number }>()

    // The unresolved-thread count, merged into the status after it has painted.
    // It has its OWN abort lifetime instead of riding the status request's
    // signal: a superseding status fetch (Refresh or a poll tick) aborts the
    // previous status, but a count that already landed for the same directory
    // must stay painted, and an in-flight count must be allowed to land. Only a
    // directory change or unmount aborts it. `gen` is bumped on a directory
    // change, so a reply for the previous directory is dropped rather than
    // decorating the new one.
    const [threads, setThreads] = createSignal<{
      directory: string
      number: number
      unresolved: number | null
      gen: number
    }>()
    let threadsGen = 0
    let threadsAbort: AbortController | undefined
    let threadsDir: string | undefined
    let threadsTarget: string | undefined
    function abortThreads(): void {
      threadsAbort?.abort()
      threadsAbort = undefined
      threadsTarget = undefined
    }
    onCleanup(abortThreads)


    // A NUL-separated key: a new identity on directory change and on Refresh,
    // without re-fetching on every reactive read. Session identity is
    // deliberately not part of it: moving between two tabs of the same
    // directory keeps the same status (no abort, no refetch).
    const source = () => {
      const dir = directory()
      return dir ? `${dir}\u0000${tick()}` : undefined
    }

    // Window-side signals for the poll cadence (Phase 1, item 8). They choose
    // only the DELAY between ticks — never whether a tick happens.
    // - `panelVisible`: `usePanel().visible` ("Region open and this tab
    //   selected") reported up from a panel-render wrapper, because `usePanel`
    //   throws outside a `Panel.render` and this scope is plugin `setup`.
    //   It starts false and the wrapper's effect settles it after mount; the
    //   fallback when the frame is unavailable is "visible", which keeps
    //   today's fast cadence rather than losing the panel.
    // - `dialogMounts`: the PrActions dialog has no timer of its own and rides
    //   this same tick, so a mounted dialog counts as the user watching. A
    //   counter (not a boolean) keeps a host that mounts the next dialog before
    //   disposing the previous one from reporting "closed" too early.
    const [panelVisible, setPanelVisible] = createSignal(false)
    const [dialogMounts, setDialogMounts] = createSignal(0)
    const dialogOpen = () => dialogMounts() > 0

    // CI polling: at most one timer. Every fetch start clears it (session
    // change, manual Refresh, or the poll itself), and a result schedules the
    // next poll for as long as the PR is open — always on, so late-starting
    // checks (a push or a re-run after the chip went green) still surface on
    // the titlebar chip. Cost is one folded GraphQL call per fast tick (18s)
    // while the user is watching (side region visible or the dialog open) and
    // per slow tick (60s) while both are closed, well within the rate limit;
    // that one call also carries the review-thread count, so a tick costs one
    // spawn and no follow-up call. The poll never stops while a poll-worthy
    // result exists, so a hidden panel's chip is at most one slow interval
    // stale. Merged/closed PRs and failures stop the loop.
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    // The result and the delay the pending tick was armed with, so a
    // visibility/dialog change can re-arm the SAME tick at the new delay
    // without spending a fetch of its own.
    let pollPlan: { dir: string; result: PrData; delay: number } | undefined
    function clearPoll() {
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer)
        pollTimer = undefined
      }
      pollPlan = undefined
    }
    onCleanup(clearPoll)

    function schedulePoll(dir: string, result: PrData) {
      clearPoll()
      const current = session()
      if (current === undefined || current.directory !== dir) return
      if (!result.ok) return
      if ((result.state ?? "").toUpperCase() !== "OPEN") return
      const delay = pollDelay(panelVisible(), dialogOpen())
      pollPlan = { dir, result, delay }
      pollTimer = setTimeout(() => {
        pollTimer = undefined
        pollPlan = undefined
        const live = session()
        if (live === undefined || live.directory !== dir) return
        // Never overlap a request that is already in flight.
        if (pr.loading) return
        // The slow cadence is the background cadence, so it is also the reaper's
        // cadence: one potential tidy pass per slow tick, guarded by the
        // per-directory cooldown and in-flight set inside `maybeTidy`. Fast ticks
        // mean the user is watching and already has the branch facts on screen.
        if (delay === POLL_MS_SLOW) void maybeTidy(dir)
        setTick((value) => value + 1)
      }, delay)
    }

    // Delay-only re-arm: opening/closing the side region or the dialog while a
    // tick is pending moves that tick to the new cadence. It never starts a
    // fetch itself (`schedulePoll` only stores a timer), and the untracked
    // plan keeps `session()`/`pr.loading` reads from becoming dependencies.
    createEffect(() => {
      const delay = pollDelay(panelVisible(), dialogOpen())
      untrack(() => {
        const plan = pollPlan
        if (plan === undefined || pollTimer === undefined) return
        if (plan.delay === delay) return
        schedulePoll(plan.dir, plan.result)
      })
    })

    // One status, two paints. Since Tier B item 7 the status reply may ALREADY
    // carry its thread count: main folds `reviewThreads` into the same GraphQL
    // call that answers the status fields, so a folded reply needs no second
    // call at all (`adoptThreads` below lands it with the status). This pass is
    // the fallback path's consumer, kept exactly as it was: `gh pr view` has no
    // threads field, so a fallback reply decorates from its own GraphQL call
    // whenever that reply lands. Never awaited by the status path, and every
    // path is caught so a failed count can never surface as a rejection. A
    // request for the same directory+PR that is still in flight is reused, so
    // the dialog-open prime and the status reply that follows it do not count
    // twice.
    async function loadThreads(dir: string, data: PrData): Promise<void> {
      if (!data.ok) return
      const number = data.number
      if (number === undefined || typeof data.url !== "string" || data.url === "") return
      const target = `${dir}\u0000${number}`
      if (threadsTarget === target && threadsAbort !== undefined) return
      if (threadsDir !== dir) {
        abortThreads()
        threadsDir = dir
        threadsGen += 1
      }
      const gen = threadsGen
      // A newer status reply for this directory supersedes an older count in
      // flight; the landed count itself is untouched until the new one paints.
      abortThreads()
      const controller = new AbortController()
      threadsAbort = controller
      threadsTarget = target
      try {
        const raw = await ctx.main(PrPanel).threads({ directory: dir, url: data.url, number }, { signal: controller.signal })
        if (controller.signal.aborted || gen !== threadsGen) return
        const parsed = JSON.parse(raw) as { unresolved?: number } | null
        const unresolved = parsed !== null && typeof parsed.unresolved === "number" ? parsed.unresolved : null
        setThreads({ directory: dir, number, unresolved, gen })
      } catch {
        // Decoration only: keep the previous count (or none, which reads as
        // unknown) rather than touching the status.
      } finally {
        if (threadsAbort === controller) {
          threadsAbort = undefined
          threadsTarget = undefined
        }
      }
    }

    // A status reply that already carries its thread count (the folded path,
    // Tier B item 7) lands exactly like a counted reply — same directory+PR
    // guards, same generation counter — so the count appears with the status and
    // no second GraphQL call is spent. Returns true when it adopted the count,
    // which is the signal to skip `loadThreads` for this reply. A reply without
    // a count (`gh pr view` fallback) returns false and the old path runs.
    function adoptThreads(dir: string, data: PrData): boolean {
      if (!data.ok) return false
      if (data.number === undefined) return false
      if (data.reviewThreads === undefined) return false
      if (threadsDir !== dir) {
        abortThreads()
        threadsDir = dir
        threadsGen += 1
      }
      // A folded count SUPERSEDES any fallback count still in flight for this
      // directory. Abort it and drop its target: `loadThreads` checks
      // `controller.signal.aborted` (and `gen !== threadsGen`) before it writes,
      // so the older reply is dropped instead of overwriting this fresh value.
      // Clearing the target also lets a later prime start a new count rather
      // than the same-target reuse guard swallowing it.
      abortThreads()
      setThreads({
        directory: dir,
        number: data.number,
        unresolved: data.reviewThreads === null ? null : data.reviewThreads.unresolved,
        gen: threadsGen,
      })
      return true
    }

    // The status the dialog can already paint from (latest fetch for the
    // directory, else its last-good snapshot), so opening the dialog can start
    // the count alongside its refresh instead of waiting for the reply. A folded
    // reply already carries the count, so a directory that has one is left alone:
    // the prime exists to fill a gap, not to re-buy an answer.
    function primeThreads(dir: string): void {
      const latest = pr.latest
      const current =
        latest !== undefined && latest.directory === dir ? latest.data : snapshots.get(dir)?.pr
      if (current !== undefined && current.ok && current.reviewThreads !== undefined) return
      if (current !== undefined) void loadThreads(dir, current)
    }

    // Overlay the counted threads on the status. The count belongs to this
    // directory and PR number only; otherwise the status is untouched, so a
    // late reply can never decorate anything it did not count.
    const withThreads = (dir: string, data: PrData): PrData => {
      if (!data.ok) return data
      const current = threads()
      if (current === undefined || current.directory !== dir || current.number !== data.number) return data
      return {
        ...data,
        reviewThreads: current.unresolved === null ? null : { unresolved: current.unresolved },
      }
    }

    // One-shot "this request must not clear the action error" token. `refreshAll`
    // arms it immediately before bumping the tick and the status fetch consumes
    // it at request start (before its first await) and stamps the result with it,
    // so the suppression is bound to exactly one in-flight request: a request
    // that rejects leaves no residue behind for the next poll, and overlapping
    // action refreshes cannot bank credits for later results.
    let suppressClear = false

    const pr = createLatest(source, async (key, signal) => {
      clearPoll()
      // Consumed at request start, before the await: the token belongs to this
      // request whatever its outcome (success, failure, abort).
      const keepError = suppressClear
      suppressClear = false
      const dir = key.split("\u0000")[0] ?? ""
      try {
        const raw = await ctx.main(PrPanel).status({ directory: dir }, { signal })
        const data = JSON.parse(raw) as PrData
        if (!signal.aborted) {
          snapshots.set(dir, { ...(snapshots.get(dir) ?? {}), pr: data, at: Date.now() })
          schedulePoll(dir, data)
          void maybeAutoFix(dir, data)
          // A folded reply carries the count, so adopting it is the whole second
          // paint (zero extra IPC, zero extra spawn). Only a reply without one
          // falls back to the separate count.
          if (!adoptThreads(dir, data)) void loadThreads(dir, data)
        }
        return { directory: dir, data, keepError }
      } catch (e) {
        if (!signal.aborted) clearPoll()
        throw e
      }
    })

    // Divergence rides the same source, so a directory change, Refresh or the
    // poll updates the chip hints and the dialog rows together.
    const divergenceState = createLatest(source, async (key, signal) => {
      const dir = key.split("\u0000")[0] ?? ""
      try {
        const raw = await ctx.main(PrPanel).ahead({ directory: dir }, { signal })
        const data = JSON.parse(raw) as Divergence
        if (!signal.aborted) {
          snapshots.set(dir, { ...(snapshots.get(dir) ?? {}), divergence: data, at: Date.now() })
        }
        return { directory: dir, data }
      } catch {
        return { directory: dir, data: undefined as Divergence | undefined }
      }
    })
    const divergenceFor = (dir: string | undefined): Divergence | undefined => {
      if (dir === undefined) return undefined
      const latest = divergenceState.latest
      if (latest !== undefined && latest.directory === dir && latest.data !== undefined) return latest.data
      return snapshots.get(dir)?.divergence
    }

    // Waits for the per-directory preference once, then caches it. A failure
    // reads as "off" so a broken settings file can never queue prompts.
    async function ensureAutoFix(dir: string): Promise<boolean> {
      const cached = autoFixEnabled.get(dir)
      if (cached !== undefined) return cached
      try {
        const raw = await ctx.main(PrPanel).autoFix({ directory: dir })
        const state = JSON.parse(raw) as { enabled?: boolean }
        const enabled = state.enabled === true
        autoFixEnabled.set(dir, enabled)
        return enabled
      } catch {
        autoFixEnabled.set(dir, false)
        return false
      }
    }

    // Same shape as `ensureAutoFix`, with one difference: only an explicit
    // stored `true` means ENABLED (./contract.ts) — a missing file is OFF. The
    // reply carries { enabled, known }; `known: false` — an unparseable or
    // unreadable file — must read as OFF too, because that file cannot prove an
    // opt-in. A failed read fails closed the same way. The panel therefore
    // shows Off until an explicit toggle writes the file again (the toggle is
    // the only repair path).
    async function ensureTidyEnabled(dir: string): Promise<boolean> {
      const cached = reaperEnabled.get(dir)
      if (cached !== undefined) return cached
      try {
        const raw = await ctx.main(PrPanel).reaper({ directory: dir })
        const state = parseJson<{ enabled?: boolean; known?: boolean }>(raw)
        const enabled = state?.known === true && state.enabled === true
        reaperEnabled.set(dir, enabled)
        return enabled
      } catch {
        reaperEnabled.set(dir, false)
        return false
      }
    }

    // Delivery wording for queued prompts. The client types the reply's
    // `delivery` as `"steer" | "queue"` (@opencode/schema session-inbox):
    // "queue" joined the session inbox (the agent picks it up after the running
    // turn), "steer" went straight into the running turn. Anything else — an
    // unknown future value or a reply without the field — must not claim the
    // prompt was sent, so it reads as pending rather than "Sent".
    // Shared by the auto-fix note and the dialog's queued-prompt actions.
    const deliveryWord = (item: { delivery?: string } | undefined): string => {
      if (item?.delivery === "queue") return ctx.t("dialog.queued")
      if (item?.delivery === "steer") return ctx.t("dialog.sent")
      return ctx.t("dialog.pending")
    }

    // One stale-check clause for every handoff prompt: the agent re-reads the
    // PR's live state before acting, so a panel showing an old poll cannot make
    // it push, resolve, or sign off against a head that has moved. `sha` is the
    // head commit the panel is showing; when it is missing the clause compares
    // against the branch tip instead of inventing a commit.
    const staleOpenText = (number: string, branch: string, sha: string | undefined): string =>
      sha !== undefined && sha !== ""
        ? ctx.t("dialog.staleOpen", { number, sha })
        : ctx.t("dialog.staleOpenBranch", { number, branch })
    const staleMergedText = (number: string, base: string): string =>
      ctx.t("dialog.staleMerged", { number, base })

    // The exact Fix handoff text. The poll path and the button path share the
    // `#number#sha` dedupe key, so they must queue byte-identical prompts for
    // one PR state; both go through this builder rather than repeating params.
    const fixPromptText = (pr: { branch?: string; headSha?: string }, number: number): string => {
      const branch = pr.branch ?? "this branch"
      return ctx.t("dialog.fixPrompt", {
        branch,
        number: String(number),
        stale: staleOpenText(String(number), branch, pr.headSha),
      })
    }

    // Queue the fix prompt on a failing transition, at most once per PR# and
    // head sha. The transition check and the dedupe key together keep a poll
    // tick from re-queuing.
    async function maybeAutoFix(dir: string, data: PrData): Promise<void> {
      const failing =
        data.ok && (data.state ?? "").toUpperCase() === "OPEN" && summarizeChecks(data.checks).failing
      const previous = lastFailing.get(dir) === true
      lastFailing.set(dir, failing)
      if (!failing || previous) return
      const number = data.number
      const sha = data.headSha
      if (number === undefined || sha === undefined) return
      // Share the manual Fix button's claim (`fix#number#sha`): whichever path
      // claims first queues, the other sees a live claim. A claim older than
      // the TTL no longer suppresses: the previous handoff is certainly stale
      // by then, and the re-claim below refreshes the timestamp.
      if (handoffClaimed("fix", number, sha)) return
      // Read the preference before claiming, so "off" never burns the key.
      if (!(await ensureAutoFix(dir))) return
      const current = session()
      if (current === undefined || current.directory !== dir) return
      // Authoritative claim after the awaits: the pre-check above ran before
      // them, and the manual button may have claimed the same state meanwhile.
      const claim = claimHandoff("fix", number, sha)
      if (claim === undefined) return
      try {
        const item = await current.server.client.session.prompt({
          sessionID: current.id,
          text: fixPromptText(data, number),
          delivery: "queue",
        })
        const delivery = deliveryWord(item)
        setAutoFixNote({
          directory: dir,
          text: `${ctx.t("panel.autoFixQueued")} · ${delivery}`,
        })
      } catch {
        // Allow the next failing transition to try again. The release carries
        // this run's token, so a manual re-claim of the same expired key (which
        // wrote a newer timestamp) survives this late failure.
        releaseHandoff(claim)
      }
    }

    // One reaper pass on the slow poll tick. Every safety rule — tip equality,
    // never switching branches, never touching the current/held/protected
    // branches, the per-pass cap — lives in ./pure's reapVerdict and ./git's
    // reapBranches; this side owns only the cadence. Fire-and-log: a pass never
    // toasts and never touches the dialog. A clean pass replaces the note (zero
    // reaped clears it, so a stale "Tidied" cannot outlive the branches), and a
    // reply error is appended to whatever the pass did reap.
    async function maybeTidy(dir: string): Promise<void> {
      if (tidyInFlight.has(dir)) return
      // The preference is cached after the first read, so this is at most one
      // IPC per directory and an explicit OFF costs no reap call at all.
      if (!(await ensureTidyEnabled(dir))) return
      // Re-check after the await: another tick may have started a pass while
      // this one was reading the preference.
      if (tidyInFlight.has(dir)) return
      const now = Date.now()
      if (!tidyDue(tidyLast.get(dir), now, TIDY_COOLDOWN_MS)) return
      tidyInFlight.add(dir)
      // Stamp at fire time, not at reply time: a pass that fails or hangs must
      // not turn every slow tick into a retry.
      tidyLast.set(dir, now)
      try {
        const raw = await ctx.main(PrPanel).reap({ directory: dir })
        // Skips, the cap and truncation are routine noise and are deliberately
        // not stored: the summary is exactly the branches this pass reaped, the
        // restore commands, and whether anything failed. tidyNote keeps all
        // three together, so a pass that deleted branches and THEN failed (a
        // prune failure, say) reports both instead of hiding the restores.
        const reply = parseJson<unknown>(raw)
        // An unreadable reply is not a clean pass; keep the previous note rather
        // than claim the repository is tidy.
        const note = tidyNote(reply)
        if (note === undefined) return
        setTidySummary({ directory: dir, ...note })
      } catch {
        // Fire-and-log: a rejected IPC is not shown; the next due pass retries.
      } finally {
        tidyInFlight.delete(dir)
      }
    }
    // A directory change cancels any timer the previous source left behind, even
    // while its reply is still in flight, and drops the thread count's request
    // so a reply for the old directory can never paint into the new one.
    createKeyed(
      () => directory(),
      () => {
        clearPoll()
        abortThreads()
        threadsDir = undefined
        threadsGen += 1
      },
    )

    // The previous directory's result is hidden the instant the session changes:
    // `latest` may still hold it, so only read it when it belongs to this one.
    // When it does not, the last-good snapshot for the CURRENT directory paints
    // instead, while `pr.loading` keeps the existing "Checking" indicator over
    // it; the completed fetch replaces it. The read stays reactive because it
    // follows `directory()` and `pr.latest`, which every fetch result updates.
    const data = () => {
      const dir = directory()
      const latest = pr.latest
      const current =
        latest !== undefined && latest.directory === dir
          ? latest.data
          : dir !== undefined
            ? snapshots.get(dir)?.pr
            : undefined
      return current === undefined ? undefined : withThreads(dir ?? "", current)
    }
    const failure = () => {
      const current = data()
      return current !== undefined && !current.ok ? current : undefined
    }
    const view = () => {
      const current = data()
      return current !== undefined && current.ok ? current : undefined
    }

    // Hydrate the panel's auto-fix toggle whenever an open PR is shown. The
    // cached preference from `ensureAutoFix` is reused, so this is at most one
    // IPC read per directory.
    createEffect(() => {
      const dir = directory()
      const current = view()
      if (dir === undefined || current === undefined) return
      if ((current.state ?? "").toUpperCase() !== "OPEN") return
      void ensureAutoFix(dir).then((enabled) => {
        if (directory() === dir) setPanelAutoFix(enabled)
      })
    })

    const togglePanelAutoFix = async () => {
      const dir = directory()
      if (dir === undefined) return
      const next = !(panelAutoFix() ?? false)
      setPanelAutoFix(next)
      autoFixEnabled.set(dir, next)
      try {
        const raw = await ctx.main(PrPanel).autoFix({ directory: dir, enabled: next })
        const state = JSON.parse(raw) as { enabled?: boolean; error?: string }
        if (state.error !== undefined) {
          setResult({ directory: dir, text: `Auto-fix preference not saved: ${state.error}` })
          return
        }
        setPanelAutoFix(state.enabled === true)
        autoFixEnabled.set(dir, state.enabled === true)
      } catch (e) {
        setResult({ directory: dir, text: `Auto-fix preference not saved: ${message(e)}` })
      }
    }

    // Hydrate the panel's auto-tidy toggle once per directory. It is a
    // repository preference, not a property of the shown PR, so unlike the
    // auto-fix effect it does not wait for an open PR. `tidyPrefDir` keeps a
    // re-render from re-reading the same preference.
    let tidyPrefDir: string | undefined
    createEffect(() => {
      const dir = directory()
      if (dir === undefined || dir === "") return
      if (tidyPrefDir === dir) return
      tidyPrefDir = dir
      void ensureTidyEnabled(dir).then((enabled) => {
        if (directory() === dir) setPanelTidy(enabled)
      })
    })

    // Mirrors `togglePanelAutoFix`: optimistic local state, saved through the
    // reaper IPC, and a failed save says so in the panel instead of pretending
    // the switch stuck. The optimistic default is OFF, matching the contract's
    // missing-file default. A `known: false` read shows Off (fail closed, see
    // `ensureTidyEnabled`) as well, so the first click here is the explicit
    // opt-in that repairs the preference file — it starts from an empty map,
    // which also discards other directories' stored values because the corrupt
    // file cannot be trusted; that write is the only repair path.
    //
    // The optimistic paint lasts only until the reply resolves. `settle` applies
    // `tidyToggleOutcome`, which fails CLOSED to Off for an error reply, an
    // unreadable/unknown reply and a thrown IPC: only an authoritative
    // `{ known: true, enabled: true }` leaves the switch On, and the cache the
    // reaper reads follows the same value so an unproven save cannot start a pass.
    const togglePanelTidy = async () => {
      const dir = directory()
      if (dir === undefined) return
      const next = !(panelTidy() ?? false)
      setPanelTidy(next)
      reaperEnabled.set(dir, next)
      const settle = (outcome: TidyToggleOutcome) => {
        setPanelTidy(outcome.enabled)
        reaperEnabled.set(dir, outcome.enabled)
        if (outcome.error !== undefined) {
          setResult({ directory: dir, text: `Auto-tidy preference not saved: ${outcome.error}` })
        }
      }
      try {
        const raw = await ctx.main(PrPanel).reaper({ directory: dir, enabled: next })
        settle(tidyToggleOutcome(parseJson<unknown>(raw), false))
      } catch (e) {
        settle(tidyToggleOutcome(undefined, true))
        setResult({ directory: dir, text: `Auto-tidy preference not saved: ${message(e)}` })
      }
    }
    const visibleResult = () => {
      const current = result()
      return current !== undefined && current.directory === directory() ? current.text : undefined
    }
    const visibleAutoFixNote = (dir = directory()) => {
      const current = autoFixNote()
      return current !== undefined && current.directory === dir ? current.text : undefined
    }
    // The reaper's one-line note. Skips and truncation are not part of it: a
    // pass that reaped nothing shows only the failure line (if it failed), so
    // routine noise never lands in the panel. A pass that reaped branches and
    // THEN failed keeps both facts: the restore commands ride on the title/aria
    // and survive the prune failure, while the failure is appended as a ` · `
    // suffix on the same line. Deviation on purpose: the reaper gets exactly one
    // line in the panel, and a second div for the failure would push the rows
    // below it down.
    const visibleTidyNote = (dir = directory()) => {
      const current = tidySummary()
      if (current === undefined || current.directory !== dir) return undefined
      const failed = current.failed ? ctx.t("panel.tidyFailed") : undefined
      if (current.branches.length === 0) return failed
      // Three names, then an ellipsis: this stays one line, and the restore
      // commands ride on the title instead of wrapping the note.
      const shown = current.branches.slice(0, 3).join(", ")
      const more = current.branches.length > 3 ? "…" : ""
      const tidied = ctx.t("panel.tidied", { list: `${shown}${more}` })
      return failed === undefined ? tidied : `${tidied} · ${failed}`
    }
    const tidyRestoreTitle = (dir = directory()) => {
      const current = tidySummary()
      if (current === undefined || current.directory !== dir || current.restores.length === 0) return undefined
      return ctx.t("panel.tidyRestore", { cmds: current.restores.join("\n") })
    }

    const refresh = () => {
      clearPoll()
      setTick((value) => value + 1)
    }

    // Cold-directory prefetch (Phase 1, item 10). A KNOWN directory already
    // paints at 0ms from the Tier A snapshot map and the poll keeps it fresh,
    // so a user gesture must spend a `gh` call only when this directory has no
    // snapshot AND no fresh result yet:
    // - `dir === directory()`: `refresh()` bumps the shared tick, which fetches
    //   the ROUTED session's directory, so a gesture for another directory must
    //   not trigger it.
    // - `pr.loading`: the in-flight fetch IS the prefetch; this is the guard
    //   that keeps repeated focus/enter events from stacking requests.
    // - a `pr.latest` for this directory is a fresh result; a `snapshots` entry
    //   is a last-good paint. Either one means "already warm", and the poll owns
    //   freshness from there.
    const prefetchCold = (dir: string | undefined): void => {
      if (dir === undefined || dir === "") return
      if (dir !== directory()) return
      if (pr.loading) return
      const latest = pr.latest
      if (latest !== undefined && latest.directory === dir) return
      if (snapshots.get(dir)?.pr !== undefined) return
      refresh()
    }

    // The panel's Merge button is available only for a mergeable open PR:
    // failing checks and conflicts drop the row instead of disabling it.
    const panelCanMerge = () => {
      const current = view()
      if (current === undefined || (current.state ?? "").toUpperCase() !== "OPEN") return false
      if (summarizeChecks(current.checks).failing) return false
      return !hasConflicts(current)
    }
    const panelMergeNote = () => {
      const current = view()
      if (current === undefined || (current.state ?? "").toUpperCase() !== "OPEN") return undefined
      if (hasConflicts(current)) return ctx.t("panel.mergeConflicts")
      return undefined
    }

    // The panel's own Create PR gets the same gate as the confirm: never create
    // from a stale remote head while local commits (or no upstream) exist, and
    // never offer it beside a dirty tree the confirm would commit first.
    const panelCanCreate = () => {
      const divergence = divergenceFor(directory())
      return (
        divergence !== undefined && !divergence.dirty && !divergence.noUpstream && divergence.ahead === 0
      )
    }
    const panelCreateHint = () => {
      const divergence = divergenceFor(directory())
      if (divergence === undefined) return ctx.t("dialog.checkingAhead")
      if (divergence.dirty) return ctx.t("panel.commitFirst")
      if (divergence.noUpstream) return ctx.t("dialog.notPushed")
      return ctx.t("dialog.ahead", { count: String(divergence.ahead) })
    }
    // The panel's Create button opens the same dialog as the titlebar chip, so on
    // the base branch it must name the action that dialog's primary performs
    // (branch creation). Same fail-closed rule as `onBase()` inside the dialog: an
    // absent/empty base is never on base, and the branch side is the reported one.
    const panelOnBase = () => {
      const baseBranch = divergenceFor(directory())?.base
      const branch = failure()?.branch
      return baseBranch !== undefined && baseBranch !== "" && baseBranch === branch
    }

    const toneWord = (tone: PrTone): string => ctx.t(toneWordKey(tone))

    // `summarizeChecks` (./pure) returns the winning rule and its i18n key; the
    // two counted kinds interpolate their own count, the rest are plain words.
    // Both the chip label and the panel's "Checks:" line read this one helper,
    // so they can never word the same summary differently.
    const checksLabel = (checks: Check[] | undefined): string => {
      const summary = summarizeChecks(checks)
      if (summary.kind === "failing") {
        return ctx.t(summary.labelKey, { count: String(summary.failingCount) })
      }
      if (summary.kind === "pending") {
        return ctx.t(summary.labelKey, { count: String(summary.pending) })
      }
      return ctx.t(summary.labelKey)
    }

    // Unresolved review threads on the chip: `undefined` for no segment (0 or
    // unknown). `null` means the GraphQL query failed, so the chip stays short
    // rather than claiming "0 open items".
    const chipThreads = (pr: PrOk): number | undefined => {
      const count = pr.reviewThreads?.unresolved
      return typeof count === "number" && count > 0 ? count : undefined
    }

    // The single stage the chip reports. The word, the aria colour namespace
    // and the visible label all read this one order, so the chip can never show
    // two facts at once: Review items > Failing > Conflicts > Pending >
    // Unknown > Open (all green / no checks). Merged, Closed, Error, Detached
    // and Checking never reach here, so open items cannot displace their word.
    // The order itself lives in ./pure (chipStage) so it can be pinned by tests.

    // Exactly one segment after `PR #n ·`, chosen by the stage above.
    const chipLabel = (pr: PrOk): string => {
      switch (chipStage(prFacts(pr))) {
        case "review":
          return ctx.t("dialog.chipThreadsOpen", { n: String(chipThreads(pr) ?? 0) })
        case "conflicts":
          return ctx.t("panel.stateConflicts")
        case "unknown":
          return ctx.t("panel.stateUnknown")
        default:
          return checksLabel(pr.checks)
      }
    }

    // The tooltip/aria rest still carries the review count on every chip state,
    // including non-open ones, so a screen reader hears it even when the visible
    // label keeps the state word.
    const chipRest = (rest: string, pr: PrOk): string => {
      const count = chipThreads(pr)
      if (count === undefined) return rest
      return `${rest} · ${ctx.t("dialog.chipThreadsOpenTitle", { n: String(count) })}`
    }

    // The chip's namespace state word. Kept in English because it is the
    // matchable part of `aria-label` (the Style rules key off it), while the
    // visible label keeps its existing localized text. Reads the same stage as
    // `chipLabel`.
    const chipStateWord = (pr: PrOk): string => {
      switch (chipStage(prFacts(pr))) {
        case "review":
          return "Review items"
        case "failing":
          return "Failing"
        case "conflicts":
          return "Conflicts"
        case "pending":
          return "Pending"
        case "unknown":
          return "Unknown"
        default:
          return "Open"
      }
    }

    // B3: every chip title carries this plugin's namespace so the Style rules
    // can colour it without touching the built-in update pill. The state word
    // is the chip's own state, not the host's localized update label.
    const chipTitle = (state: string, rest: string, dir: string): string => {
      const divergence = divergenceFor(dir)
      const hints: string[] = []
      if (divergence !== undefined) {
        if (divergence.ahead > 0) hints.push(`+${divergence.ahead} unpushed`)
        if (divergence.dirty) hints.push("dirty")
      }
      const tail = hints.length > 0 ? ` · ${hints.join(" · ")}` : ""
      return `PR · ${state} · ${rest}${tail}`
    }

    ctx.add(Style, PR_STYLE)

    const merge = async () => {
      const current = view()
      const dir = directory()
      if (current === undefined || dir === undefined) return
      if (current.number === undefined || current.url === undefined) return
      if (!panelCanMerge()) {
        setResult({ directory: dir, text: ctx.t("panel.mergeConflicts") })
        setConfirming(false)
        return
      }

      setBusy(true)
      setResult(undefined)
      try {
        const text = await ctx.main(PrPanel).merge({
          directory: dir,
          number: current.number,
          url: current.url,
          confirm: "merge",
        })
        setResult({ directory: dir, text })
      } catch (e) {
        setResult({ directory: dir, text: `merge failed: ${message(e)}` })
      } finally {
        setBusy(false)
        setConfirming(false)
        refresh()
      }
    }

    // The titlebar chip opens a compact single-question confirm instead of a
    // hover menu: the TitlebarItem API has no menu, only `run`. The state
    // machine below picks exactly one question from the PR status + origin
    // divergence, so after each success both are refreshed and the chip
    // advances to the next state on its own. Row rules:
    //   normal row      Cancel + one ghost secondary (Review on open-PR states,
    //                   Option 2 where one exists) + the tone-filled primary
    //                   from `option1`; the merged row has NO ghost secondary —
    //                   the reaper tidies after the fact — so it is Cancel +
    //                   `Sign off` + the primary
    //   resolve row     Cancel + the demoted normal primary as a ghost + the
    //                   filled `Resolve Review Items` (open PRs with >0
    //                   unresolved threads only); the Review ghost is dropped
    //   merge state     a `Reset workspace after merge` switch sits above the
    //                   row and, when on, relabels the primary `Merge & Reset`
    // What the confirm dialog is currently doing; one tag per action kind.
    type BusyAction =
      | "create"
      | "merge"
      | "continue"
      | "fix"
      | "review"
      | "resolve"
      | "conflicts"
      | "signOff"
      | "branch"
      | "stashCreate"
      | "commit"
      | "push"
      | "pushCreate"
      | "retry"
      | "reset"
      | "mergeReset"

    const PrActions = (props: { dialog: DialogHandle; session: MountedSession; targetDir: string }) => {
      const [busyAction, setBusyAction] = createSignal<BusyAction>()
      const [mergeReset, setMergeReset] = createSignal(false)
      // Merge is two-step in the dialog too (the panel already is): the first
      // click arms, the second merges. The armed value is the PR number it was
      // armed on, so a refreshed view that shows another PR (or none) reads as
      // un-armed with no timer behind it; `mergeArmed` derives the answer.
      const [mergeArmedFor, setMergeArmedFor] = createSignal<number>()
      const [error, setErrorSignal] = createSignal<string>()
      const [actionResult, setActionResult] = createSignal<string>()
      // The chosen action's inputs, rendered inside this dialog (the same body
      // that already hosts the merge-reset switch). `titleField`/`bodyField`
      // are the PR title and description for the flows that open a PR. Branch
      // creation takes NO input: the queued prompt has the agent name and
      // create the branch from verified live state.
      const [titleField, setTitleField] = createSignal("")
      const [bodyField, setBodyField] = createSignal("")

      const setError = (text?: string) => {
        setErrorSignal(text)
        // An error ends the merge confirmation: the warning must never outlive
        // the attempt it was armed for (a failed merge would otherwise leave a
        // primed "Confirm merge" on screen).
        if (text !== undefined) setMergeArmedFor(undefined)
      }

      // An action error can outlive its cause: it was only cleared by the next
      // attempt or by closing the dialog. Clear it when a NEW fresh status result
      // arrives for this directory instead. Only `pr.latest` counts — a paint
      // from the Tier A snapshot map or a `pr.loading` toggle says nothing about
      // the worktree. Every action ends with `refreshAll()`, which arms the
      // one-shot token consumed by the request it starts, so that request's own
      // result never clears the message the action just produced — whatever
      // order it lands in, and whether or not it succeeds (a rejected request
      // leaves nothing behind). A later poll (or a manual refresh from outside)
      // therefore clears a stale failure on its own.
      const freshResult = () => {
        const latest = pr.latest
        return latest !== undefined && latest.directory === props.targetDir ? latest : undefined
      }
      let seenFresh = freshResult()
      createEffect(() => {
        const latest = freshResult()
        if (latest === undefined || latest === seenFresh) return
        seenFresh = latest
        if (latest.keepError) return
        if (latest.data.ok) setError(undefined)
      })

      // The confirm is pinned to the directory it opened for: a session change
      // while it is open leaves it with no data rather than acting on another.
      const scoped = () => {
        const latest = data()
        return latest !== undefined && directory() === props.targetDir ? latest : undefined
      }
      const view = () => {
        const current = scoped()
        return current !== undefined && current.ok ? current : undefined
      }
      const summary = () => summarizeChecks(view()?.checks)
      const isNone = () => {
        const current = scoped()
        return current !== undefined && !current.ok && current.reason === "none"
      }
      const isOpen = () => (view()?.state ?? "").toUpperCase() === "OPEN"
      const isMerged = () => (view()?.state ?? "").toUpperCase() === "MERGED"
      const failing = () => summary().failing
      const number = () => view()?.number
      // The armed merge belongs to the PR number it was armed on (see the
      // signal): a refreshed view with another PR — or with no mergeable PR at
      // all — reads as un-armed, so a poll tick that changes the state drops the
      // confirmation without expiring one that is still valid.
      const mergeArmed = () => mergeArmedFor() !== undefined && mergeArmedFor() === number()
      const disarmMerge = () => setMergeArmedFor(undefined)
      const url = () => view()?.url
      const busy = () => busyAction() !== undefined

      // The one-shot handoff state for a button: `action` is the claim prefix
      // (`fix`, `review`, `resolve`, `conflicts`, `signOff`, `continue`,
      // `branch`). Read through `handoffClaimed`, so the setup-scope bump signal
      // repaints this dialog on claim/release/expiry with no timer of its own.
      // `scope` is the extra directory + source-state identity branch creation
      // needs (see `branchClaimScope`); the PR handoffs omit it. Repo actions
      // (merge, commit+push, push, create, retry) carry no claim and are never
      // disabled by this.
      const claimed = (action: string | undefined, scope?: string): boolean =>
        action !== undefined && handoffClaimed(action, number(), view()?.headSha, scope)
      // `undefined` when not claimed, so no tooltip is attached.
      const claimTitle = (action: string | undefined, scope?: string): string | undefined =>
        claimed(action, scope) ? ctx.t("dialog.handoffDone") : undefined
      // The one footer button shape. A handoff passes its claim (`fix`,
      // `review`, …): while it is live the button is disabled and the host
      // Tooltip carries `dialog.handoffDone`. Two constraints shape this:
      // `ctx.ui.Button` has no title/aria-label prop (the host owns its markup),
      // and the wrapper decision must be reactive — the poll can claim Fix while
      // the dialog is already painted — while Solid must not reuse one DOM node
      // across Show branches, so both branches build a fresh button. Repo
      // options pass no claim and are never gated.
      type ActionButtonProps = {
        claim?: string
        claimScope?: string
        label: string
        run: () => void
        class?: string
        variant?: "neutral" | "contrast" | "ghost" | "ghost-muted" | "danger"
        disabled?: boolean
        busy?: boolean
        autofocus?: boolean
      }
      const ActionButton = (props: ActionButtonProps) => {
        const button = () => (
          <ctx.ui.Button
            class={props.class}
            variant={props.variant ?? "neutral"}
            disabled={props.disabled === true || props.busy === true || claimed(props.claim, props.claimScope)}
            busy={props.busy}
            autofocus={props.autofocus}
            onClick={props.run}
          >
            {props.label}
          </ctx.ui.Button>
        )
        return (
          <Show when={claimTitle(props.claim, props.claimScope)} fallback={button()}>
            <ctx.ui.Tooltip value={claimTitle(props.claim, props.claimScope)}>{button()}</ctx.ui.Tooltip>
          </Show>
        )
      }

      // First paint comes from the shared snapshot (`data()`), so the modal has
      // its rows immediately; this refresh only makes them current. Automatic
      // refresh is gated on an in-flight fetch so opening the dialog twice does
      // not queue two requests. Freshness after that follows the panel poll,
      // which bumps the same shared source — the dialog has no timer of its own.
      // A stopped poll therefore stops the dialog's automatic refresh too (one
      // cadence for both surfaces); user-initiated refreshes stay ungated.
      if (!pr.loading) refresh()
      // A mounted dialog is one of the two "user is watching" signals that pick
      // the poll's fast cadence (item 8). Counted per mount and released on
      // dispose, so a host that swaps dialogs can never leave the count stuck.
      setDialogMounts((n) => n + 1)
      onCleanup(() => setDialogMounts((n) => Math.max(0, n - 1)))
      // The count runs alongside that refresh, not only after its reply: the
      // dialog paints amber for "pending" until the count lands (see
      // `reviewFact`), so starting it here removes the extra 1-1.7s wait.
      primeThreads(props.targetDir)

      // Divergence is the shared per-directory result the chip already reads,
      // so the dialog rows and the chip can never disagree, and rows paint as
      // soon as the snapshot or the latest fetch has one.
      const divergence = () => divergenceFor(props.targetDir)

      const refreshAll = () => {
        // Arm the one-shot so the request this starts carries `keepError` (see
        // the note beside the effect). Only arm when a request will actually
        // start, so the token can never be inherited by a later poll.
        if (directory() !== undefined) suppressClear = true
        refresh()
      }

      const dirty = () => divergence()?.dirty === true
      const ahead = () => divergence()?.ahead ?? 0
      const behind = () => divergence()?.behind ?? 0
      const noUpstream = () => divergence()?.noUpstream === true
      // The repository's default branch, when the reader could resolve one.
      // Absent is unknown, never "main", so every read below is fail-closed.
      const base = () => divergence()?.base
      const divergenceReady = () => divergence() !== undefined

      const detached = () => {
        const current = scoped()
        return current !== undefined && !current.ok && current.reason === "detached"
      }
      const detachedCommit = () => {
        const current = scoped()
        return current !== undefined && !current.ok ? current.commit : undefined
      }
      // Branch for the confirm body, including the no-PR/detached case where
      // `view()` is undefined but the failure record still carries a branch or
      // commit. A path must never render as a branch; when neither exists the
      // row is hidden rather than printing a placeholder.
      const plainBranch = () => {
        const branch = view()?.branch
        if (branch !== undefined && branch !== "") return branch
        const current = scoped()
        return current !== undefined && !current.ok ? current.branch : undefined
      }
      // On the base branch itself. gh refuses a PR whose head equals its base,
      // so the rows that assume a PR can be opened are doomed here and are
      // swapped for ones that can run. An unresolved (absent or empty) base is
      // never "on base": those states keep today's options exactly.
      const onBase = () => {
        const current = base()
        return current !== undefined && current !== "" && current === plainBranch()
      }
      const branchLabel = (): string | undefined => {
        const branch = plainBranch()
        if (branch !== undefined && branch !== "") return branch
        if (detached()) {
          const commit = detachedCommit()
          return commit !== undefined
            ? ctx.t("dialog.detachedBranch", { commit })
            : ctx.t("dialog.detachedNoCommit")
        }
        return undefined
      }

      // Availability, not disablement: the state machine only offers an action
      // that can run now.
      const canMerge = () =>
        isOpen() && !failing() && !hasConflicts(view() ?? {}) && number() !== undefined && url() !== undefined
      // Both conditions: a PR from a stale remote head would silently miss the
      // local commits, so Create PR waits for a pushed, fully-pushed branch.
      const canCreate = () => isNone() && divergenceReady() && !noUpstream() && ahead() === 0
      // A clean never-pushed branch still offers Push: the backend runs
      // `git push -u origin <branch>`.
      const canPush = () => !detached() && !dirty() && (ahead() > 0 || noUpstream())
      // "Push committed only" from the dirty state does not need a clean tree;
      // it pushes what is already committed and leaves the worktree alone.
      const canPushCommitted = () => !detached() && (ahead() > 0 || noUpstream())
      const canCommitPush = () => !detached() && dirty()
      const isStatusError = () => {
        const current = scoped()
        return current !== undefined && !current.ok && (current.reason === "error" || current.reason === "timeout")
      }

      type ActionKind =
        | "detached"
        | "merged"
        | "failing"
        | "conflicts"
        | "merge"
        | "dirty"
        | "push"
        | "create"
        | "error"

      // First applicable state wins; the order is the approved priority.
      const actionKind = (): ActionKind | undefined => {
        if (detached()) return "detached"
        if (isMerged()) return "merged"
        if (isOpen() && failing()) return "failing"
        if (isOpen() && hasConflicts(view() ?? {})) return "conflicts"
        if (isOpen() && canMerge()) return "merge"
        if (isNone() && dirty()) return "dirty"
        if (isNone() && !dirty() && (noUpstream() || ahead() > 0)) return "push"
        if (canCreate()) return "create"
        if (isStatusError()) return "error"
        return undefined
      }

      const failureDetail = () => {
        const current = scoped()
        if (current === undefined || current.ok) return undefined
        if (current.reason === "timeout") return ctx.t("panel.timeout")
        return current.error ?? ctx.t("panel.statusError")
      }

      // The armed merge belongs to the merge action only: switching away (to
      // conflicts, a failure, another state) drops it, so the relabelled primary
      // can never describe an action the dialog no longer offers.
      //
      // It also belongs to the PR NUMBER it was armed on. `mergeArmed` compares
      // the arm against the number, but that only HIDES a stale arm: a refresh
      // from #413 to #414 would leave #413 armed underneath, and a later refresh
      // back to #413 would show "Confirm merge" with no fresh first click. The
      // number change itself must clear the signal, so returning to a number
      // always starts un-armed and needs its own click.
      let shownNumber: number | undefined
      createEffect(() => {
        const current = number()
        // Both rules disarm the same signal, so one condition keeps the state
        // machine obvious: leaving the merge action, or a different number
        // being displayed (nothing to do on the first run, before any click).
        if (actionKind() !== "merge" || (shownNumber !== undefined && current !== shownNumber)) disarmMerge()
        shownNumber = current
      })

      // Which live action the dialog's inputs belong to. Derived from the same
      // state the primary button reads, never a separate mode flag, so a field
      // can only appear for an action that will actually consume it: the
      // branch-creating flow (Continue, Create branch, the on-base conditional
      // swaps) or the PR-creating one (`create`, and `doPushThenCreate`).
      const branchCreating = () =>
        actionKind() === "merged" ||
        actionKind() === "detached" ||
        (onBase() && (actionKind() === "dirty" || actionKind() === "create"))
      const prCreating = () => !onBase() && (actionKind() === "create" || actionKind() === "push")

      // One seed per (action, base, branch) shown: a title belongs to the
      // action on screen and must not leak into an unrelated one. The key is
      // the effect's own last value, the same shape as `shownNumber` above.
      // Branch creation has no field to seed — the prompt derives its own state.
      let seededFor: string | undefined
      createEffect(() => {
        const key = `${actionKind() ?? ""}\u0000${onBase() ? "base" : ""}\u0000${plainBranch() ?? ""}`
        if (key === seededFor) return
        seededFor = key
        setTitleField(prCreating() ? (plainBranch() ?? "") : "")
        setBodyField("")
      })

      // Branch creation is a queued handoff, not an IPC call: the prompt has the
      // agent pick a name and create the branch from verified live state, so the
      // dialog offers no name field. Its one-shot claim is directory- and
      // source-scoped: `branch#<sha>` alone collides across repositories and
      // worktrees, and a PR's headSha is a claim about the remote PR, never proof
      // of the local HEAD.
      type BranchMode = "create" | "stash" | "continue" | "continue-stash"
      const branchSourceState = () =>
        detached()
          ? `detached:${detachedCommit() ?? "unknown"}`
          : `${plainBranch() ?? "unknown"}:${dirty() ? "dirty" : "clean"}`
      // The SAME string both disables the button and guards the click, so only
      // the click that actually queued this state can suppress the duplicate.
      const branchClaimScope = (mode: BranchMode): string =>
        `${props.targetDir}\u0000${mode}\u0000${branchSourceState()}`

      // The prompt's state sentence, derived from the same reads the options
      // use. The prompt tells the agent to re-check all of it live, so a stale
      // panel can never make it create the branch in the wrong place.
      const branchStateText = (): string => {
        if (detached()) {
          return ctx.t("dialog.branchStateDetached", { commit: detachedCommit() ?? "an unknown commit" })
        }
        const branch = plainBranch() ?? "an unknown branch"
        const known = base() ?? "the default branch"
        return dirty()
          ? ctx.t("dialog.branchStateDirty", { branch, base: known })
          : ctx.t("dialog.branchStateClean", { branch, base: known })
      }
      // The one branch-creating prompt, for all six arms. A merged state also
      // re-verifies the PR; every other state re-verifies the repo instead.
      const branchPromptText = (merged: boolean): string => {
        const current = view()
        return ctx.t("dialog.branchPrompt", {
          state: branchStateText(),
          stale: merged
            ? staleMergedText(String(current?.number ?? "?"), current?.base ?? base() ?? "the default branch")
            : ctx.t("dialog.staleBranch"),
        })
      }

      const prInput = (): { title: string | undefined; body: string | undefined } => ({
        title: titleField().trim() || undefined,
        body: bodyField().trim() || undefined,
      })

      // Titles are the question form of the action; PR states name the number
      // (the number moved out of the body meta line into the title). While the
      // status is still loading there is no action, so the title states the
      // subject instead of repeating the body loader's progress text.
      const title = () => {
        switch (actionKind()) {
          case "detached":
            return ctx.t("confirm.detachedTitle")
          case "merged":
            return ctx.t("confirm.mergedTitle", { number: String(number() ?? "?") })
          case "failing":
            return ctx.t("confirm.failingTitle", { number: String(number() ?? "?") })
          case "conflicts":
            return ctx.t("confirm.conflictsTitle", { number: String(number() ?? "?") })
          case "merge":
            return ctx.t("confirm.mergeTitle", { number: String(number() ?? "?") })
          case "dirty":
            return onBase() ? ctx.t("confirm.moveToNewBranchTitle") : ctx.t("confirm.dirtyTitle")
          case "push":
            return onBase()
              ? ctx.t("confirm.pushToBaseTitle", { base: base() ?? "" })
              : ctx.t("confirm.pushTitle")
          case "create":
            // On base the row creates the branch a PR needs, so the question is
            // the branch question, not the PR one.
            return onBase()
              ? ctx.t("confirm.detachedTitle")
              : ctx.t("confirm.createTitle", { branch: plainBranch() ?? "this branch" })
          case "error":
            return ctx.t("confirm.errorTitle")
          default:
            return ctx.t("dialog.checkingTitle")
        }
      }

      const canOpenGithub = () => ctx.desktop !== undefined && url() !== undefined
      const openGithub = () => {
        const link = url()
        if (link !== undefined) ctx.system.openExternal(link)
        props.dialog.close()
      }

      const isCreateFailure = (text: string) =>
        /^(Create PR failed|Create PR refused|Create PR cancelled)/.test(text)

      // The shared action skeleton: one busy slot, both inline lines cleared,
      // the body, one per-handler failure sentence, then the slot released and
      // the reads refreshed. Guards stay at the call site — they refuse before
      // a busy slot exists. `refresh` is deliberately not a flag: the flows
      // that refresh inside their own success path (Continue, stash create,
      // create branch) opt out entirely instead of passing `false`.
      type RunActionSpec = {
        busy: BusyAction
        body: () => Promise<void>
        failed: (error: unknown) => string
      }
      const runAction = async (spec: RunActionSpec) => {
        setBusyAction(spec.busy)
        setError(undefined)
        setActionResult(undefined)
        try {
          await spec.body()
        } catch (e) {
          setError(spec.failed(e))
        } finally {
          setBusyAction(undefined)
          refreshAll()
        }
      }

      const doCreate = async () => {
        await runAction({
          busy: "create",
          body: async () => {
            const text = await ctx.main(PrPanel).create({ directory: props.targetDir, ...prInput() })
            if (isCreateFailure(text)) {
              setError(text)
              return
            }
            ctx.toast.show({ title: ctx.t("dialog.created"), description: text, variant: "success" })
            props.dialog.close()
          },
          failed: (e) => `Create PR failed: ${message(e)}`,
        })
      }

      // Two-step merge, matching the panel (Merge → warning → Confirm merge):
      // this runs only on the SECOND click. The first click only arms it (see
      // `armMerge`); everything here is the existing flow unchanged — same
      // guards, same `confirm: "merge"` IPC payload.
      const doMerge = async () => {
        const current = view()
        if (
          current === undefined ||
          current.number === undefined ||
          current.url === undefined ||
          !canMerge()
        ) {
          setError(ctx.t("dialog.mergeUnavailable"))
          return
        }
        const number = current.number
        const url = current.url
        await runAction({
          busy: "merge",
          body: async () => {
            const text = await ctx.main(PrPanel).merge({
              directory: props.targetDir,
              number,
              url,
              confirm: "merge",
            })
            if (/^(oc-pr-gui refused|pr_merge failed)/.test(text)) {
              setError(text)
              return
            }
            ctx.toast.show({ title: ctx.t("dialog.merged"), description: text, variant: "success" })
            props.dialog.close()
          },
          failed: (e) => `Merge failed: ${message(e)}`,
        })
      }

      // Merge & Reset: the merge call runs first and is never rolled back. A
      // reset step that still fails after an accepted merge is reported as
      // steps + error and nothing is retried. `mergeAccepted` is separate from
      // "merged": `gh pr merge --auto` only queues the merge, and a merge-call
      // failure means no reset was attempted at all. Success stays inline (the
      // dialog does not close), so there is no success toast to duplicate it.
      const doMergeAndReset = async () => {
        const current = view()
        if (
          current === undefined ||
          current.number === undefined ||
          current.url === undefined ||
          !canMerge()
        ) {
          setError(ctx.t("dialog.mergeUnavailable"))
          return
        }
        setBusyAction("mergeReset")
        setError(undefined)
        setActionResult(undefined)
        let mergeAccepted = false
        try {
          const text = await ctx.main(PrPanel).merge({
            directory: props.targetDir,
            number: current.number,
            url: current.url,
            confirm: "merge",
          })
          if (/^(oc-pr-gui refused|pr_merge failed)/.test(text)) {
            setError(text)
            return
          }
          mergeAccepted = true
          // The merge request was accepted (gh `--squash --auto` queues it);
          // the reset runs now and its refusals stand on their own. A queued
          // merge is not MERGED yet, so the gh check refuses by name instead of
          // treating the branch as merged; a landed merge passes it.
          setActionResult(ctx.t("confirm.progressReset"))
          const raw = await ctx.main(PrPanel).resetWorkspace({
            directory: props.targetDir,
            confirm: "reset",
            number: current.number,
          })
          const reply = JSON.parse(raw) as { ok: boolean; steps?: string[]; error?: string }
          const steps = reply.steps ?? []
          setActionResult(steps.length === 0 ? undefined : steps.join("\n"))
          if (!reply.ok) {
            setError(
              ctx.t("dialog.mergeResetFailed", {
                error: reply.error ?? "the reset did not finish",
              }),
            )
            return
          }
          // Deliberately no success toast here: the dialog stays open and the
          // steps above already report the same reset inline.
        } catch (e) {
          setError(
            mergeAccepted
              ? ctx.t("dialog.mergeResetFailed", { error: message(e) })
              : ctx.t("dialog.mergeRequestFailed", { error: message(e) }),
          )
        } finally {
          setBusyAction(undefined)
          refreshAll()
        }
      }

      // The dialog's two-step merge, the mirror of the panel's Merge → warning →
      // Confirm merge row. First click: arm the merge (no IPC, no busy slot), so
      // the primary relabels to "Confirm merge" / "Confirm merge & reset" and the
      // warning line appears in the body. Second click: disarm and run the
      // existing handler — the accidental single click on a destructive action
      // can no longer merge anything. `mergeArmed` is cleared before the call, so
      // a failure comes back un-armed; `setError` and the fresh-result effect
      // also drop it. The mode (plain merge vs merge & reset) is read once per
      // click from the switch, which is itself gated while armed.
      const armMerge = (reset: boolean) => {
        if (!mergeArmed()) {
          setMergeArmedFor(number())
          return
        }
        disarmMerge()
        void (reset ? doMergeAndReset() : doMerge())
      }

      const doCommitPush = async () => {
        if (!canCommitPush()) {
          setError("Commit + Push is not available right now.")
          return
        }
        await runAction({
          busy: "commit",
          body: async () => {
            const raw = await ctx.main(PrPanel).commitPush({ directory: props.targetDir, confirm: "commit" })
            const reply = JSON.parse(raw) as {
              ok: boolean
              committed?: number
              pushed?: string
              error?: string
              errorDetail?: string
            }
            if (!reply.ok || reply.committed === undefined) {
              // `errorDetail` is a detail whose own sentence punctuation is already
              // in place; `error` is a full sentence from the later steps and must
              // not be wrapped twice.
              setError(
                reply.errorDetail !== undefined
                  ? ctx.t("dialog.commitPushFailed", { error: reply.errorDetail })
                  : (reply.error ?? "Commit + Push failed."),
              )
              return
            }
            ctx.toast.show({
              title: ctx.t("dialog.commitPushDone", {
                count: String(reply.committed),
                pushed: reply.pushed ?? "pushed",
              }),
              variant: "success",
            })
            props.dialog.close()
          },
          failed: (e) => ctx.t("dialog.commitPushFailed", { error: message(e) }),
        })
      }

      const doPush = async () => {
        if (!canPushCommitted()) {
          setError("Push is not available right now.")
          return
        }
        await runAction({
          busy: "push",
          body: async () => {
            const raw = await ctx.main(PrPanel).push({ directory: props.targetDir, confirm: "push" })
            const reply = JSON.parse(raw) as { ok: boolean; pushed?: string; error?: string; errorDetail?: string }
            if (!reply.ok) {
              // `errorDetail` is the git failure only, punctuation included; the
              // refusals in `pushBranch` are full sentences and render verbatim.
              setError(
                reply.errorDetail !== undefined
                  ? ctx.t("dialog.pushFailed", { error: reply.errorDetail })
                  : (reply.error ?? ctx.t("dialog.pushFailed", { error: "git push exited non-zero" })),
              )
              return
            }
            ctx.toast.show({
              title: ctx.t("dialog.pushDone", { result: reply.pushed ?? "pushed" }),
              variant: "success",
            })
            props.dialog.close()
          },
          failed: (e) => ctx.t("dialog.pushFailed", { error: message(e) }),
        })
      }

      // Sequenced: push IPC, progress line, then create IPC. A push failure
      // never reaches the create call.
      const doPushThenCreate = async () => {
        if (!canPush()) {
          setError("Push is not available right now.")
          return
        }
        await runAction({
          busy: "pushCreate",
          body: async () => {
            setActionResult(ctx.t("confirm.progressPushing"))
            const raw = await ctx.main(PrPanel).push({ directory: props.targetDir, confirm: "push" })
            const reply = JSON.parse(raw) as { ok: boolean; pushed?: string; error?: string; errorDetail?: string }
            if (!reply.ok) {
              setActionResult(undefined)
              // Same split as `doPush`: detail composed here, sentence verbatim.
              setError(
                reply.errorDetail !== undefined
                  ? ctx.t("dialog.pushFailed", { error: reply.errorDetail })
                  : (reply.error ?? ctx.t("dialog.pushFailed", { error: "git push exited non-zero" })),
              )
              return
            }
            setActionResult(ctx.t("confirm.progressCreating"))
            const text = await ctx.main(PrPanel).create({ directory: props.targetDir, ...prInput() })
            if (isCreateFailure(text)) {
              setActionResult(undefined)
              setError(text)
              return
            }
            ctx.toast.show({ title: ctx.t("dialog.created"), description: text, variant: "success" })
            props.dialog.close()
          },
          failed: (e) => ctx.t("dialog.pushFailed", { error: message(e) }),
        })
      }

      // Continue (merged) and the two branch-creating arms share one queued
      // prompt: the agent names and creates the branch from verified live state,
      // then continues the work there. Nothing is created before the prompt
      // lands, so there is no reply shape, no partial-stash recovery state and
      // no branch-created success message any more.
      const doContinue = async (stash = false) => {
        const current = view()
        if (current === undefined || !isMerged()) {
          setError("Continue is not available for this pull request right now.")
          return
        }
        // The prompt lands in the session captured at open. If that session has
        // moved to another directory the dialog is stale; refuse before the
        // claim so the same state stays requestable.
        if (props.session.directory !== props.targetDir) {
          setError(ctx.t("dialog.staleSession"))
          return
        }
        const mode: BranchMode = stash ? "continue-stash" : "continue"
        // One-shot claim on this directory + source state. A live claim means an
        // earlier click already queued this exact state, whose own toast is the
        // user-visible report, so this delivery is dropped rather than repeated.
        const claim = claimHandoff("branch", current.number, current.headSha, branchClaimScope(mode))
        if (claim === undefined) return
        await runQueuedPrompt({
          busy: "continue",
          text: branchPromptText(true),
          resultKey: "dialog.branchQueued",
          failedKey: "dialog.continueFailed",
          refresh: true,
          claim,
        })
      }

      // Guarded reset from the merged state: main runs the ordered sequence and
      // returns per-step lines either way. The dialog stays open so the steps
      // are visible; success also toasts.
      const doResetWorkspace = async () => {
        const current = view()
        if (current === undefined || !isMerged()) {
          setError("Reset is not available for this pull request right now.")
          return
        }
        const number = current.number
        await runAction({
          busy: "reset",
          body: async () => {
            const raw = await ctx.main(PrPanel).resetWorkspace({
              directory: props.targetDir,
              confirm: "reset",
              // Names the PR for the merged check; main refuses without it when
              // the branch has commits outside origin/<base>.
              number,
            })
            const reply = JSON.parse(raw) as { ok: boolean; steps?: string[]; error?: string }
            const steps = reply.steps ?? []
            setActionResult(steps.length === 0 ? undefined : steps.join("\n"))
            if (!reply.ok) {
              setError(reply.error ?? "Reset failed.")
              return
            }
            // Success stays inline (the dialog does not close), so no success
            // toast: it would report the same reset twice. Failures above still
            // set the inline error, and thrown failures keep their toast-free
            // `dialog.resetFailed` line.
          },
          failed: (e) => ctx.t("dialog.resetFailed", { error: message(e) }),
        })
      }

      // Dirty detached worktree (and the on-base dirty swap): the queued branch
      // prompt preserves the uncommitted work, so nothing is stashed before the
      // prompt lands. The claim is the stash mode's own state.
      const doStashCreate = async () => {
        const claim = claimHandoff("branch", number(), view()?.headSha, branchClaimScope("stash"))
        if (claim === undefined) return
        await runQueuedPrompt({
          busy: "stashCreate",
          text: branchPromptText(false),
          resultKey: "dialog.branchQueued",
          failedKey: "dialog.createBranchFailed",
          refresh: true,
          claim,
        })
      }

      // Detached HEAD (clean) and the on-base create swap: no mergeable PR, so
      // the prompt repairs the state by naming and creating a branch. A detached
      // HEAD is reported to the agent, which must stop rather than guess a base.
      const doCreateBranch = async () => {
        const claim = claimHandoff("branch", number(), view()?.headSha, branchClaimScope("create"))
        if (claim === undefined) return
        await runQueuedPrompt({
          busy: "branch",
          text: branchPromptText(false),
          resultKey: "dialog.branchQueued",
          failedKey: "dialog.createBranchFailed",
          refresh: true,
          claim,
        })
      }

      // Queued prompts: one shape for the five agent-handoff actions (Fix,
      // Review, Resolve, Resolve conflicts, Sign off). Each caller keeps its own
      // guard and prompt text; everything else — clearing the two inline lines,
      // queueing in the selected session, the delivery toast, closing on
      // success, clearing busy — is this helper. `refresh` is opt-in: only the
      // actions that mutate repo state through the agent (Fix, Resolve, Resolve
      // conflicts) re-read it afterwards; Review and Sign off are read-only and
      // deliberately do not.
      type QueuedPrompt = {
        busy: BusyAction
        text: string
        resultKey: string
        failedKey: string
        refresh?: true
        // Dedupe claim owned by the caller (the shared handoff map, one key per
        // action + state). Added by the caller before this runs; released here
        // on a failed prompt AND on either stale-session refusal before
        // delivery, so a retry can queue the same text again — the throw inside
        // the prompt call is not visible to the caller, and a refusal never
        // reaches it. Carries its own token: releasing it can never delete a
        // newer claim another path took after this one expired.
        claim?: HandoffClaim
      }
      const runQueuedPrompt = async (spec: QueuedPrompt) => {
        // A handoff prompts the session captured when the dialog opened. When
        // that session has moved to another directory, the dialog is showing
        // (and acting on) a different worktree than the prompt would land in, so
        // refuse instead of prompting the wrong session. `maybeAutoFix` enforces
        // the same rule on the poll path.
        //
        // The captured object cannot answer this: `MountedSession.directory` is
        // frozen and a move yields a new object, so this is only the cheap early
        // refusal. The authoritative check is `sessionTargets` below, after the
        // busy work an action may do between here and delivery.
        if (props.session.directory !== props.targetDir) {
          // The claim was taken by the caller before this helper ran; a refusal
          // before delivery must give it back or the same handoff can never retry.
          // Ownership-checked: this deletes only its own token, never a newer
          // claim taken after it expired.
          releaseHandoff(spec.claim)
          setError(ctx.t("dialog.staleSession"))
          return
        }
        setBusyAction(spec.busy)
        setError(undefined)
        setActionResult(undefined)
        try {
          // Live lookup immediately before delivery, with no await between this
          // check and the prompt call: a session that moved while this dialog was
          // open (or while the guards above ran) sends the prompt nowhere.
          if (!sessionTargets(props.session.id, props.targetDir)) {
            // Same ownership rule: only this claim's own token is deletable.
            releaseHandoff(spec.claim)
            setError(ctx.t("dialog.staleSession"))
            return
          }
          const item = await props.session.server.client.session.prompt({
            sessionID: props.session.id,
            text: spec.text,
            delivery: "queue",
          })
          ctx.toast.show({
            title: ctx.t(spec.resultKey, { delivery: deliveryWord(item) }),
            variant: "success",
          })
          props.dialog.close()
        } catch (e) {
          // Release a dedupe claim so the same prompt can be queued again.
          // Ownership-checked: a claim that expired and was re-claimed elsewhere
          // is left in place, so this catch cannot delete the newer owner's claim.
          releaseHandoff(spec.claim)
          setError(ctx.t(spec.failedKey, { error: message(e) }))
        } finally {
          setBusyAction(undefined)
          if (spec.refresh === true) refreshAll()
        }
      }

      const doFix = async () => {
        const current = view()
        if (current === undefined || !failing()) return
        // A "PR #" prompt with no number would name nothing; refuse instead.
        if (current.number === undefined) {
          setError(ctx.t("dialog.noPrNumber"))
          return
        }
        // Share the poll's Fix claim (`fix#number#sha`): the automatic path may
        // already have queued this exact prompt, and a manual click must not
        // enqueue the same bytes twice. Claim BEFORE the await and release it if
        // the prompt throws or is refused — the same pattern as `maybeAutoFix`
        // (claim, then call). The claim expires after `CLAIM_TTL_MS`, so a
        // handoff that never ran stops blocking this button once the previous
        // run is certainly stale. A PR without a head sha still gets a stable
        // `nohead` key, so a state change is what re-enables it; the poll path
        // skips that case because it has no branch tip to check instead.
        const claim = claimHandoff("fix", current.number, current.headSha)
        if (claim === undefined) {
          ctx.toast.show({
            title: ctx.t("panel.autoFixQueued"),
            description: ctx.t("dialog.queued"),
            variant: "default",
          })
          return
        }
        await runQueuedPrompt({
          busy: "fix",
          text: fixPromptText(current, current.number),
          resultKey: "dialog.fixResult",
          failedKey: "dialog.fixFailed",
          refresh: true,
          claim,
        })
      }

      // Review is a queued prompt, not main-process work: the agent loads the
      // pr-review skill and delegates the independent verdict to `advisor`.
      // Same helper as Fix, but nothing is mutated, so no refresh.
      const doReview = async () => {
        const current = view()
        if (current === undefined || !isOpen()) return
        if (current.number === undefined) {
          setError(ctx.t("dialog.noPrNumber"))
          return
        }
        // Every handoff claims its own `action#number#sha` key before queueing:
        // the button is disabled while the claim is live (the first line), and
        // this refusal is the last-line guard for a racing/programmatic second
        // call. The claim is released by runQueuedPrompt on a throw or a
        // stale-session refusal.
        const claim = claimHandoff("review", current.number, current.headSha)
        if (claim === undefined) return
        const head = current.branch ?? "this branch"
        await runQueuedPrompt({
          busy: "review",
          text: ctx.t("dialog.reviewPrompt", {
            number: String(current.number),
            head,
            base: current.base ?? "the base branch",
            stale: staleOpenText(String(current.number), head, current.headSha),
          }),
          resultKey: "dialog.reviewResult",
          failedKey: "dialog.reviewFailed",
          claim,
        })
      }

      // Unresolved review threads drive the primary button, but only while the
      // PR is open. GitHub keeps a merged/closed PR's threads, so a count can
      // outlive the window where resolving is a sensible action; on those
      // states the Resolve affordance must not displace `Continue on new
      // branch` / `Create branch`. `null` (unknown) and `0` keep the normal
      // primary too. The chip may still show the count on a closed PR.
      const unresolved = () => view()?.reviewThreads?.unresolved ?? 0
      const resolveActive = () => isOpen() && hasReviewWork(view()?.reviewThreads)
      // A requested Resolve must not keep owning the primary slot: the dialog
      // would then offer one filled button that is already disabled. While the
      // resolve claim is live the demotion is skipped — the normal primary stays
      // enabled and Resolve renders disabled beside it with `dialog.handoffDone`
      // — so there is always an actionable primary.
      const resolveClaimed = () => claimed("resolve")
      const resolveDemoted = () => resolveActive() && !resolveClaimed()

      // Resolution is a queued prompt like Review: the agent must present a
      // plan and wait for "Go ahead", then fix, push, reply, and resolve. The
      // modal itself never touches a thread. The pushed fix mutates the branch,
      // so this one refreshes like Fix.
      const doResolve = async () => {
        const current = view()
        if (current === undefined || current.number === undefined || !resolveActive()) return
        // One-shot like every handoff (see doReview). While this claim is live
        // the demotion below is skipped, so the row keeps an actionable primary.
        const claim = claimHandoff("resolve", current.number, current.headSha)
        if (claim === undefined) return
        await runQueuedPrompt({
          busy: "resolve",
          text: ctx.t("dialog.resolvePrompt", {
            number: String(current.number),
            count: String(unresolved()),
            token: approvalToken("resolve", String(current.number), current.headSha),
            stale: staleOpenText(
              String(current.number),
              current.branch ?? "this branch",
              current.headSha,
            ),
          }),
          resultKey: "dialog.resolveResult",
          failedKey: "dialog.resolveFailed",
          refresh: true,
          claim,
        })
      }

      // Conflicts is a queued prompt like Fix: the agent checks out the head
      // branch, merges the base into it, resolves, tests, commits and pushes.
      // The pushed merge mutates the branch, so this one refreshes like Fix.
      const doResolveConflicts = async () => {
        const current = view()
        if (current === undefined || !isOpen()) return
        if (current.number === undefined) {
          setError(ctx.t("dialog.noPrNumber"))
          return
        }
        const head = current.branch ?? "this branch"
        const claim = claimHandoff("conflicts", current.number, current.headSha)
        if (claim === undefined) return
        await runQueuedPrompt({
          busy: "conflicts",
          text: ctx.t("dialog.conflictsPrompt", {
            number: String(current.number),
            head,
            base: current.base ?? "the base branch",
            stale: staleOpenText(String(current.number), head, current.headSha),
          }),
          resultKey: "dialog.conflictsResult",
          failedKey: "dialog.conflictsFailed",
          refresh: true,
          claim,
        })
      }

      // Sign off is a queued prompt like Review: the agent gathers the facts,
      // classifies every uncommitted file, and presents a per-file cleanup plan
      // that waits for an explicit "Go ahead" — it never changes, commits, or
      // deletes anything itself. Same helper as Review: nothing to refresh
      // because nothing is mutated.
      const doSignOff = async () => {
        const current = view()
        if (current === undefined || !isMerged()) return
        if (current.number === undefined) {
          setError(ctx.t("dialog.noPrNumber"))
          return
        }
        const base = current.base ?? "the base branch"
        const claim = claimHandoff("signOff", current.number, current.headSha)
        if (claim === undefined) return
        await runQueuedPrompt({
          busy: "signOff",
          text: ctx.t("dialog.signOffPrompt", {
            number: String(current.number),
            branch: current.branch ?? plainBranch() ?? "this branch",
            base,
            count: String(divergence()?.changes ?? 0),
            token: approvalToken("signoff", String(current.number), current.headSha),
            stale: staleMergedText(String(current.number), base),
          }),
          resultKey: "dialog.signOffResult",
          failedKey: "dialog.signOffFailed",
          claim,
        })
      }

      // Status error/timeout: retry the status read, keeping the confirm open
      // so the inline line shows the fresh state.
      const doRetry = () => {
        setError(undefined)
        setActionResult(undefined)
        refreshAll()
      }

      // `claim` names the handoff whose one-shot state disables this option (see
      // `claimed`); `claimScope` carries the extra directory + source identity
      // branch creation needs. Repo actions leave both undefined.
      type Option = {
        label: string
        run: () => void
        variant?: "contrast" | "neutral"
        claim?: string
        claimScope?: string
      }

      const option1 = (): Option | undefined => {
        switch (actionKind()) {
          case "detached":
            // A dirty detached worktree takes the stash-preserving prompt; a
            // clean one keeps the plain branch prompt. Both are the same queued
            // handoff — the agent verifies the tree before touching anything.
            return dirty()
              ? {
                  label: ctx.t("dialog.stashCreate"),
                  run: () => void doStashCreate(),
                  variant: "contrast",
                  claim: "branch",
                  claimScope: branchClaimScope("stash"),
                }
              : {
                  label: ctx.t("dialog.createBranch"),
                  run: () => void doCreateBranch(),
                  variant: "contrast",
                  claim: "branch",
                  claimScope: branchClaimScope("create"),
                }
          case "merged":
            // The prompt preserves uncommitted work, so a dirty tree keeps the
            // same primary with wording that names the changes.
            return dirty()
              ? {
                  label: ctx.t("dialog.continueKeepChanges"),
                  run: () => void doContinue(true),
                  variant: "contrast",
                  claim: "branch",
                  claimScope: branchClaimScope("continue-stash"),
                }
              : {
                  label: ctx.t("dialog.continue"),
                  run: () => void doContinue(false),
                  variant: "contrast",
                  claim: "branch",
                  claimScope: branchClaimScope("continue"),
                }
          case "failing":
            return {
              label: ctx.t("dialog.fix"),
              run: () => void doFix(),
              variant: "contrast",
              claim: "fix",
            }
          case "conflicts":
            return {
              label: ctx.t("dialog.resolveConflicts"),
              run: () => void doResolveConflicts(),
              variant: "contrast",
              claim: "conflicts",
            }
          case "merge":
            // Armed: the primary is the confirmation (the panel's second step)
            // and the body shows `panel.warning` above the footer.
            return {
              label: mergeArmed()
                ? mergeReset()
                  ? ctx.t("dialog.confirmMergeReset")
                  : ctx.t("panel.confirm")
                : mergeReset()
                  ? ctx.t("dialog.mergeReset")
                  : ctx.t("panel.merge"),
              run: () => armMerge(mergeReset()),
              // `contrast`, not `danger`: the fill and its hover come from the
              // tone class (which matches the titlebar chip), so a danger-red
              // hover would contradict the approved merge tone.
              variant: "contrast",
            }
          case "dirty":
            // On base, committing here would put the work on the default branch
            // itself; the filled action moves it to a new branch first, and the
            // ghost is the explicit "commit onto base anyway".
            return onBase()
              ? {
                  label: ctx.t("dialog.moveToNewBranch"),
                  run: () => void doStashCreate(),
                  variant: "contrast",
                  claim: "branch",
                  claimScope: branchClaimScope("stash"),
                }
              : { label: ctx.t("dialog.commitPush"), run: () => void doCommitPush(), variant: "contrast" }
          case "push":
            // On base there is no PR to open after the push, so the row is the
            // plain push (its `Push only` ghost would say the same thing).
            return onBase()
              ? {
                  label: ctx.t("dialog.pushToBase", { base: base() ?? "" }),
                  run: () => void doPush(),
                  variant: "contrast",
                }
              : { label: ctx.t("confirm.pushThenCreate"), run: () => void doPushThenCreate(), variant: "contrast" }
          case "create":
            // On base the PR the filled action would open is the one gh refuses
            // (head == base), so the row creates the branch that makes one
            // possible instead.
            return onBase()
              ? {
                  label: ctx.t("dialog.createBranch"),
                  run: () => void doCreateBranch(),
                  variant: "contrast",
                  claim: "branch",
                  claimScope: branchClaimScope("create"),
                }
              : { label: ctx.t("dialog.create"), run: () => void doCreate(), variant: "contrast" }
          case "error":
            return { label: ctx.t("confirm.retry"), run: doRetry, variant: "contrast" }
          default:
            return undefined
        }
      }

      // Only the non-open states reach this: open-PR states get Review as the
      // secondary instead, and the GitHub affordance lives on the meta line.
      const option2 = (): Option | undefined => {
        switch (actionKind()) {
          case "dirty":
            // On base the ghost names the branch it commits to; off base it
            // stays the push-only escape that needs something to push.
            if (onBase()) {
              return {
                label: ctx.t("dialog.commitPushToBase", { base: base() ?? "" }),
                run: () => void doCommitPush(),
              }
            }
            return noUpstream() || ahead() > 0
              ? { label: ctx.t("confirm.pushOnly"), run: () => void doPush() }
              : undefined
          case "push":
            // On base the primary is already the plain push, so a ghost would
            // duplicate it.
            return onBase() ? undefined : { label: ctx.t("confirm.pushOnly"), run: () => void doPush() }
          default:
            return undefined
        }
      }

      // ---- Confirm restructure: meta line, fact chips ----
      // Tone names map onto the approved palette only, one name per hex:
      // `neutral` is #9CA3AF, while `none` is the hexless unfilled-primary case
      // (bare class). Fact chips use the hex tones per fact; the tone-filled
      // primary uses them per repo state, and must match the titlebar chip for
      // that same state (see `stateTone`).
      type ToneName = "green" | "redSoft" | "red" | "blue" | "amber" | "purple" | "neutral" | "none"
      // Facts always carry a real palette hex; `none` only describes a primary.
      type FactTone = Exclude<ToneName, "none">

      // The primary fill normally equals the colour the titlebar chip shows for
      // the same repo state, so this must stay in sync with the chip's word
      // table (`chipStateWord`, and the `PR · <State>` rules in PR_STYLE).
      // The one exception is the resolve-active row, which never reaches this
      // function: it fills redSoft unconditionally (review state, not repo
      // state) — see the palette note above `PALETTE`.
      // The matrix itself lives in ./pure (stateTone) as (actionKind, facts);
      // this wrapper only performs the two signal reads.
      const stateTone = (): ToneName => stateToneOf(actionKind(), prFacts(view() ?? {}))

      const toneHex = (tone: FactTone): string => PALETTE[tone]
      // The bare `oc-pr-gui-tone` marker carries the shared rules that clear
      // the host's contrast `background-image` (see PR_STYLE); `tone-<name>`
      // adds the approved fill and the `--oc-pr-gui-primary-tone` used by hover.
      const toneClass = (tone: ToneName): string =>
        tone === "none"
          ? "oc-pr-gui-primary"
          : `oc-pr-gui-primary oc-pr-gui-tone oc-pr-gui-tone-${tone}`

      // `<head> → <base>`; a missing base drops to the head alone. Never prints
      // a path as a branch. The PR number lives in the dialog title now.
      // Branch-creating dialogs hide the whole line: the meta was the branch
      // being replaced, and the queued prompt derives its state from live reads.
      // PR-creating dialogs keep it.
      const metaLine = (): string | undefined => {
        if (branchCreating()) return undefined
        const head = plainBranch() ?? branchLabel()
        if (head === undefined || head === "") return undefined
        const base = view()?.base
        if (base === undefined || base === "") return head
        return ctx.t("dialog.metaNoNumber", { head, base })
      }

      // The meta line is also the GitHub affordance: it runs the same handler
      // the removed `↗ GH` button used. `busy()` keeps that button's disabled
      // behaviour, and the label names the action for pointer and screen reader.
      const metaGithubLabel = () =>
        ctx.t("dialog.metaOpensGithub", { number: String(number() ?? "?") })
      const openMetaGithub = () => {
        if (busy()) return
        openGithub()
      }

      // The three PR facts come from `view()`. The chip is icon + label only;
      // the machine-readable state ("Checks passing") rides on
      // `title`/`aria-label`, so no value word is printed. Opening the dialog
      // fetches fresh status, and while it stays open the panel poll keeps
      // ticking at the fast cadence because a mounted dialog counts as the user
      // watching (the dialog has no timer of its own); with the region closed
      // and no dialog the poll still runs, one slow tick at a time, so this chip
      // stays at most one slow interval stale. `icon` overrides
      // the tone glyph when a fact needs its own mark (Changes uses ±, not the
      // amber ⚠ for a wait).
      type Fact = { label: string; title: string; tone: FactTone; icon?: string }
      // The four chips share this shape; only label, title, tone (and Changes'
      // glyph) differ, so build the record in one place.
      const fact = (label: string, title: string, tone: FactTone, icon?: string): Fact =>
        icon === undefined ? { label, title, tone } : { label, title, tone, icon }

      // The summary's `kind` already applies the failing > pending > none >
      // unknown order, so this builder reads it rather than re-deriving the
      // chain from `failing`/`pending`/`unknown` in its own order.
      const checksFact = (): Fact => {
        const label = ctx.t("dialog.factChecks")
        const current = view()
        if (current === undefined) return fact(label, ctx.t("dialog.chipChecksUnknown"), "neutral")
        switch (summarizeChecks(current.checks).kind) {
          case "failing":
            return fact(label, ctx.t("dialog.chipChecksFailing"), "redSoft")
          case "pending":
            return fact(label, ctx.t("dialog.chipChecksPending"), "amber")
          // An empty list and a recognized-but-unreadable state are both not a
          // pass: unknown, never green.
          case "none":
            return fact(label, ctx.t("dialog.chipChecksUnknown"), "neutral")
          case "unknown":
            return fact(label, ctx.t("dialog.checksUnknown"), "neutral")
          default:
            return fact(label, ctx.t("dialog.chipChecksPassing"), "green")
        }
      }
      const reviewFact = (): Fact => {
        const label = ctx.t("dialog.factReview")
        // Unresolved threads win when the count is known: "open items" is the
        // thing the Resolve action is about. `undefined` (not counted yet) and
        // `null` (the count failed) are both "unknown", so the review decision
        // below stays authoritative for them (red changes-requested outranks a
        // pending count). Only an unknown count with no decision on an open PR
        // reads amber pending — never the neutral "No review" that would look
        // like a pass while items are still open.
        const threads = view()?.reviewThreads
        if (threads !== undefined && threads !== null) {
          if (threads.unresolved > 0) {
            const count = String(threads.unresolved)
            return fact(
              ctx.t("dialog.chipThreadsOpen", { n: count }),
              ctx.t("dialog.chipThreadsOpenTitle", { n: count }),
              "redSoft",
            )
          }
          return fact(label, ctx.t("dialog.chipThreadsClear"), "green")
        }
        const decision = (view()?.reviewDecision ?? "").toUpperCase()
        if (decision === "APPROVED") return fact(label, ctx.t("dialog.chipReviewApproved"), "green")
        if (decision === "CHANGES_REQUESTED") {
          return fact(label, ctx.t("dialog.chipReviewChanges"), "redSoft")
        }
        if (decision === "REVIEW_REQUIRED") {
          return fact(label, ctx.t("dialog.chipReviewPending"), "amber")
        }
        if (isOpen()) {
          return fact(label, ctx.t("dialog.chipReviewPending"), "amber")
        }
        return fact(label, ctx.t("dialog.chipReviewNone"), "neutral")
      }
      const conflictsFact = (): Fact => {
        const label = ctx.t("dialog.factConflicts")
        const current = view()
        if (current === undefined) {
          return fact(label, ctx.t("dialog.chipConflictsUnknown"), "neutral")
        }
        if (hasConflicts(current)) return fact(label, ctx.t("dialog.chipConflicts"), "red")
        const mergeable = (current.mergeable ?? "").toUpperCase()
        if (mergeable === "" || mergeable === "UNKNOWN") {
          return fact(label, ctx.t("dialog.chipConflictsUnknown"), "neutral")
        }
        return fact(label, ctx.t("dialog.chipConflictsNone"), "green")
      }
      // Uncommitted work is a fact in every state (detached and merged
      // included), so the fourth chip reads the same divergence the dirty
      // action uses. Only rendered while `dirty`; the count is the uncapped
      // porcelain total, falling back to the display list if the field is
      // missing (older cached divergence payloads).
      const changesFact = (): Fact | undefined => {
        if (!dirty()) return undefined
        const count = divergence()?.changes ?? files().length
        const label =
          count > 0
            ? ctx.t("dialog.chipChanges", { count: String(count) })
            : ctx.t("dialog.chipChangesUncommitted")
        const title =
          count > 0
            ? ctx.t("dialog.chipChangesTitle", { count: String(count) })
            : ctx.t("dialog.chipChangesUncommitted")
        // Own glyph so blue here means "uncommitted work to start from", not
        // "waiting": the dot below is a toggle, not a problem, and the ± mark
        // is the fact's content rather than its tone glyph.
        return fact(label, title, "blue", "±")
      }
      // Fixed order. The three PR facts need loaded status data: while
      // `view()` is undefined they would all render as "–" placeholders and
      // read as three problems, so the row shows only Changes (when dirty)
      // and hides entirely when neither applies.
      const facts = (): Fact[] => {
        const out: Fact[] = view() !== undefined ? [checksFact(), reviewFact(), conflictsFact()] : []
        const changes = changesFact()
        if (changes !== undefined) out.push(changes)
        return out
      }

      // ✓ for good, ✗ for a blocking fact, ⚠ for pending, – for unavailable.
      // The Changes chip supplies its own ± via `Fact.icon`.
      const factIcon = (tone: FactTone): string => {
        switch (tone) {
          case "green":
            return "✓"
          case "red":
          case "redSoft":
            return "✗"
          case "amber":
            return "⚠"
          default:
            return "–"
        }
      }

      // One ghost beside the primary. Review covers every open-PR state
      // (failing, conflicts, merge); the remaining states keep their existing
      // Option 2 (Push from dirty/push) when it is available at all.
      // With Resolve as the filled primary the footer row is already Cancel +
      // the demoted normal action + Resolve, so the Review ghost is dropped
      // and returns only when the thread count is 0 or unknown.
      //
      // The merged state has NO secondary: merged branches are tidied after the
      // fact by the reaper, so the old "Back to main" ghost is gone. The one
      // consent moment that remains is the `Reset workspace after merge` switch
      // in the merge state (and Merge & Reset is only a label on that same
      // flow). A clean merged row is therefore Cancel + Sign off + the primary,
      // and a dirty row already rendered that shape.
      const secondary = (): Option | undefined => {
        if (resolveActive()) return undefined
        const kind = actionKind()
        if (kind === "failing" || kind === "conflicts" || kind === "merge") {
          return { label: ctx.t("dialog.review"), run: () => void doReview(), claim: "review" }
        }
        if (kind === "merged") return undefined
        return option2()
      }

      const files = () => divergence()?.files ?? []
      // One list serves every dirty state, but the noun follows the action:
      // the no-PR flow commits, a detached HEAD stashes, and the rest (merged,
      // open PRs) only shows what is uncommitted. The count is the uncapped
      // total; the list below it is truncated to 3 lines and the remainder is
      // rolled into one `dialog.filesMore` line.
      const filesHeading = () => {
        const count = String(divergence()?.changes ?? files().length)
        switch (actionKind()) {
          case "dirty":
            return ctx.t("dialog.commitPushFiles", { count })
          case "detached":
            return ctx.t("dialog.stashFiles", { count })
          default:
            return ctx.t("dialog.uncommittedFiles", { count })
        }
      }
      // Same total as the heading (not `files().length`, which is capped by the
      // reader): 3 rows are shown, the rest is a single muted line. 0 hides it.
      const filesMore = () => Math.max(0, (divergence()?.changes ?? files().length) - 3)

      // The buttons live in the host footer, not the scrolling body: a long
      // dirty-file list must not push the primary below the fold. The footer's
      // own 16px padding matches the header close button, so the row's right
      // edge lines up, and the row keeps its right-aligned 6px-gap layout.
      // Cancel is always offered, including while the status is still loading
      // (the host footer would otherwise be empty there). It is never disabled:
      // it only closes, and Escape already closes regardless of `busy()`.
      const cancelButton = () => (
        <ctx.ui.Button
          class="oc-pr-gui-cancel"
          variant="ghost"
          onClick={() => {
            // Cancel also drops an armed merge: the dialog never reopens with a
            // primed confirmation.
            disarmMerge()
            props.dialog.close()
          }}
        >
          {ctx.t("panel.cancel")}
        </ctx.ui.Button>
      )
      return (
        <ctx.ui.Dialog
          title={title()}
          size="fit"
          footer={
            actionKind() !== undefined || resolveActive() ? (
              <div
                style={{
                  display: "flex",
                  "justify-content": "flex-end",
                  "align-items": "center",
                  gap: "6px",
                  "flex-wrap": "wrap",
                }}
              >
                {cancelButton()}
                {/* Merged state only: Sign off is the fixed ghost between
                    Cancel and the primary now that the reset ghost is gone. It
                    shows regardless of the dirty count — the prompt handles 0
                    files. */}
                <Show when={actionKind() === "merged"}>
                  <ActionButton
                    claim="signOff"
                    class="oc-pr-gui-secondary"
                    variant="ghost"
                    label={ctx.t("dialog.signOff")}
                    disabled={busy()}
                    run={() => void doSignOff()}
                  />
                </Show>
                <Show when={secondary()}>
                  {(option) => (
                    <ActionButton
                      claim={option().claim}
                      claimScope={option().claimScope}
                      class="oc-pr-gui-secondary"
                      variant="ghost"
                      label={option().label}
                      disabled={busy()}
                      run={option().run}
                    />
                  )}
                </Show>
                {/* Resolve active: the normal primary is demoted to a plain
                    button and Resolve Review Items takes the filled slot —
                    unless the resolve claim is live (`resolveDemoted`), in which
                    case the normal primary keeps the filled slot enabled and
                    Resolve renders disabled beside it, so the row never offers
                    only a dead primary. */}
                <Show when={resolveActive()}>
                  <Show when={option1()}>
                    {(option) =>
                      resolveDemoted() ? (
                        <ActionButton
                          claim={option().claim}
                          claimScope={option().claimScope}
                          class="oc-pr-gui-secondary"
                          variant="ghost"
                          label={option().label}
                          disabled={busy()}
                          run={option().run}
                        />
                      ) : (
                        <ActionButton
                          claim={option().claim}
                          claimScope={option().claimScope}
                          class={toneClass(stateTone())}
                          variant={option().variant ?? "neutral"}
                          label={option().label}
                          busy={busy()}
                          autofocus
                          run={option().run}
                        />
                      )
                    }
                  </Show>
                  <ActionButton
                    claim="resolve"
                    class={toneClass("redSoft")}
                    variant="contrast"
                    label={ctx.t("dialog.resolve")}
                    busy={busy()}
                    autofocus={resolveDemoted()}
                    run={() => void doResolve()}
                  />
                </Show>
                <Show when={!resolveActive()}>
                  <Show when={option1()}>
                    {(option) => (
                      <ActionButton
                        claim={option().claim}
                        claimScope={option().claimScope}
                        class={toneClass(stateTone())}
                        variant={option().variant ?? "neutral"}
                        label={option().label}
                        busy={busy()}
                        autofocus
                        run={option().run}
                      />
                    )}
                  </Show>
                </Show>
              </div>
            ) : (
              <div style={{ display: "flex", "justify-content": "flex-end", "align-items": "center", gap: "6px" }}>
                {cancelButton()}
              </div>
            )
          }
        >
          <div style={{ width: "100%", "max-width": "420px", display: "grid", gap: "10px", "font-size": "12px" }}>
            {/* Meta line: branch → base (the number lives in the title). With a
                PR URL it is the GitHub link; without one it stays plain text. */}
            <Show when={metaLine() !== undefined}>
              <Show when={canOpenGithub()} fallback={<div style={{ opacity: 0.8 }}>{metaLine()}</div>}>
                <div
                  class="oc-pr-gui-meta-link"
                  role="link"
                  tabIndex={busy() ? -1 : 0}
                  aria-disabled={busy() ? "true" : undefined}
                  title={metaGithubLabel()}
                  aria-label={metaGithubLabel()}
                  onClick={openMetaGithub}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      openMetaGithub()
                    }
                  }}
                >
                  <span>{metaLine()}</span>
                  <span aria-hidden="true" style={{ "font-size": "10px", opacity: 0.7 }}>
                    ↗
                  </span>
                </div>
              </Show>
            </Show>

            {/* Facts, `·`-separated, icon + label only: the full state text
                ("Checks passing") rides on `title`/`aria-label`. The dot is
                aria-hidden and lives inside the same nowrap item as the chip
                that follows it, so flex-wrap can never orphan it at a line
                end or announce it. The row is hidden when there is nothing to
                show (status still loading and no uncommitted work). */}
            <Show when={facts().length > 0}>
              <div style={{ display: "flex", "align-items": "center", gap: "6px", "flex-wrap": "wrap" }}>
                {facts().map((fact, index) => (
                  <span
                    style={{
                      display: "inline-flex",
                      "align-items": "center",
                      gap: "6px",
                      "white-space": "nowrap",
                    }}
                  >
                    <Show when={index > 0}>
                      <span aria-hidden="true" style={{ opacity: 0.4 }}>
                        ·
                      </span>
                    </Show>
                    <span role="img" title={fact.title} aria-label={fact.title} style={{ "font-size": "11px" }}>
                      <span aria-hidden="true" style={{ color: toneHex(fact.tone), "font-weight": 600 }}>
                        {fact.icon ?? factIcon(fact.tone)}
                      </span>{" "}
                      <span style={{ opacity: 0.85 }}>{fact.label}</span>
                    </span>
                  </span>
                ))}
              </div>
            </Show>

            {/* Any dirty state, not only the no-PR `dirty` action: a detached
                worktree needs the same review of what will be stashed. */}
            <Show when={dirty()}>
              <div style={{ display: "grid", gap: "2px" }}>
                <div style={{ opacity: 0.75 }}>
                  {filesHeading()}
                </div>
                {/* One entry per line: `pre` (not `pre-wrap`) keeps the status
                    code attached to its path, and a long path scrolls
                    horizontally instead of wrapping mid-entry. 3 entries max,
                    then a muted count of the rest. */}
                <pre
                  style={{
                    margin: "0",
                    "white-space": "pre",
                    "font-size": "11px",
                    "overflow-x": "auto",
                  }}
                >{files().slice(0, 3).join("\n") || ctx.t("dialog.noFiles")}</pre>
                <Show when={filesMore() > 0}>
                  <div style={{ opacity: 0.6, "font-size": "11px" }}>
                    {ctx.t("dialog.filesMore", { count: String(filesMore()) })}
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={actionResult() !== undefined}>
              <div style={{ "white-space": "pre-wrap", opacity: 0.9 }}>{actionResult()}</div>
            </Show>

            <Show when={error() !== undefined || actionKind() === "error"}>
              <div style={{ "white-space": "pre-wrap", opacity: 0.9 }}>⚠️ {error() ?? failureDetail()}</div>
            </Show>

            {/* Merge state only: the reset runs strictly after an accepted merge.
                While the merge is armed the mode is disabled, so the confirmation
                label and the action that runs can never disagree. */}
            <Show when={actionKind() === "merge"}>
              <ctx.ui.Switch
                checked={mergeReset()}
                onChange={(next) => {
                  // Switching the mode drops an arm: the label the user clicked
                  // no longer describes the flow that would run.
                  disarmMerge()
                  setMergeReset(next)
                }}
                label={ctx.t("dialog.mergeResetAsk")}
                disabled={busy() || mergeArmed()}
              />
            </Show>

            {/* The chosen action's inputs, in this dialog's body beside the
                merge-reset switch above. A PR-creating click offers the title
                (prefilled with the branch) and a description; a branch-creating
                click offers NO field — it queues a prompt that has the agent
                name and create the branch from verified live state. An empty
                field keeps the old automatic behaviour; main validates every
                value, so a bad one is a clear refusal. */}
            <Show when={prCreating()}>
              <ctx.ui.TextInput
                value={titleField()}
                onInput={setTitleField}
                label={ctx.t("dialog.prTitle")}
                placeholder={ctx.t("dialog.prTitlePlaceholder")}
                disabled={busy()}
              />
              <ctx.ui.TextInput
                value={bodyField()}
                onInput={setBodyField}
                label={ctx.t("dialog.prBody")}
                placeholder={ctx.t("dialog.prBodyPlaceholder")}
                disabled={busy()}
              />
            </Show>

            {/* Armed merge: the panel's own warning, shown in the dialog's body
                so an accidental first click cannot merge anything. */}
            <Show when={mergeArmed() && actionKind() === "merge"}>
              <div style={{ opacity: 0.8 }}>{ctx.t("panel.warning")}</div>
            </Show>

            <Show when={actionKind() === undefined && !resolveActive()}>
              <div style={{ display: "flex", "align-items": "center", gap: "6px", opacity: 0.8 }}>
                <ctx.ui.Loader size="small" />
                <span>{ctx.t("panel.checking")}</span>
              </div>
            </Show>
          </div>
        </ctx.ui.Dialog>
      )
    }

    const openDialog = () => {
      const current = session()
      if (current === undefined) return
      const targetDir = current.directory
      ctx.dialogs.open((dialog) => <PrActions dialog={dialog} session={current} targetDir={targetDir} />)
    }

    // The pill's label is the PR state, so the titlebar answers "is this branch
    // open for review?" without opening the panel.
    ctx.add(TitlebarItem, () => {
      const current = session()
      if (current === undefined || current.directory === "") return undefined

      const item = (label: string, title: string, isBusy = false) => ({
        id: "pr",
        icon: "github" as const,
        label,
        title,
        busy: isBusy,
        run: openDialog,
      })

      if (pr.error !== undefined) {
        return item(
          "PR ?",
          chipTitle("Error", `PR status failed: ${message(pr.error).slice(0, MAX_SHORT)}`, current.directory),
          pr.loading,
        )
      }

      const latest = data()
      if (latest === undefined) {
        return item("PR …", chipTitle("Checking", ctx.t("chip.checking"), current.directory), true)
      }

      if (!latest.ok) {
        // No repository is a normal state: the chip stays hidden.
        if (latest.reason === "not-repo") return undefined
        // Detached HEAD is a normal grey state (no branch, no PR). The chip
        // stays neutral, so the label alone must say it.
        if (latest.reason === "detached") {
          const head =
            latest.commit !== undefined ? `detached HEAD at ${latest.commit}` : ctx.t("chip.detached")
          return item(
            "Detached",
            chipTitle("Detached", `${head} · ${current.directory}`, current.directory),
            pr.loading,
          )
        }
        if (latest.reason === "none") {
          const divergence = divergenceFor(current.directory)
          const pushFirst = divergence !== undefined && divergence.noUpstream
          const unpushed = divergence?.ahead ?? 0
          const dirty = divergence?.dirty === true
          // On the base branch itself the dialog this chip opens swaps its
          // primary for branch creation (head == base is the PR gh refuses), and
          // the chip must name the action it is about to lead to. Same
          // fail-closed rule as `onBase()` inside the dialog: an unresolved or
          // empty base is never "on base", and the branch side is the reported
          // one, so a missing branch can never read as a match.
          const baseBranch = divergence?.base
          const onBase =
            baseBranch !== undefined && baseBranch !== "" && baseBranch === latest.branch
          // Every row here is a start action (push, commit+push, or Create PR),
          // so the aria word is always `No PR` and the blue rule applies. The
          // old `Pending` word made push/dirty read as waiting; only the rest
          // text and the label below still rank the dirty tree first and name
          // the unpushed count, because those are content, not colour.
          const pending = pushFirst || unpushed > 0
          const state = "No PR"
          const rest = pending
            ? `${latest.branch ?? "this branch"} · ${
                pushFirst
                  ? ctx.t("dialog.notPushed")
                  : ctx.t("dialog.ahead", { count: String(unpushed) })
              }`
            : latest.branch
              ? `No pull request for ${latest.branch}`
              : ctx.t("chip.noPr")
          if (dirty) {
            // On base the dialog's primary is the stash-backed branch create
            // (`moveToNewBranch`'s handler), not the commit + push the off-base
            // row offers, so the label names that instead.
            return item(
              onBase ? ctx.t("dialog.moveToNewBranch") : ctx.t("chip.commitPush"),
              chipTitle(state, rest, current.directory),
              pr.loading,
            )
          }
          if (pending) {
            const label = pushFirst
              ? ctx.t("chip.pushFirst")
              : ctx.t("chip.unpushed", { count: String(unpushed) })
            return item(label, chipTitle(state, rest, current.directory), pr.loading)
          }
          return item(
            // The chip only opens the dialog (`run: openDialog`); on base that
            // dialog's title is the branch question and its primary is
            // `Create branch from base`, so the chip asks the same thing.
            onBase ? ctx.t("dialog.createBranch") : ctx.t("panel.create"),
            chipTitle(state, rest, current.directory),
            pr.loading,
          )
        }
        if (latest.reason === "cancelled") {
          return item("PR …", chipTitle("Checking", ctx.t("chip.checking"), current.directory), true)
        }
        const detail = latest.error ?? (latest.reason === "timeout" ? ctx.t("panel.timeout") : String(latest.reason))
        return item("PR ?", chipTitle("Error", detail.slice(0, MAX_SHORT), current.directory), pr.loading)
      }

      const tag = latest.number !== undefined ? `#${latest.number}` : ""
      const state = (latest.state ?? "").toUpperCase()
      const tooltip = [latest.branch, latest.url, latest.title]
        .filter((part): part is string => typeof part === "string" && part !== "")
        .join(" · ")

      if (state === "MERGED") {
        return item(
          `Merged ${tag}`.trim(),
          chipTitle("Merged", chipRest(tooltip || ctx.t("chip.merged"), latest), current.directory),
          pr.loading,
        )
      }
      if (state === "CLOSED") {
        return item(
          `PR ${tag} · closed`.trim(),
          chipTitle("Closed", chipRest(tooltip || ctx.t("chip.closed"), latest), current.directory),
          pr.loading,
        )
      }
      return item(
        `PR ${tag} · ${chipLabel(latest)}`.trim(),
        chipTitle(
          chipStateWord(latest),
          chipRest(tooltip || ctx.t("chip.open"), latest),
          current.directory,
        ),
        pr.loading,
      )
    })

    const tab = {
      id: "pr",
      title: ctx.t("panel.title"),
      pinned: true,
      closable: false as const,
    }

    // The base object keeps `panel.title` as the loading fallback; a PR cache
    // keyed by number gives the strip a fresh `PR #NN` object only when the
    // number changes, so labels do not re-render on every unrelated change.
    let tabCache: { number: number; tab: typeof tab } | undefined
    const listedTabs = () => {
      const current = view()
      if (current === undefined || current.number === undefined) return []
      if (tabCache === undefined || tabCache.number !== current.number) {
        tabCache = { number: current.number, tab: { ...tab, title: `PR #${current.number}` } }
      }
      return [tabCache.tab]
    }

    // `usePanel()` throws outside a `Panel.render`, and this scope is plugin
    // `setup`, so the panel's content lives in a component whose own scope can
    // read the frame. Its effect reports `visible` ("Region open and this tab
    // selected") into the poll's cadence signal; the fallback when no frame is
    // available is "visible", which keeps the pre-Tier-B fast cadence instead
    // of losing the panel.
    const PanelBody = () => {
      let frame: ReturnType<typeof usePanel> | undefined
      try {
        frame = usePanel()
      } catch {
        frame = undefined
      }
      if (frame === undefined) {
        setPanelVisible(true)
      } else {
        const visible = frame.visible
        createEffect(() => setPanelVisible(visible()))
        onCleanup(() => setPanelVisible(false))
      }
      // One notice for every state that has no PR to act on. Three shapes, each
      // exactly what the individual branches rendered: a muted line; the
      // muted line + retry button (grid, 4px); the muted line + output
      // disclosure (same grid) when the read captured git/gh output. `text` is
      // reactive, so a changed branch/commit/message repaints without
      // recreating the notice. The shape itself is fixed per instance: every
      // call site passes `retry`/`output` once.
      const PanelNotice = (props: { text: string; retry?: () => void; output?: string }) => {
        if (props.retry === undefined && props.output === undefined) {
          return <div style={{ opacity: 0.7 }}>{props.text}</div>
        }
        return (
          <div style={{ display: "grid", gap: "4px" }}>
            <div style={{ opacity: 0.7 }}>{props.text}</div>
            {props.output !== undefined ? (
              <details>
                <summary style={{ cursor: "pointer", opacity: 0.8 }}>{ctx.t("panel.showOutput")}</summary>
                <pre style={{ margin: "0", "white-space": "pre-wrap", "font-size": "11px" }}>{props.output}</pre>
              </details>
            ) : (
              <ctx.ui.Button size="small" variant="ghost" onClick={props.retry}>
                {ctx.t("panel.retry")}
              </ctx.ui.Button>
            )}
          </div>
        )
      }
      return (
        <ErrorBoundary
          fallback={(err) => {
            console.error("oc-pr-gui: panel render failed", err)
            return (
              <div style={{ padding: "12px", "font-size": "12px", "white-space": "pre-wrap" }}>
                PR panel failed to load — {message(err)}
              </div>
            )
          }}
        >
          <div
            style={{
              display: "grid",
              gap: "8px",
              padding: "12px",
              "font-size": "12px",
              "align-content": "start",
            }}
          >
            <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
              <strong style={{ flex: "1" }}>{ctx.t("panel.title")}</strong>
              <ctx.ui.Button
                size="small"
                variant="ghost"
                disabled={pr.loading}
                onClick={refresh}
              >
                {ctx.t("panel.refresh")}
              </ctx.ui.Button>
            </div>

            <Show when={view()}>
              {(current) => {
                const tone = () => prTone(prFacts(current()))
                return (
                  <div class="oc-pr-gui-banner" data-oc-pr-state={tone()}>
                    <div style={{ display: "flex", gap: "6px", "align-items": "baseline" }}>
                      <strong>PR #{current().number}</strong>
                      <span class="oc-pr-gui-state-word">{toneWord(tone())}</span>
                      <Show when={current().isDraft}>
                        <span style={{ opacity: 0.7 }}>(draft)</span>
                      </Show>
                    </div>
                    <Show when={current().branch !== undefined}>
                      <div style={{ opacity: 0.85 }}>
                        {ctx.t("panel.branch")}: {current().branch}
                      </div>
                    </Show>
                    <div style={{ opacity: 0.85 }}>
                      {ctx.t("panel.checks")}: {checksLabel(current().checks)}
                    </div>
                    <Show when={visibleAutoFixNote() !== undefined}>
                      <div style={{ opacity: 0.85 }}>{visibleAutoFixNote()}</div>
                    </Show>
                    <Show when={current().url !== undefined}>
                      <div style={{ opacity: 0.85, "overflow-wrap": "anywhere" }}>{current().url}</div>
                    </Show>
                  </div>
                )
              }}
            </Show>

            {/* The reaper's last pass, one line for ANY panel state: a merged
                PR is exactly when tidying matters, and the note must survive
                the older view() gate that hides the banner without PR data.
                Skips/truncation are not repeated here; restore commands ride
                on the title so the line stays one line. */}
            <Show when={visibleTidyNote() !== undefined}>
              <div style={{ opacity: 0.85 }} title={tidyRestoreTitle()} aria-label={tidyRestoreTitle()}>
                {visibleTidyNote()}
              </div>
            </Show>

            <Show when={pr.loading}>
              <div style={{ display: "flex", "align-items": "center", gap: "6px", opacity: 0.8 }}>
                <ctx.ui.Loader size="small" />
                <span>{ctx.t("panel.checking")}</span>
              </div>
            </Show>

            <Show when={pr.error !== undefined}>
              <PanelNotice text={message(pr.error)} retry={refresh} />
            </Show>

            <Show when={!pr.loading && data() === undefined && pr.error === undefined}>
              <PanelNotice text={ctx.t("panel.none")} />
            </Show>

            <Show when={failure()}>
              {(failed) => (
                <div style={{ display: "grid", gap: "6px" }}>
                  <Show when={failed().reason === "none"}>
                    <div class="oc-pr-gui-row" data-oc-pr-state="create" style={{ display: "grid", gap: "6px" }}>
                      <div>
                        {ctx.t("panel.noPr", {
                          branch: failed().branch !== undefined ? `\`${failed().branch}\`` : "this branch",
                        })}
                      </div>
                      <Show when={panelCanCreate()}>
                        <ctx.ui.Button
                          class="oc-pr-gui-primary"
                          size="small"
                          onClick={() => openDialog()}
                        >
                          {panelOnBase() ? ctx.t("dialog.createBranch") : ctx.t("panel.create")}
                        </ctx.ui.Button>
                      </Show>
                      <Show when={!panelCanCreate()}>
                        <div style={{ opacity: 0.7 }}>{panelCreateHint()}</div>
                      </Show>
                    </div>
                  </Show>

                  <Show when={failed().reason === "not-repo"}>
                    <PanelNotice text={ctx.t("panel.notRepo")} />
                  </Show>

                  <Show when={failed().reason === "detached"}>
                    <PanelNotice
                      text={
                        failed().commit !== undefined
                          ? ctx.t("panel.detached", { commit: failed().commit ?? "" })
                          : ctx.t("panel.detachedNoCommit")
                      }
                    />
                  </Show>

                  <Show when={failed().reason === "timeout"}>
                    <PanelNotice text={ctx.t("panel.timeout")} retry={refresh} />
                  </Show>

                  <Show when={failed().reason === "error"}>
                    <PanelNotice
                      text={ctx.t("panel.statusError")}
                      output={failed().output || failed().error || "no output"}
                    />
                  </Show>
                </div>
              )}
            </Show>

            <Show when={view()}>
              {(current) => (
                <div style={{ display: "grid", gap: "6px" }}>
                  <div style={{ display: "flex", gap: "6px", "align-items": "baseline" }}>
                    <strong>#{current().number}</strong>
                    <span style={{ flex: "1" }}>{current().title ?? "(no title)"}</span>
                  </div>
                  <div>
                    state: {current().state ?? "unknown"}
                    {current().isDraft ? " (draft)" : ""}
                  </div>
                  <div>
                    mergeable: {current().mergeable ?? "unknown"} /{" "}
                    {current().mergeStateStatus ?? "unknown"}
                  </div>
                  <div>review: {current().reviewDecision || "none"}</div>
                  <div>
                    {ctx.t("panel.checks")}: {current().checks?.length ?? 0}
                  </div>
                  {current().checks !== undefined && current().checks!.length > 0 && (
                    <ul style={{ margin: "0", padding: "0 0 0 16px", display: "grid", gap: "2px" }}>
                      {current().checks!.map((check) => (
                        <li>
                          {check.name}: {check.state}
                        </li>
                      ))}
                    </ul>
                  )}

                  <Show when={panelCanMerge()}>
                    <div
                      class="oc-pr-gui-row"
                      data-oc-pr-state={prTone(prFacts(current()))}
                      style={{ display: "grid", gap: "6px" }}
                    >
                      {!confirming() && (
                        <ctx.ui.Button
                          class="oc-pr-gui-primary"
                          variant="contrast"
                          disabled={busy()}
                          busy={busy()}
                          onClick={() => {
                            setResult(undefined)
                            setConfirming(true)
                          }}
                        >
                          {ctx.t("panel.merge")}
                        </ctx.ui.Button>
                      )}

                      {confirming() && (
                        <div style={{ display: "grid", gap: "6px" }}>
                          <div style={{ opacity: 0.8 }}>{ctx.t("panel.warning")}</div>
                          <div style={{ display: "flex", gap: "6px" }}>
                            <ctx.ui.Button
                              variant="danger"
                              disabled={busy()}
                              busy={busy()}
                              onClick={() => void merge()}
                            >
                              {ctx.t("panel.confirm")}
                            </ctx.ui.Button>
                            <ctx.ui.Button
                              variant="ghost"
                              disabled={busy()}
                              onClick={() => setConfirming(false)}
                            >
                              {ctx.t("panel.cancel")}
                            </ctx.ui.Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </Show>

                  <Show when={panelMergeNote() !== undefined}>
                    <div style={{ opacity: 0.75 }}>{panelMergeNote()}</div>
                  </Show>

                  <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
                    <Show when={ctx.desktop !== undefined && current().url !== undefined}>
                      <ctx.ui.Button
                        size="small"
                        variant="ghost"
                        onClick={() => {
                          const link = current().url
                          if (link !== undefined) ctx.system.openExternal(link)
                        }}
                      >
                        {ctx.t("panel.openInGitHub")}
                      </ctx.ui.Button>
                    </Show>
                    <Show when={(current().state ?? "").toUpperCase() === "OPEN"}>
                      <ctx.ui.Button
                        size="small"
                        variant="ghost"
                        onClick={() => void togglePanelAutoFix()}
                      >
                        {ctx.t("panel.autoFix")}:{" "}
                        {panelAutoFix() ? ctx.t("panel.autoFixOn") : ctx.t("panel.autoFixOff")}
                      </ctx.ui.Button>
                    </Show>
                    {/* The tidy switch is a repository preference, not a
                        property of an OPEN PR: a merged PR is exactly when it
                        matters, so unlike Auto-fix it is not gated on state. */}
                    <ctx.ui.Button
                      size="small"
                      variant="ghost"
                      onClick={() => void togglePanelTidy()}
                    >
                      {ctx.t("panel.tidy")}:{" "}
                      {(panelTidy() ?? false) ? ctx.t("panel.autoFixOn") : ctx.t("panel.autoFixOff")}
                    </ctx.ui.Button>
                  </div>
                </div>
              )}
            </Show>

            <Show when={visibleResult() !== undefined}>
              <pre style={{ margin: "0", "white-space": "pre-wrap", "font-size": "11px" }}>
                {visibleResult()}
              </pre>
            </Show>
          </div>
        </ErrorBoundary>
      )
    }

    ctx.add(Panel, {
      id: "pr",
      region: "side",
      // Reactive: `view()` reads `pr.latest` and the routed session, so the
      // host re-runs this list when either changes. Without a real PR the tab
      // is withdrawn and the titlebar chip carries the Create PR / PR ? state.
      list: listedTabs,
      render: () => <PanelBody />,
      // Cold-directory prefetch (item 10). `focus` runs when this tab becomes
      // selected and `enter` when the side region is opened on it; the host
      // gives TitlebarItem no hover hook, so these are the supported gestures.
      // A hidden directory paints from its snapshot, so `prefetchCold` spends a
      // fetch only when there is nothing to paint. Both paths are guarded, so a
      // restored selection plus an enter event still starts at most one fetch.
      focus: (input) => prefetchCold(input.session.directory),
      enter: (input) => prefetchCold(input.session.directory),
    })
  },

  main(ctx) {
    // Every handler below is a thin wire to ./git. The in-flight dedupe
    // (`readShared`), the generation bump and PR-number invalidation on a
    // mutation (`mutateRead`) and the memos they key on all live there, so the
    // main-process state has exactly one owner and `setup` cannot reach it.
    ctx.provide(PrPanel, {
      status: async ({ directory }) =>
        JSON.stringify(await readShared("status", directory, "", () => readStatus(directory))),
      merge: async ({ directory, number, url, confirm }) =>
        mutateRead(() => mergePr(directory, number, url, confirm)),
      create: async ({ directory, title, base, body }) => mutateRead(() => createPr(directory, title, base, body)),
      ahead: async ({ directory }) =>
        JSON.stringify(await readShared("ahead", directory, "", () => readDivergence(directory))),
      threads: async ({ directory, url, number }) => {
        const repo = repoFromUrl(url)
        if (repo === undefined) return JSON.stringify(null)
        return JSON.stringify(
          await readShared("threads", directory, `${url}\u0000${number}`, () =>
            countReviewThreads(directory, repo.owner, repo.name, number),
          ),
        )
      },
      commitPush: async ({ directory, confirm }) => mutateRead(() => commitAndPush(directory, confirm)),
      push: async ({ directory, confirm }) => mutateRead(() => pushBranch(directory, confirm)),
      autoFix: async ({ directory, enabled }) => autoFixState(directory, enabled),
      // Wave B adds the poll hook, the panel note and the toggle; the bindings
      // exist now so the typed contract compiles and a pass is one IPC away.
      reaper: async ({ directory, enabled }) => reaperState(directory, enabled),
      reap: async ({ directory }) => mutateRead(() => reapBranches(directory)),
      continueWork: async ({ directory, stash, branch }) =>
        JSON.stringify(await mutateRead(() => continueWork(directory, undefined, stash === true, branch))),
      resetWorkspace: async ({ directory, confirm, number }) =>
        mutateRead(() => resetWorkspace(directory, confirm, undefined, number)),
    })
  },
})
