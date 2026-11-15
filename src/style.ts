// The plugin’s visual vocabulary: the approved state palette and the single
// Style sheet gui.tsx registers with `ctx.add(Style, PR_STYLE)`. Moved out of
// gui.tsx so the CSS can be evaluated and asserted without Solid, Solid’s JSX
// transform or the plugin host. Both values are window-side data: the sheet is
// a template literal and the palette is a frozen-looking (as const) map, so
// neither touches child_process.
//
// `index.ts` lists this file in GUI_SOURCES so editing it still warns that
// dist/gui-experimental.cjs is stale.


// Palette from the approved state table, contrast-audited on dark surfaces
// (≥4.5:1 for text, ≥3:1 for bars). Hues are unchanged; lightness is raised so
// tone-coloured words, borders and the chip stay legible. Every selector is
// scoped under an attribute only this plugin writes, so it cannot restyle app UI.
//
// Approved semantic vocabulary — the meaning decides the colour, never the
// state's name or its position in the precedence table:
//   red      #F87171  hard/structural issues that must be resolved.
//                     Conflicts is the only member.
//   redSoft  #FCA5A5  actionable issues: failing checks and open review items.
//   amber    #FBBF24  waiting on someone/something: pending checks, Checking,
//                     review-pending (REVIEW_REQUIRED). Nothing actionable is
//                     amber.
//   green    #4ADE80  completion: all-green checks, and the Merge primary.
//   blue     #60A5FA  start something: Create PR, push, dirty/commit+push, and
//                     the `± Changes` fact.
//   grey     #9CA3AF  nothing to start from: Detached, status Error, Closed,
//                     Unknown.
//   purple   #A78BFA  ready to sign off: Merged — the state where the Sign off
//                     action lives.
// Red vs redSoft is a two-tier severity, not a hue accident: `red` is reserved
// for structural blockers the merge cannot survive (conflicts must be resolved
// in the tree), while `redSoft` marks actionable work on an otherwise-shapeable
// PR (failing checks, unresolved review threads). Amber never carries either
// tier — if the user can act, it is not amber.
//
// The titlebar chip, the panel banner and the confirm's tone-filled primary all
// read the same per-state hex, so a repo state never shows two different
// colours across those three surfaces. One documented exception: while Resolve
// Review Items owns the filled slot it is drawn in redSoft regardless of repo
// state (the review backlog is its own state), so in that row the primary
// intentionally does not match the titlebar chip. The chip's own Review items
// state is redSoft too, so the chip word and the filled Resolve button agree.
// The confirm's fact chips are per-fact (checks, review, conflicts), not
// per-state: several of these tones can legitimately appear side by side.
// One name per hex: `neutral` is the only name for #9CA3AF. The hexless
// unfilled-primary case is `none` (bare class), so a tone name never maps to
// two different colours and no two names share a hex.
export const PALETTE = {
  blue: "#60A5FA",
  amber: "#FBBF24",
  green: "#4ADE80",
  redSoft: "#FCA5A5",
  red: "#F87171",
  purple: "#A78BFA",
  neutral: "#9CA3AF",
} as const

export const PR_STYLE = `
[data-oc-pr-state] { --oc-pr-gui-tone: ${PALETTE.neutral}; }
[data-oc-pr-state="create"] { --oc-pr-gui-tone: ${PALETTE.blue}; }
[data-oc-pr-state="pending"] { --oc-pr-gui-tone: ${PALETTE.amber}; }
[data-oc-pr-state="green"] { --oc-pr-gui-tone: ${PALETTE.green}; }
[data-oc-pr-state="failing"] { --oc-pr-gui-tone: ${PALETTE.redSoft}; }
[data-oc-pr-state="review"] { --oc-pr-gui-tone: ${PALETTE.redSoft}; }
[data-oc-pr-state="conflicts"] { --oc-pr-gui-tone: ${PALETTE.red}; }
[data-oc-pr-state="unknown"] { --oc-pr-gui-tone: ${PALETTE.neutral}; }
[data-oc-pr-state="merged"] { --oc-pr-gui-tone: ${PALETTE.purple}; }
[data-oc-pr-state="closed"] { --oc-pr-gui-tone: ${PALETTE.neutral}; }
[data-oc-pr-state="error"] { --oc-pr-gui-tone: ${PALETTE.neutral}; }

[data-oc-pr-state].oc-pr-gui-banner {
  display: grid;
  gap: 3px;
  padding: 8px;
  border: 1px solid color-mix(in srgb, var(--oc-pr-gui-tone) 45%, transparent);
  border-left: 4px solid var(--oc-pr-gui-tone);
  border-radius: 6px;
  background: color-mix(in srgb, var(--oc-pr-gui-tone) 10%, transparent);
}
[data-oc-pr-state].oc-pr-gui-banner .oc-pr-gui-state-word {
  color: var(--oc-pr-gui-tone);
  font-weight: 600;
}
[data-oc-pr-state].oc-pr-gui-row {
  border-left: 3px solid var(--oc-pr-gui-tone);
  padding-left: 8px;
}
[data-oc-pr-state].oc-pr-gui-row .oc-pr-gui-state-word,
[data-oc-pr-state].oc-pr-gui-row .oc-pr-gui-primary {
  color: var(--oc-pr-gui-tone);
}
[data-oc-pr-state].oc-pr-gui-row .oc-pr-gui-primary {
  border-color: var(--oc-pr-gui-tone);
}

/* Chip colour per state. Every chip title starts with this plugin's
   "PR · <State> · " namespace, so the built-in update pill (localized label)
   cannot match even though it shares the titlebar-update slot. The namespace
   attribute selector is (0,2,1) and beats the host base rule (0,1,1). */
[data-slot="titlebar-update"] > button[aria-label^="PR · No PR"] {
  color: #60A5FA;
  background-color: color-mix(in srgb, #60A5FA 18%, transparent);
}
[data-slot="titlebar-update"] > button[aria-label^="PR · No PR"] [data-slot="titlebar-update-label"] {
  color: #60A5FA;
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Pending"] {
  color: #FBBF24;
  background-color: color-mix(in srgb, #FBBF24 18%, transparent);
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Pending"] [data-slot="titlebar-update-label"] {
  color: #FBBF24;
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Open"] {
  color: #4ADE80;
  background-color: color-mix(in srgb, #4ADE80 18%, transparent);
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Open"] [data-slot="titlebar-update-label"] {
  color: #4ADE80;
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Failing"] {
  color: #FCA5A5;
  background-color: color-mix(in srgb, #FCA5A5 18%, transparent);
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Failing"] [data-slot="titlebar-update-label"] {
  color: #FCA5A5;
}
/* Unresolved review threads on an open PR: redSoft, the same tier as Failing,
   because it is actionable work the user must do — not waiting on CI or a
   reviewer, which is what amber means. Matches the filled Resolve Review Items
   primary in the confirm. */
[data-slot="titlebar-update"] > button[aria-label^="PR · Review items"] {
  color: #FCA5A5;
  background-color: color-mix(in srgb, #FCA5A5 18%, transparent);
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Review items"] [data-slot="titlebar-update-label"] {
  color: #FCA5A5;
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Conflicts"] {
  color: #F87171;
  background-color: color-mix(in srgb, #F87171 18%, transparent);
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Conflicts"] [data-slot="titlebar-update-label"] {
  color: #F87171;
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Unknown"] {
  color: #9CA3AF;
  background-color: color-mix(in srgb, #9CA3AF 18%, transparent);
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Unknown"] [data-slot="titlebar-update-label"] {
  color: #9CA3AF;
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Merged"] {
  color: #A78BFA;
  background-color: color-mix(in srgb, #A78BFA 18%, transparent);
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Merged"] [data-slot="titlebar-update-label"] {
  color: #A78BFA;
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Closed"] {
  color: #9CA3AF;
  background-color: color-mix(in srgb, #9CA3AF 18%, transparent);
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Closed"] [data-slot="titlebar-update-label"] {
  color: #9CA3AF;
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Error"] {
  color: #9CA3AF;
  background-color: color-mix(in srgb, #9CA3AF 18%, transparent);
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Error"] [data-slot="titlebar-update-label"] {
  color: #9CA3AF;
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Detached"] {
  color: #9CA3AF;
  background-color: color-mix(in srgb, #9CA3AF 18%, transparent);
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Detached"] [data-slot="titlebar-update-label"] {
  color: #9CA3AF;
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Checking"] {
  color: #FBBF24;
  background-color: color-mix(in srgb, #FBBF24 18%, transparent);
}
[data-slot="titlebar-update"] > button[aria-label^="PR · Checking"] [data-slot="titlebar-update-label"] {
  color: #FBBF24;
}

/* The confirm's primary is tone-filled: one class per approved tone, scoped to
   this plugin's own class so no host button is restyled, plus the shared
   "oc-pr-gui-tone" marker that carries what every tone needs.
   #0B0B0C is a neutral contrast token (dark ink on light tone fills),
   deliberately not one of the 7 approved brand hexes.

   Every primary is variant="contrast", and the host fills that variant with
   background-image: an opaque gradient stack over
   --v2-background-bg-contrast (#242424 in dark). background-image always
   paints above "background-color", so a tone that only sets a background
   colour renders as the host's dark contrast fill, whatever the specificity.
   The shared rule below clears the host gradient, its white text-shadow and
   its elevation ring; each tone rule restates the approved fill. The
   [data-component="button-v2"] prefix gives (0,3,0) against the host rest
   rule (0,2,0); the hover rule adds :hover:not(:disabled) for (0,5,0)
   against the host hover rule (0,4,0), so the tone wins in either source
   order and hover follows the tone rather than the host's overlay. */
[data-component="button-v2"].oc-pr-gui-primary.oc-pr-gui-tone {
  background-image: none;
  text-shadow: none;
  box-shadow: none;
}
[data-component="button-v2"].oc-pr-gui-primary.oc-pr-gui-tone-green {
  --oc-pr-gui-primary-tone: #4ADE80;
  background-color: #4ADE80;
  border-color: #4ADE80;
  color: #0B0B0C;
}
[data-component="button-v2"].oc-pr-gui-primary.oc-pr-gui-tone-redSoft {
  --oc-pr-gui-primary-tone: #FCA5A5;
  background-color: #FCA5A5;
  border-color: #FCA5A5;
  color: #0B0B0C;
}
[data-component="button-v2"].oc-pr-gui-primary.oc-pr-gui-tone-red {
  --oc-pr-gui-primary-tone: #F87171;
  background-color: #F87171;
  border-color: #F87171;
  color: #0B0B0C;
}
[data-component="button-v2"].oc-pr-gui-primary.oc-pr-gui-tone-blue {
  --oc-pr-gui-primary-tone: #60A5FA;
  background-color: #60A5FA;
  border-color: #60A5FA;
  color: #0B0B0C;
}
[data-component="button-v2"].oc-pr-gui-primary.oc-pr-gui-tone-amber {
  --oc-pr-gui-primary-tone: #FBBF24;
  background-color: #FBBF24;
  border-color: #FBBF24;
  color: #0B0B0C;
}
[data-component="button-v2"].oc-pr-gui-primary.oc-pr-gui-tone-purple {
  --oc-pr-gui-primary-tone: #A78BFA;
  background-color: #A78BFA;
  border-color: #A78BFA;
  color: #0B0B0C;
}
/* One hover for every tone: the fill lightens the tone by 12% instead of
   stacking the host's contrast overlay on top, so the button stays the same
   hue at rest and under the pointer. The #9CA3AF fallback only covers the
   bare oc-pr-gui-primary class, which carries no tone. */
[data-component="button-v2"].oc-pr-gui-primary.oc-pr-gui-tone:hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--oc-pr-gui-primary-tone, #9CA3AF) 88%, #FFFFFF);
  border-color: color-mix(in srgb, var(--oc-pr-gui-primary-tone, #9CA3AF) 88%, #FFFFFF);
  background-image: none;
}
/* The host's disabled button is also a flat grey fill, so the neutral tone
   needs a second cue. The inset ink ring uses the same documented #0B0B0C ink
   token as the fill text, and the shared hover brightens the fill slightly, so
   this stays visibly enabled while keeping the #9CA3AF titlebar-match fill.
   Declared after the shared rule so its ring survives the box-shadow: none. */
[data-component="button-v2"].oc-pr-gui-primary.oc-pr-gui-tone-neutral {
  --oc-pr-gui-primary-tone: #9CA3AF;
  background-color: #9CA3AF;
  border-color: #9CA3AF;
  color: #0B0B0C;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #0B0B0C 40%, transparent);
}

/* Secondary dialog actions stay outlined so the primary is the only filled
   button. Same variant="ghost" base (height/padding come from the host's
   data-size rule), plus a 1px neutral hairline; border-box keeps the box from
   growing. Neutral #9CA3AF is an approved palette hex. */
.oc-pr-gui-secondary {
  box-sizing: border-box;
  background-color: transparent;
  border: 1px solid color-mix(in srgb, #9CA3AF 55%, transparent);
  color: inherit;
}
[data-component="button-v2"].oc-pr-gui-secondary:hover:not(:disabled) {
  border-color: color-mix(in srgb, #9CA3AF 80%, transparent);
}

/* Cancel carries the same hairline in the approved red (#F87171), so dismissal
   reads as a caution without becoming the filled primary. Same construction as
   the secondary: ghost base (host height/padding/hover) + border-box hairline.
   The mix is 68% because 55% composites to rgb(144,69,69) over #101010, which
   is only 2.83:1 (below 3:1); 68% composites to rgb(174,82,82) = 3.74:1.
   Hover raises it to 85% (rgb(213,98,98) = 5.21:1). */
.oc-pr-gui-cancel {
  box-sizing: border-box;
  background-color: transparent;
  border: 1px solid color-mix(in srgb, #F87171 68%, transparent);
  color: inherit;
}
[data-component="button-v2"].oc-pr-gui-cancel:hover:not(:disabled) {
  border-color: color-mix(in srgb, #F87171 85%, transparent);
}

/* The meta line doubles as the GitHub affordance when the PR has a URL: no
   underline ever, opacity carries the hover, and the span keeps an honest focus
   ring because it is a role="link" element. */
.oc-pr-gui-meta-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  text-decoration: none;
  border-radius: 4px;
  opacity: 0.8;
}
.oc-pr-gui-meta-link:hover {
  opacity: 1;
}
.oc-pr-gui-meta-link:focus-visible {
  outline: 2px solid color-mix(in srgb, #60A5FA 70%, transparent);
  outline-offset: 2px;
}
`
