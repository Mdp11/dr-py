# Navigation builder UI refactor — design spec

Date: 2026-07-09 · Branch: `feat/stage1-navigation` · Status: approved by user (via interactive mock)

## Why

User feedback on the current builder (`frontend/src/lib/components/Navigation/`):

- Six unlabeled `+` links per card (`+ relationship step`, `+ filter step`, `+ insert
  navigation`, `+ group`, `+ from library`, `+ condition`) with no hint of what they do.
- Combination structure is illegible: bare operator `<select>`, flat operand rows with
  truncated auto-labels, nesting shown only by thin borders.
- Cryptic controls: the unlabeled `▸` preview toggle; the naked `step [n]` number input
  (`step_index`) whose purpose — which chain column an operand feeds into the combination —
  is invisible; set-op jargon.
- Preview tables nested inside cards inside cards overwhelm the layout.

**The approved redesign lives in the interactive mock next to this spec:**
`2026-07-09-navigation-builder-mock.html` — open it in a browser (e.g.
`python3 -m http.server` in the specs dir). It is the authoritative visual reference;
where this spec and the mock disagree on cosmetics, the mock wins. The mock is a static
HTML/JS sketch — its DOM/CSS is NOT to be copied literally; re-express it in Svelte 5 +
Tailwind using the app's existing idioms.

## Core design idea: the chain rail

A path evaluates to CHAINS with numbered columns: the start is column 0, each relationship
hop adds one, filter steps add none. The SAME circled-number badge appears in three places
so the concept teaches itself:

1. **Editor rail** — every path renders as numbered sentence rows connected by a vertical
   rail line: `⓪ Start from …`, `① Follow …`, `② Follow …`. Filter rows show a `·` ghost
   badge (no number) and read `Keep only …`, hanging under the hop they refine.
2. **Results table headers** — `⓪ Start | ① SystemContainsComponent | ② DependsOn`,
   mirroring the rail exactly.
3. **The "→ feeds" chip** (replaces the `step [n]` input) — appears ONLY on path operands
   inside a combination and reads `→ feeds ⟨②⟩ last step`. Its popover:
   "Feed the combination with the elements reached at…" then one option per column:
   `⓪ the start (SoftwareSystem)`, `① after SystemContainsComponent (Component)`,
   `⟨last⟩ the last step (default)`. Picking writes `step_index` (null = last, 0 = start,
   k = column k). Combination operands get NO chip — the header notes
   "contributes its members — no steps to feed" (matches the backend rule: `step_index`
   other than 0/null is rejected for set operands).

Badges are styled circles containing plain digits (mono font) — NOT unicode circled glyphs
(⓪①② render as tofu in some fonts).

## Layout

The navigation tab becomes three zones (see mock):

```
┌ topbar: name input · dirty dot · Save · Save as… ────────────┐
│ editor (scrolls): the definition tree as cards               │
│═ results dock (bottom, ~40% height): ═════════════════════════│
│ RESULTS · [node picker ▾] · "auto-runs as you edit · ✓ N"    │
│ chains table with numbered column headers · Load more        │
└───────────────────────────────────────────────────────────────┘
```

- Topbar: keep current Save/Save as/conflict-banner/saveError behavior verbatim
  (NavigationBuilder.svelte logic), restyled per mock.
- Dock: reuse the app's `ResizeHandle` for the split if that is cheap; otherwise a fixed
  55/45 split is acceptable for this iteration.

## Editor pieces

### Path card
- Header: auto-letter title (`Path A`, `Path B`, … by depth-first operand order; a bare
  root path is just `Path`), then a live status chip (see Status chips), then — only when
  the card is an operand — the feeds chip and a `↑ ↓ ✕` toolbar (move/remove operand).
- Rail rows (sentence verbs, controls keep the existing pickers/StereotypePicker
  components underneath):
  - `⓪ Start from [all matching|one element|a combination] ⟨types pill⟩ + condition`
    — the three options map to the existing scope/element/combine start modes.
  - `① Follow ⟨relationship pill⟩ [outgoing|incoming|either] to ⟨target types pill⟩ ✕`
  - `· Keep only ⟨criteria pills⟩ + condition ✕` (filter step; ghost badge, no number)
- Unset pills render dashed + muted: `pick a relationship…`, `any type`, `any element`.
- Below the rail, two labeled buttons (dashed borders): `+ Follow a relationship` and
  `+ Keep only…` (replace the two `+ … step` links; no menu — one click each).
- `Options` expander (collapsed by default) holding the `Exclude visited elements`
  checkbox with its existing tooltip.

### Combination frame
- Indigo-accented frame: mono uppercase eyebrow `COMBINATION`, operator select with
  plain-language labels:
  - `Union — keeps elements found in ANY part`
  - `Intersection — keeps elements found in EVERY part`
  - `Difference — first part minus all the others`
  - `Symmetric difference — in exactly one part`
- Between consecutive parts, a dashed divider carrying the glyph + word: `∪ union`,
  `∩ intersection`, `− minus`, `⊕ symmetric difference`. With Difference selected, the
  first part's header shows an amber `base` badge.
- Parts are: path cards, compact library-ref cards, or nested combination frames
  (recursive; background tint deepens one notch per nesting level). A nested combination
  used as a part gets the parent-operand toolbar (`↑ ↓ ✕`) in its own header.
- Bottom: one `+ Add another part ▾` menu (dropdown via the existing
  `$lib/components/ui/dropdown-menu`), items with title + description:
  - `A new path` — "An empty path — build it with Start / Follow / Keep only"
  - `A saved navigation…` — "Pick one from the library; it stays linked, not copied"
    (opens the existing library search picker)
  - `A nested combination` — "A combination inside this one, with its own operator"
- On a BARE path (root or operand), the same three actions live under a
  `Combine with… ▾` menu whose items state the auto-wrap outcome
  ("Turns this into a Union of this path + a new empty one", …). The wrap uses the
  existing `insertNavigationEdit`/`insertGroupEdit`/`insertRefEdit` structural edits —
  commit f8e5b78's expansion-follows-node remap MUST keep working.

### Library-ref card
Compact single row: `⧉ ⟨artifact name⟩  saved navigation  ⟨status chip⟩ … → feeds chip ·
open ↗ · ↑ ↓ ✕`. `open ↗` opens the artifact's own tab (existing openNavigationTab).
Not editable inline. Its feeds popover shows only "the last step (default)" (column count
of a ref is unknown client-side without fetching; keep it simple).

### Status chips (per card, always live)
- `✓ N chains` (green, mono) when the node's last auto-run succeeded.
- `incomplete — pick a start or add a step` (muted italic) when `!isRunnable(node)`.
- `⚠ failed` (red) when the eval-error flag is set.
- While an evaluate is in flight: `…` or a subtle spinner; do not blank the chip.

## Selection & results dock

- Exactly ONE selected node per tab; default = root. Clicking a card (not its inner
  controls) selects it; the card gets a sky ring. The dock's node picker mirrors the tree
  (indented entries: `Path A`, `Path B`, `⧉ Sensors network`, nested paths further
  indented, `Whole combination`) and is the second way to select.
- Dock header status: `auto-runs as you edit · ✓ N chains` / `· evaluating…` /
  `· waiting for a runnable path` / error line
  `Evaluation failed — edit the definition to retry`.
- Dock body: the selected node's chains table (existing element pills, click = select in
  model inspector via `select({kind:'element', id})`), column headers with rail badges;
  `Load more` (existing loadMorePreview paging). For a combination node the single column
  header is `Combined elements` with the muted note `(union of the parts' fed steps)`
  worded per operator.
- Empty states are directive: fresh draft → "Pick what to start from — results appear
  here automatically as you build."; incomplete path → "Nothing to run yet — pick what
  ⟨Path B⟩ starts from, or add a step. Results appear here automatically."

### Store mapping (`frontend/src/lib/state/navigation-editor.svelte.ts`)
Keep the auto-run machinery (debounce, generations, applyStructuralEdit remap, rekeyTab
rescheduling — ALL of commit f8e5b78) intact. Changes:

- Add per-tab selection: `getSelectedPath(tabId)`, `selectNode(tabId, path)` (a
  `SvelteMap<tabId, pathKey>`; default `''` = root). `applyStructuralEdit` must remap the
  selection through `edit.remapPath` exactly like expanded keys (a removed selected node
  falls back to root). `closeDraft`/`reloadDraft`/reset clear it; `rekeyTab` carries it.
- The user-facing collapse/expand toggle disappears. Instead, every RENDERED card node is
  kept "expanded" in store terms so its count chip stays live: the card components
  register their node path on mount and unregister on unmount (a small
  `registerVisibleNode(tabId, path)` / `unregister…` pair over the existing `_expanded`
  set is sufficient — reuse the existing per-node preview/auto-run plumbing untouched).
  `toggleExpanded` can be removed or kept as the internal primitive; do not leave a dead
  export surface.
- NOTE / accepted cost: an edit re-runs every visible node (typically 1–6 evaluate calls,
  debounced). Fine for this iteration; rerunning only the affected subtree is a possible
  later optimization, out of scope.

### Pure helpers (`frontend/src/lib/navigation/tree.ts`)
Add (unit-tested):
- `chainColumns(node: PathNavigation): {index: number; label: string; sub?: string}[]` —
  the rail/table/feeds numbering: index 0 labeled from the start (type names, element, or
  "combination"), one entry per relationship step labeled by its relationship type with
  `sub` = target types. Single source of truth for all three badge sites.
- `operandTitles(root)` or an equivalent for the `Path A/B/…` lettering + dock picker
  tree (depth-first, refs use artifact names resolved by the caller).

## Components (target file layout)

- `NavigationBuilder.svelte` — topbar + editor scroll + `ResultsDock` (split).
- `NavigationNode.svelte` — kind dispatch (path card / combination frame / ref card),
  now also carrying operand chrome props (index, isOperand, parent path).
- `PathCard.svelte` (replaces `PathLeafEditor.svelte`) — header, rail, add buttons,
  Options; uses reworked `RelationshipStepRow`/`FilterStepRow`/`ScopeEditor`/
  `ElementStartPicker` (sentence layout, same pickers).
- `CombineFrame.svelte` (replaces `CombineEditor.svelte`) — eyebrow, operator select,
  dividers, parts, add-part menu.
- `RefCard.svelte` (new) — the compact library-ref row.
- `FeedsChip.svelte` (new) — chip + popover, props from `chainColumns`.
- `ResultsDock.svelte` (new, replaces `ChainPreview.svelte`) — picker, status, table.
- Delete `ChainPreview.svelte` when nothing imports it.

Styling: Tailwind utilities in the app's existing dark idiom (zinc-950/900/800/700 bases,
`text-xs`, sky-500 actions, emerald save, indigo-400 combination accents, amber `base`
badge, red errors, `font-mono` for badges/pills/counts). No new CSS files, no new deps.

## Testing requirements

- Unit (vitest): `chainColumns` + lettering helpers; selection store behavior incl.
  structural-edit remap of the selection and rekeyTab carry-over; feeds chip writes
  `step_index` correctly (null/0/k); status-chip states; ResultsDock rendering states
  (chains / incomplete / failed / empty). All 67 existing navigation tests must pass,
  reworked only where they encode the old toggle UX (e.g. `toggleExpanded` tests become
  visible-node-registration tests with the same staleness/cancellation assertions —
  the invariants they pin must survive, not the API names).
- e2e (`frontend/e2e/navigation.spec.ts`): rewrite the build flow for the new selectors —
  build a path via `+ Follow a relationship` / `+ Keep only…`, `Combine with… → a new
  path`, select nodes via cards and the dock picker, assert dock results + status chips,
  set a feeds value, Difference `base` badge, Save / Save as… / reopen round-trip
  (keep the fixture facts documented in the current spec file's comments).
- Gates: `pixi run -e frontend bash -c 'cd frontend && npm test'`,
  `… npm run check`, `… npm run test:e2e` all green. `npm run lint` has two PRE-EXISTING
  prettier failures on main (`ProjectCard.test.ts`, `UsersTab.test.ts`) — do not fix, do
  not add new ones (run prettier on files you touch).

## Out of scope

- Any backend/schema change (`step_index`, evaluation, artifacts API stay as-is).
- Per-subtree re-run optimization; persisting selection; ref column introspection.
- The other workspace tabs, sidebar, and the search UI.

## Invariants that must survive (from commit f8e5b78 — read it first)

- Structural mutations go through `applyStructuralEdit` and its `remapPath`; per-node
  state (previews, generations, timers, selection) follows NODES, not positions.
- `rekeyTab` reschedules pending debounced runs and re-issues in-flight ones after the
  first-save tab rebind; no stuck `loading` previews, no silently swallowed runs.
- Auto-run remains debounced (400 ms), generation-guarded, fire-and-forget with the
  eval-error flag as the only failure surface.
