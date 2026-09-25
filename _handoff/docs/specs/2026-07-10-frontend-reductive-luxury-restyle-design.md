# Frontend "Reductive Luxury" Restyle — Design

**Date:** 2026-07-10
**Scope:** Visual restyle + an "experiential layer" (motion, interaction
states, progressive-disclosure decluttering). No routing, data-flow, or
ops/state-machinery changes; no API changes.
**Constraint:** The inspiring automotive brand must never be named in code, comments, commits, or docs. Refer to the direction as "reductive luxury" / "modern luxury".

## Goal

Restyle the entire SvelteKit frontend around a reductive modern-luxury design
language: calm near-black surfaces, platinum neutrals with a subtle warm-sage
undertone, one restrained sage-green accent, hairline borders, generous
spacing discipline, light-weight display headings, and wide-tracked uppercase
micro-labels — plus an experiential layer that makes the app *feel* that way:
quiet fast motion, consistent interaction states, refined loading/empty
states, and progressive-disclosure decluttering. Integrate the provided
brand assets: full logo on the login
page, icon-only logo replacing the "Data Rover" header text, favicon +
`<title>` (currently absent entirely).

Design-language principles (from the researched philosophy): reduction —
remove clutter rather than add ornament; proportion → balance → surface →
detail, in that order; material simplicity (metal, monochrome, one accent);
understatement over loudness. No gradients-for-effect, no glows, no
skeuomorphism.

## Current state (findings)

- Tailwind CSS v4 + shadcn-svelte, dark-locked (`<html class="dark">`), 115
  `.svelte` files, zero scoped `<style>` blocks — all styling is utility
  classes.
- The shadcn semantic token layer in `frontend/src/app.css` exists but is
  achromatic-default and mostly bypassed: ~61 components hardcode `zinc-*`
  (~697 uses), `ring-indigo-500` focus rings, and literal `red`/`amber`/
  `emerald`/`sky` state colors. Only the `ui/` primitives (+~a dozen files)
  use semantic tokens.
- Branding is the text "Data Rover" in `AppHeader.svelte:23` and
  `TopBar.svelte:112`. `app.html` has no `<title>`, no favicon. Logo PNGs
  (`static/dr_full.png`, `static/dr_small.png`) are unused, untracked, have
  opaque black backgrounds and large padding, and are accompanied by WSL
  `Zone.Identifier` litter files.
- Font: Inter Variable only.

## Design

### 1. Design tokens (`frontend/src/app.css`)

Rewrite the token set (dark values are the product; keep the `:root` light
block structurally valid but do not invest in it — the app stays dark-locked):

- **Neutrals:** graphite/platinum OKLCH scale with a faint sage undertone
  (hue ≈ 150, chroma ≈ 0.002–0.008): `--background` deep charcoal
  (~`oklch(0.14 0.004 150)`), `--card`/`--popover` slightly raised,
  `--foreground` platinum (~`oklch(0.96 0.005 150)`), `--muted-foreground`
  mid-platinum.
- **Accent:** `--primary`, `--ring`, `--accent` become muted sage green
  (~`oklch(0.72 0.045 150)` family, matched by eye to the logo's "R").
  Indigo is removed everywhere.
- **New status tokens** exposed as Tailwind colors via the `@theme inline`
  block: `--success` (restrained green), `--warning` (desaturated amber),
  `--info` (muted steel-blue) — so components stop hardcoding
  `emerald`/`amber`/`sky`. `--destructive` stays red but desaturated for
  dark surfaces.
- **Borders:** hairlines — white at ~8% (`--border`), ~12% for emphasized.
- **Radius:** `--radius: 0.5rem` (from 0.625rem) for a crisper, machined
  feel.
- `body` override in `app.css` switches from literal zinc values to
  `background`/`foreground` tokens.

### 2. Typography

- Keep **Inter Variable** for all UI/data text.
- Add **Outfit Variable** (`@fontsource-variable/outfit`) as
  `--font-display` in the `@theme` block. Used at light weights (300–400)
  for: login lockup, page titles, dialog/drawer titles, empty-state
  headings.
- Micro-label idiom for section/panel headers: uppercase, `text-[11px]` (or
  10px where dense), `tracking-[0.15em]`–`[0.2em]`, `text-muted-foreground`.
- No other font additions. One `npm install` for the fontsource package is
  the only dependency change.

### 3. Brand assets

- A one-off script (scratchpad; not committed) derives web assets from the
  provided PNGs using Pillow/ImageMagick:
  - Trim padding; attempt background transparency by flood-filling the
    uniform black background from the corners (letterforms are lighter).
    **Fallback if keying artifacts appear:** keep opaque and present the
    logo inside deliberate pure-black "plinth" containers (fits the
    aesthetic).
  - Outputs in `frontend/static/`: `favicon.png` (48px or multi-size),
    `apple-touch-icon.png` (180px), `dr-mark.png` (small trimmed icon,
    ~2× of 28px display size), `dr-lockup.png` (full logo, ~2× of ~360px
    display width). Originals stay.
- `frontend/src/app.html`: add `<title>Data Rover</title>`, favicon +
  apple-touch links, `theme-color` meta matching `--background`.
- `AppHeader.svelte` + `TopBar.svelte`: replace the "Data Rover" text with
  the icon mark `<img>` (same clickable element, `aria-label="Data Rover"`,
  fixed height ~24–28px). No behaviour change to the click handler.
- Login page (`routes/login/+page.svelte` + `auth/LoginForm.svelte`): full
  lockup centered above the form; near-black stage; hairline-bordered form
  card; generous vertical rhythm. Purely visual restructuring of classes
  (and minimal wrapper markup if needed) — same form fields, ids, submit
  behaviour.
- Delete `frontend/static/*.Zone.Identifier`; commit original +
  derived assets.

### 4. Component migration (~61 files)

Mechanical sweep, then hand-polish:

- **Sweep mapping:** `zinc-*` → semantic equivalents (`background`, `card`,
  `muted`, `border`, `foreground`, `muted-foreground`, opacity-modified
  where zinc used alpha); `ring-indigo-*`/`border-indigo-*` → `ring`
  /`primary`; `emerald-*` → `success`; `amber-*`/`yellow-*` → `warning`;
  `sky-*`/`blue-*` → `info`; `red-*` → `destructive` (keeping intent —
  e.g. `bg-red-950/60 text-red-300` → token + alpha equivalents).
- **Hand-polish pass** (visual only) on marquee surfaces: project picker
  cards, TopBar (hairline separators, uppercase group labels), Sidebar tree
  + search, Inspector property forms, StatusBar, ResultsPanel, dialogs/
  drawers (Diff, History, SwapMetamodel, Settings, ApplyCr, LoadFiles,
  AdvancedSearch), CommandPalette, ProgressOverlay, admin tabs, compare
  view, Navigation builder chips/cards.
- **`GraphView.svelte`**: colors likely live in script (canvas/SVG
  constants), not classes — restyle those constants to palette-matched hex
  values (script constants can't read CSS vars without behaviour-adjacent
  plumbing; hardcoded hex matched to the tokens is acceptable there, with a
  comment tying them to the palette).
- **Invariants:** no event-handler logic changes, no store/data-flow
  changes, no ops-engine or routing changes. Markup may change only for
  brand elements, transition wrappers, and the progressive-disclosure
  regroupings described in §5.

### 5. Experiential layer (motion, states, decluttering)

The philosophy applied to how the app *feels*: calm, effortless, unhurried
— but never slow.

- **Motion system.** Define motion tokens in `app.css` (durations ~120ms
  micro / ~200ms panel; a single standard ease-out curve). Use built-in
  `svelte/transition` (fade/fly/slide) — no new animation dependency:
  - Dialogs/drawers: quiet fade + short slide (Diff/History/SwapMetamodel
    drawers, all dialogs, CommandPalette).
  - Sidebar tree expand/collapse and panel show/hide (ResultsPanel):
    short slide.
  - Hover/focus/active on interactive elements: CSS transitions on
    color/border only (no transform "bounce").
  - **`prefers-reduced-motion` respected globally** (disable/zero
    transitions under the media query).
- **Interaction states.** Consistent hover (surface lift via
  border/background token step, not shadows/glows), visible sage focus
  rings everywhere keyboard focus can land, calm pressed states.
- **Loading & empty states.** ProgressOverlay restyled to a quiet
  centered lockup + thin progress line; empty states get display-font
  headings with one-line guidance instead of bare "no items" text.
- **Progressive disclosure (declutter).** Secondary/rare actions fold into
  overflow menus so primary surfaces stay reductive — chiefly the TopBar:
  keep the primary actions visible (Commit, Undo, Validate, change
  counter), fold the rest (Export, Load Files, Swap Metamodel, Apply CR,
  Compare, History, Settings) into a single "…" dropdown-menu. Same
  handlers, same dialogs — only where the buttons live changes.
- **Keyboard affordance.** Surface the command palette (⌘K) with a subtle
  hint in the TopBar/AppHeader so the fastest path is discoverable.
- **Not touched:** routing, stores/data flow, the ops protocol, focus/DOM
  structure that tests or a11y depend on beyond the regroupings above.

### 6. Verification

- `pixi run -e frontend bash -c 'cd frontend && npm run check'` (svelte-check)
  stays green.
- `pixi run -e frontend bash -c 'cd frontend && npm test'` (vitest) stays
  green; if a test asserts on an old literal class — or on a TopBar action
  that moved into the overflow menu — update the selector/interaction in
  the test to match, changing nothing else.
- `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'`
  (playwright, boots its own backend) for the TopBar regrouping and
  login-page changes.
- Live visual pass: dev server + backend, screenshot login, project picker,
  admin, editor (all panels open), dialogs/drawers, compare view. Fix
  anything that reads as broken contrast or lost affordance.
- `pixi run tidy` for the frontend prettier/eslint pass.

## Out of scope

- Light theme / theme toggle (app stays dark-locked).
- Routing, stores/data flow, the ops/commit/locking protocol, API changes.
- Layout-mechanics rework (the resizable grid stays as-is).
- Information-architecture redesign beyond the TopBar overflow-menu
  regrouping described in §5.
- New animation/motion dependencies (built-in `svelte/transition` + CSS
  only).
