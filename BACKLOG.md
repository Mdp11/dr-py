# Backlog

The single durable record of everything known-but-not-done in this repo: leftovers,
future phases, diagnosed bugs, cleanups, test gaps, and ideas.

**Why this file exists.** Until now this knowledge lived in session handoff notes under
`~/.claude/handoffs/` and in SDD ledgers under `.superpowers/sdd/` — both outside the
repo, both gitignored, both routinely deleted when a plan completes. Items were being
carried forward by hand and silently dropped. This file is tracked by git, so nothing
here is lost to a `git clean` or a finished session.

**How to use it.**
- Every item has a stable ID (`B-1`, `F-3`, …). Reference IDs in commits and plans.
- **Status** is one of: `open`, `in progress`, `done` (keep done items for one release,
  then delete), `won't do` (with the reason).
- **Deferred by decision** (§10) is different from a backlog item: those were explicitly
  declined by the project owner. Re-ask before starting one — don't treat them as
  free work.
- When you fix something, delete the item or mark it `done` in the same commit.

**Provenance and staleness.** Items come from three places, and the ID letter tells you
which: session handoffs dated 2026-08-06 → 2026-08-12 plus the SDD review ledgers
(`B`/`F`/`K`/`C`/`T`/`O` — diagnosed by an agent session, usually with file:line);
the owner's own running notes (`P` features, `U` bug reports — observed while using the
app, **not yet reproduced or diagnosed** unless a note says otherwise); and the master
spec's phase table (`R`). Anything older than the last few sessions is **unverified
against current code** — confirm before acting on it. Line numbers drift; treat them as
hints.

Last updated: 2026-08-28 · repo head at time of writing: `feat/table-ux-batch` on top of `main` at `0d3337b` (U-10 table columns UX batch, C-17)
(model-compare-apply-cr merged). The 2026-08-18 additions were a batch of owner notes: P-10
gained five concrete sub-items, P-15 → P-21 and U-9 are new, and T-1 was retired as stale
while verifying them. The 2026-08-19 additions are two more owner notes: P-22 (top bar
reorder + Model dropdown, a P-10 follow-up) and P-23 (Apply CR against the loaded model,
staged not committed, multiple CRs). A same-day pass on `feat/exporter-v2-phase1` (Exporter
v2 Phase 1) closes P-15.2, P-15.3, F-10, F-11 and C-10, leaves P-15.1 open (scheduled for
Exporter v2 Phase 3), and marks P-16 in progress. The 2026-08-20 metamodel-navigation pass
on `feat/metamodel-navigation` closes P-17 and P-18, and also ships the two owner-requested
navigation features (search autocomplete, collapsible panel) recorded in the same day's
spec. A follow-up pass on `feat/exporter-v2-phase2` (Exporter v2 Phase 2) ships two more
export formats — CSV and JSON Lines, joining xlsx/JSON on both `POST /tables/export` and
`POST /exports/run` — plus per-entry `json_doc` document shaping (array/object shape with
a data-derived key column, pretty-print, on-error strictness); Phases 3–5 (the real
add-table picker, draft/uncommitted export, the `transform` hook, bundle-draft export)
remain open, see P-15.1/P-16. A follow-up pass on `feat/exporter-v2-phase3` (Exporter v2
Phase 3) ships the automation surface: draft exporter runs (`RunExportIn.definition`),
`GET /exports/run-by-name` for CI, the P-15.1 add-table picker (`AddTablePicker.svelte`),
an ungated Export button (dirty/uncommitted drafts run inline), and the F-16 fix (Save no
longer blocks on a bad split template) — closing P-15.1, the exporter half of P-16, and F-16.
A follow-up pass on `feat/exporter-v2-phase4` (Exporter v2 Phase 4) ships the
`transform(doc)` snippet hook on both export surfaces (`ExporterEntry.transform` and
`TableDefinition.transform`, spec §8) plus the entries cap fix below; Phase 5 (bundle-draft
export) remains open and needs re-confirmation from the owner before starting. The 2026-08-25
pass on `feat/model-compare-apply-cr` closes P-23 — Compare and Apply CR became one
server-proposes/client-stages pipeline — and adds K-19 and O-3, both noticed while finishing it.
The 2026-08-26 UX pass on `fix/ux-minor-batch` closes U-3, U-6, U-9, F-14, F-17 and K-3's
pluralization bullet, and retires U-5 as already shipped. The 2026-08-26 pass on
`perf/deferred-search-index` closes K-20 and adds K-21 → K-25 as the large-model
performance program (see K-6, now first in that program).
The 2026-08-26 pass on `perf/compressed-snapshots` closes K-21 (gzip'd compact snapshots,
bytes-sniffing reader; see its entry for the numbers).
The 2026-08-27 pass on `perf/uniqueness-position-index` closes K-22 (the maintained
`IndexSet.element_order`; see its entry for the numbers).
The 2026-08-27 pass on `perf/property-write-hot-path` closes K-23 (the per-property search-index
diff and cold-element ownership; see its entry for the numbers).
The 2026-08-27 pass on `perf/untyped-navigation-scope` closes K-24 (the untyped scope walks
`model.elements` in insertion order; see its entry for the numbers).
The 2026-08-27 pass on `feat/script-column-inputs` (merged at `4d95d1c`) closes the **table**
half of P-1 — named script-column inputs, `value(elements, inputs)` — leaves its navigation
`parents` half open, and adds K-26 → K-28 and C-16 → C-19 from its final review.

---

## 0. Where the project stands

Phases 1–6 of the master roadmap (`docs/superpowers/specs/2026-06-16-multi-user-collaborative-architecture-design.md` §12)
are shipped, plus live metamodel editing and the artefacts revamp (phases 1–3). The
most recent work is **Phase 7 (scoped): Redis lock mirroring** — merged at `a510171`.

| Phase | State |
|---|---|
| 1. Session registry | shipped |
| 2. Tenancy + auth seam | shipped (+ local cookie auth, admin console) |
| 3. Durable persistence | shipped (commit journal + GCS snapshots) |
| 4. Check-out/commit + locking | shipped |
| 5. Realtime feed | shipped |
| 6. Metamodel-driven UX | shipped (+ live YAML metamodel editing) |
| **7. HA / horizontal scale** | **partial — lease mirroring only (see R-1)** |
| **8. History & revert** | **not started (see R-2)** |

Test baseline on `main`: `core-test` 1811 passed / 30 deselected · `frontend-test`
2049 passed (213 files) · `dr-tidy` clean. (Measured on `29727af`, 2026-08-14; the
opt-in Redis integration suite was not re-run.)

Test baseline on the metamodel commit-flow branch (final task, 2026-08-16): `dr-tidy`
clean (ruff reformatted 5 pre-existing backend files this branch's own diff never
touched — formatting only, no logic change); `core-test` 1835 passed / 30 deselected
(1 flake, `test_projects_wizard.py`, see T-4); `frontend-test` 2078 passed (216
files); `frontend-test-e2e` 41/41 passed on a clean run (one earlier run hit a single
"invalid session" failure in `helpers/load.ts`, likely the same e2e auth/session
flake family T-4 already tracks — passed in isolation and on the clean full-suite
rerun).

---

## 1. Roadmap — named future phases

### R-1 · Phase 7 proper: HA / horizontal scale · `open`
Only the **lease mirror** sub-piece shipped. The full phase is Redis **ownership
leases + affinity routing + graceful handoff**, so a second backend instance can be
added. The mirror was deliberately built not to obstruct this: `LockTable` remains the
sole conflict authority and the `LeaseMirror` seam is two methods (`write`/`load`) with
no acquire/release vocabulary, so ownership leases extend it rather than fight it.
Source: master spec §12; 2026-08-11 design doc. Size: large.

### R-2 · Phase 8: history & revert · `open`
Commit-history browser, revert-to-commit, optional strict mode. Known blockers already in
the code: `/commits/revert` answers 409 across any range containing **artifact ops**, and
likewise across any range containing **`metamodel.*` ops** (both `metamodel.rebind` and
`metamodel.move_node` — extended by the metamodel commit-flow feature, spec 2026-08-16,
from "metamodel rebind ranges" to the whole op family). `POST /model/undo` also 409s with
push-back specifically on a rebind-carrying batch (layout-only `move_node` undo IS
supported) — see that spec's "Amendments" section for the rationale: restore-mode model
inverses are schema-checked at the core mutation boundary, so no single replay order is
valid on both sides of a schema swap without teaching the core a schema-independent restore
mode (deferred, not designed away — the journal already carries the full-state rebind-back
inverse a future phase would need to lift the 409). Also folds in F-9 (HistoryDrawer
consuming `GET /commits/{rev}/diff`), which has been parked three times.
Source: master spec §12; handoffs 2026-08-09 → 2026-08-11; 2026-08-16 metamodel commit-flow
design. Size: large.

---

## 2. Feature backlog — owner-requested

From the owner's running notes, merged 2026-08-12. These are **wanted**, not scheduled:
unscoped, unestimated, and most need a brainstorm or a spec before they're actionable.
Where the codebase already contains part of the answer, the item says so — several of
these are smaller than they look, and two turned out to be already shipped (see the end
of this section).

**2026-08-19:** the `custom_export` artifact kind is now `exporter` (Exporter v2 Phase 1,
end-to-end backend + frontend rename); items below still say `custom_export`/"custom
export" where that was the shipped name at the time and are unedited beyond the specific
sub-items closed in this pass.

### P-1 · Additional inputs for `value` / `step` entry points · `in progress` · design-heavy
Today both entry points receive only the element(s) they act on. Wanted:
- **`value` (navigation)** → `parents`: this element's ancestor chain up to the
  navigation root, **root at index 0**.
- **`step` (table)** → `row`: a dict of column *name* → value for the current row.

The owner already flagged the hard part: a `row` that exposes columns computed **from
this column** is circular. The definition layer already solved this once — `ColumnRef` is
**backward-only** — so restricting `row` to columns defined before this one is probably
the simplest rule and reuses existing machinery. Two other surfaces move with it:
`core/script/lint.derive_entry_points` derives signatures server-side (arity change), and
a wider input widens each cell's read-set, so `core/script/cell_cache.py` keying and
`api/invalidation.touched_keys` need a look or invalidation goes wrong.

**Table half shipped** (2026-08-27, `feat/script-column-inputs`, merged at `4d95d1c`) as
*explicit named inputs*, not a whole-row dict: `ScriptColumn.inputs: [{name, ref: ColumnRef}]`
(backward-only, exactly the rule predicted above — the referenced column must be to the left,
any column kind is legal, `step_index` keeps its meaning) and the snippet is called as
`value(elements, inputs)` with `inputs: dict[str, list]`. `core/table/script_inputs.py`
resolves each input per row to what that cell holds and is the ONE `value()` call site
(`evaluate_script_column`); the resolved values are a fourth cell-key component
(`inputs_digest`, `""` without inputs, so pre-existing keys and the one-arg call are
byte-identical), which is why invalidation needed nothing new; a pending/errored input yields
an uncached pending/error cell (`input '<name>': …`), never `[]`; the sweep resolves inputs
live at serial enumeration. Whole-row visibility, keyword-argument calling, best-effort `[]`,
inputs on navigation `ScriptStep`, cross-table inputs and wave-scheduling the sweep were all
decided against (spec §8). Two spec-text errors noted by the final review, code is right: §3.2's
"type tags" are unnecessary (canonical JSON already separates `1`/`1.0`/`"1"`/`true`), and §3.1's
"exactly what the cell holds" should say inputs are *uncapped* (display caps don't apply).

**Still open — the navigation half**: `step` (navigation) → `parents`, this element's
ancestor chain up to the navigation root, root at index 0. Not designed yet.

### P-2 · Table search with per-column include/exclude · `open`
Search UI gains the ability to restrict which columns are searched.

### P-3 · Review mode: show artefact impact of an edit · `open`
For each new/edited element, also show every artefact (table, navigation) whose output
changes because of it. Owner explicitly accepts that this mode may take its time to load.
**Likely cheaper than it sounds:** cells already carry per-call read-sets, and
`api/invalidation.touched_keys` + `ScriptCellCache.evict_touched` already answer exactly
"which computed cells does this change touch" — that's the same question, asked forward.

### P-4 · Generalize artefacts · `open`
Snippet / navigation / table should share a common property set so future kinds inherit
it. `api/artifact_kinds.py` (`ArtifactKindSpec`) is the registry seam this would extend;
the work is in the payload/metadata shape, not the registry.

### P-5 · Artefact diff, and artefacts in change requests · `open`
`GET /commits/{rev}/diff` renders artifact ops **journal-only** today — no before/after
reconstruction like model entities get (`api/commit_diff.py`). Full artefact diff folds
into R-2; inclusion in change requests is additional work on top.

### P-6 · `dr.view.*` in the snippet facade · `open` · design-heavy
Add/move/remove elements in views from snippet code, staged as op proposals.
**The prerequisite is already done:** the ten-op `view.*` family shipped in artefacts
revamp Phase 2, so the view is no longer snapshot-replace-only (that caveat in the
original note is stale). What remains is the facade API surface plus a deliberate
decision about guest proposals — `/snippets/run` currently **rejects** the `view.*`
family from guest-proposed ops on purpose, so relaxing it is a security call, not a
plumbing change.

### P-7 · Diagrams · `open` · no detail captured
Needs a brainstorm from scratch. Note that `diagram` / `diagram_kind` already exist as
**deliberately unregistered** artifact kinds that 422 on write — the names are reserved,
nothing behind them.

### P-8 · Multiple views, loadable and selectable live · `open` · **supersedes a prior decision**
Users can add views; a control lists available views and selects one. This was previously
**scoped out** ("multiple named views", artefacts revamp spec non-goals) — this note
supersedes that. Schema impact: `ViewRow` is 1:1 with `Project` today, and `view_rev` is
per-project, so this is a data-model change, not just UI.

### P-9 · Metamodel visualization and editing from the frontend · `done` (2026-08-13, feat/metamodel-diagram-editor)
Shipped as a second surface on the existing metamodel tab: an editable UML class
diagram (xyflow canvas + form panel) over the same YAML draft, with comment-preserving
writeback (`frontend/src/lib/metamodel/yaml-edit.ts`), elkjs auto-arrange, and shared
node positions behind `GET/PUT /metamodel/layout` (`metamodel_layouts`, Alembic `0010`).
Layout is presentation — no `mm` lease, no commit journal entry, last-write-wins, and
gated at `role != viewer` rather than owner. Spec:
`docs/superpowers/specs/2026-08-13-metamodel-diagram-editor-design.md`; architecture
notes in `frontend/README.md` ("Live metamodel editing" → "The diagram surface") and
`CLAUDE.md`. **e2e coverage is still missing — see T-7.**

### P-10 · Top bar restructure · `done` (2026-08-18, `feat/top-bar-restructure`) — all five sub-items shipped: the fixed Detail/Graph workspace tabs are deleted, Issues is now a closable singleton workspace tab opened from the top bar (with U-1's filter, below), the overflow menu emptied into eight flat top-bar controls (Artifacts · Issues · Compare · Apply CR · Edit Metamodel · Export · History · Settings), the command palette is deleted, and the per-artifact export button moved into each artifact editor's own toolbar.

### P-11 · Derived properties · `open` · design-heavy
Properties attached to a stereotype whose value is **computed** from a navigation or a
snippet rather than stored and directly editable. Touches four layers: metamodel schema
(a new property flavour), validation (a derived property must not be facet/multiplicity
checked as if it were stored input), the inspector (render read-only, show provenance),
and script evaluation + the cell cache (same invalidation question as P-1).

### P-12 · Custom advanced validation rules · `done` (2026-08-24, `feat/validation-rules`)
User-defined rules outside the metamodel, with arbitrary cross-element conditions
("if x has y, then z must have k"). Landed as a declarative YAML rule language
(`core/validation/rules/`), evaluated natively as a seventh validator that the
API-layer seam adds on top of core's six built-in defaults — not Python-snippet
rules, which would have needed a second async evaluation subsystem (sweep,
read-set capture, rev-stamped caching) and an eventual-consistency validation
UI. Storage is the `validation_rules` artifact kind (verbatim YAML text,
comments survive); `api/rules.py` is the one seam that builds rules-aware
pipelines and widens dirty scopes, cached on `Session.compiled_rules` and
rebuilt at hydration, on a rules-artifact-touching commit, and on metamodel
rebind. As designed, rule issues are always CONFORMANCE (never block a
commit) and a rule that drifts from the metamodel is skipped whole at
compile and surfaced via `rules_status`, never as an ownerless issue.
`POST /rules/lint` gives the editor a debounced, always-200 lint call.
Architecture notes: `CLAUDE.md` ("Custom validation rules"),
`frontend/README.md` ("Rules editor"). Source:
`docs/superpowers/specs/2026-08-24-custom-validation-rules-design.md`.

**Deliberately deferred (spec §11), not designed:** `else` branches (today's
workaround is two rules with mirrored guards); rules on relationship types;
property tests on the relationship itself inside a relationship atom;
value-vs-value joins (comparing two navigated values against each other); a
snippet-backed rule kind (Python escape hatch, priced separately if the
declarative wall is ever hit); per-element severity override/muting;
STRUCTURAL user rules (permanently out, by decision). **e2e coverage joins
T-7.**

### P-13 · JSON export: one file per base element, with a name template · `done` (2026-08-14)
Landed as `json_split`: `core/table/split.py` groups rows by the leading `RowKey` slot
and renders each group through the existing `render_json`, zipped up behind
`POST /tables/export`, with the strict `${name}` name template (collision/unsafe-char
handling included). (`POST /exports/run` is P-14's custom-export-artifact runner, a
separate route that also zips — see below.)

Today `POST /tables/export` returns **one** JSON document for the whole table
(`routes/tables.py:815`, `filename = f"{name}.json"`). Wanted: when a column is expanded
and `json_export.group` rolls those rows back into an array, also be able to emit **one
file per base element of the scope** instead of one combined file.

The filename is a user-supplied template where `${name}` is replaced by that element's
name — e.g. `DataFor${name}Element` with an element named `service_enable` yields
`DataForservice_enableElement`.

The split axis already exists: for a `scope` (or navigation) row source `base_slots` is
1, so the leading `RowKey` slot **is** the base element — group rows by that slot and each
group renders through the existing `render_json` unchanged. Four things to decide:
- **Delivery.** Multiple files over one HTTP response means a zip (new media type +
  `Content-Disposition`), or N requests. The 202/`Retry-After: 1` completeness probe in
  front of export applies either way and shouldn't be duplicated.
- **Name collisions.** Element names are not unique. Two elements sharing a name produce
  one filename — de-duplicate (suffix), or fall back to the id.
- **Unsafe characters.** Element names can contain `/`, `:`, etc. Needs the same kind of
  sanitizing `_sheet_title` already does for xlsx sheet names.
- **A template with no `${name}`** collapses every file onto one name — reject it, or
  auto-suffix.

Where it lives: `core/table/json_export.py` is pure and already the single renderer, so
the split belongs just above it — the route groups, the renderer stays per-document.
Presentation-only, so it must respect the **RENDER ONLY** rule in `export_layout.py`:
row order, cell values and every script cache key stay computed from the original
definition.

### P-14 · New artefact kind: custom export · `done` (2026-08-14)
Landed as the `custom_export` artefact kind: `core/table/custom_export.py` (per-entry
override model), engine `api/table_export_engine.py`, and `POST /exports/run` — a named
collection of table exports with their own layout overrides, registered in
`api/artifact_kinds.py` with its table refs under the standard `"ref"` key so the
registry's generic `extract_deps`/`rewrite_refs` walk carries it through bundle
import/export unchanged.

A user-defined export artefact: a named **collection of table exports** whose export
settings live **in the artefact**, leaving each table's own standalone export settings
untouched. So one artefact can say "export tables A, B, C, each with *these* columns,
*these* names, *this* layout" without any of it leaking back into how A, B and C export on
their own.

This fits the existing seams unusually well, which is worth knowing before the brainstorm:
`ArtifactKindSpec` in `api/artifact_kinds.py` is the registration point;
`ColumnExportOptions` / `export_order` already isolate export presentation from table
structure, and `export_definition` already **restates** a table's definition for rendering
without mutating it — which is exactly the override mechanism this artefact needs, applied
from a different source. `extract_deps`/`rewrite_refs` on the kind spec would let a custom
export travel through the artifact bundle with its table references intact.

Open questions for the brainstorm: whether the artefact stores full override sets or
sparse patches over each table's settings; what happens when a referenced table's columns
change underneath it (P-4's generalization is adjacent); whether output is a zip and how
that composes with P-13's per-element splitting; and whether it can reference navigations
or only tables.

### P-15 · Custom export: picker, file name and folder paths · `done` (2026-08-21, feat/exporter-v2-phase3) — all three sub-items shipped: the searchable add-table picker (.1), the per-artefact output filename template (.2, feat/exporter-v2-phase1), and the per-entry zip folder path (.3, feat/exporter-v2-phase1). Follows P-14.
Three follow-ups on the shipped `custom_export` artefact (owner notes, 2026-08-18).
Independent of each other: .1 is frontend-only, .2 and .3 touch the wire schema and
`POST /exports/run`.

**P-15.1 · A real add-table picker.** `done` (2026-08-21, feat/exporter-v2-phase3).
Landed as `Export/AddTablePicker.svelte`: a client-side searchable combobox (same ARIA
pattern as `Sidebar/Search.svelte`, no debounce since candidates are already in memory)
replacing the bare `<select>` that used to live at `Export/ExporterTab.svelte:393-407`
(renamed from `CustomExportTab.svelte` in the rename sweep). **F-11** (already resolved,
see below) lived in the same file's `usedRefs` filter, which forbade the duplicate
entries the server explicitly supports — that part was already settled, and the new
picker stays deliberately unfiltered against already-added entries per the same note.

**P-15.2 · Override the exported file name.** `done` (2026-08-19, feat/exporter-v2-phase1).
Landed as `ExporterDefinition.output.filename`, a per-artefact template rendered through
`core/table/naming.py`'s engine (`NAME_TOKENS`), defaulting to today's behaviour when unset.

**P-15.3 · A folder path per entry inside the zip.** `done` (2026-08-19, feat/exporter-v2-phase1).
Landed as `ExporterEntry.folder`: a per-segment-sanitized, `..`/absolute-rejecting template
path (the zip-slip guard rail this item called out), with `_dedupe` now deduping *within*
each folder — keyed on the full member path — rather than globally, exactly as specced.

### P-16 · Export artefacts without committing · `in progress`
Design settled in `docs/superpowers/specs/2026-08-19-custom-export-v2-design.md` §9.1
(exporter half: draft runs / run-by-name on `POST /exports/run`) and §10 (bundle-draft
export half, phased last); lands in Exporter v2 Phases 3/5.

**Exporter half (§9.1) `done` (2026-08-21, feat/exporter-v2-phase3).** `RunExportIn` now
takes exactly one of `artifact_id`/`definition` (422 otherwise) so a dirty or
never-committed draft runs inline through `POST /exports/run`; `GET
/exports/run-by-name?name=` runs a committed exporter by name for CI (404 unknown, 409 with
candidate ids on ambiguity); both share `_execute_export`. The frontend's Export button is
now ungated on the picker side too — see P-15.1. The bundle-draft export half (§10) remains
open, scheduled for Phase 5 (see the Phase 3 changelog note below: Phase 5 needs
re-confirmation before starting).

Original note (2026-08-18), now scoped to the bundle half only — the exporter half it
also described is resolved above. Both a custom export run (owner item 8.3) and an
ordinary artefact **bundle** export (item 10) should work against **staged, uncommitted**
state. At the time, neither could: both read committed `ArtifactRow`s on the request's
DB transaction, so an artefact that had never been committed could not be exported at
all, and an edited one silently exported its last committed version — the worse of the
two failure modes. For the bundle half this remains a design question rather than a
patch: either the export routes learn to accept a client-supplied draft payload (and
then must not trust it any more than any other client input — see how
`importer.trust_artifacts` splits its two callers), or the client renders locally. Decide
it alongside Phase 5, since "a bundle export whose entries are still drafts" is exactly
the case that prompted the note.

### P-17 · Metamodel diagram: unbounded zoom-out with a level-of-detail mode · `done` (2026-08-20, feat/metamodel-navigation)
On a big metamodel the canvas cannot be zoomed out far enough to see everything, and it
should be able to — however small it gets. **Confirmed cause:**
`Metamodel/MetamodelDiagram.svelte:373` renders `<SvelteFlow>` with no `minZoom`, so
xyflow's default floor of `0.5` applies. Lowering/removing that floor is a one-prop fix
and is worth doing regardless of the rest.

The owner's preferred design goes further: past a zoom threshold, stop drawing full node
detail and render each block as **just the stereotype name** plus its relationships, then
show the hovered block's or arrow's name in a **tooltip near the cursor**. That is a
render-mode switch inside the custom node/edge components keyed off the live viewport
zoom, and it shares hit-testing and label lookup with **P-18** — build the two together.

Shipped: minZoom 0.05, LOD name-only render below zoom 0.4 (hysteresis to 0.5) with a
cursor tooltip; spec docs/superpowers/specs/2026-08-20-metamodel-navigation-at-scale-design.md.

### P-18 · Metamodel diagram: hover highlighting · `done` (2026-08-20, feat/metamodel-navigation)
Hovering a block highlights the block **and every arrow starting or ending on it**;
hovering a relationship highlights that arrow **and the blocks at both of its ends**.
Pure canvas presentation — no YAML write, no `mm` lease, no commit — so it stays inside
`Metamodel/MetamodelDiagram.svelte` and the components under `Metamodel/diagram/`. The
adjacency it needs is a by-product of work already done: `diagram-build.ts` derives every
edge's endpoints from `rel.mappings` (never the `source`/`target` shorthand), so a
block → arrows index falls out of the build rather than needing new derivation. Pairs with
P-17.

Shipped: hover lights the neighborhood (gens included) and dims the rest; adjacency
derived per diagram build in frontend/src/lib/metamodel/diagram-adjacency.ts. The branch's
final review deferred eleven refinements across all four navigation features — one roll-up
entry, **F-15**.

### P-19 · Collapsible sidebar sections · `open`
The **Tree** panel should collapse: `Sidebar/ContainmentTree.svelte:1285` is a plain
`<h2 class="microlabel">Tree</h2>` with no toggle. When a view is in place, the view tree
and the not-in-view element pool should collapse too — the **"Not in view" pool already
does** (`poolCollapsed`, persisted at `ui.treePoolCollapsed`, default collapsed, `:1437`),
so half the request may already be satisfied and the rest has a local pattern to copy
(`Sidebar/StagedSection.svelte:134-147` is a second example of the same header-button
idiom). One caveat worth carrying over from the pool: collapsing is wired into paging
(`sectionCollapsed` gates the fetch at `:645-651`), so a new collapse toggle on the tree
proper has to decide whether it also stops the tree's own auto-load.

### P-20 · "Staged elements" becomes a structured, collapsible Staging area · `open`
`Sidebar/StagedSection.svelte` renders one flat **"Staged elements"** list (`:145`).
Wanted:

- renamed **Staging area**;
- a subsection **Elements**, and a subsection **Artefacts** with one child section per
  artefact kind — tables, navigations, snippets, custom exports — **including the
  metamodel**;
- every section **collapsible**, and rendered **only when it has at least one child**:
  edit only elements and the panel shows only Elements; edit only tables and it shows only
  Artefacts → Tables.

Mostly a presentation refactor over selectors that already exist and already split this
way — `DiffDrawer.svelte:80-113` derives exactly these families for the commit dialog
(`getStagedDiff`, `getStagedArtifactEntries`, `getStagedViewEntries`,
`getStagedMetamodelDepth` + `getStagedNodeMoves`), and `artifacts/kinds.ts` (C-6) is the
per-kind label/icon source. Two things to decide: whether staged **view** ops become a
fifth section (the owner's list doesn't name them, but they are a staged family and F-3
was exactly the bug of forgetting them), and whether the commit dialog should render the
same component so the two section lists cannot drift.

### P-21 · More reticulating splines · `open` · no detail captured
Verbatim from the owner's 2026-08-18 notes; no surface, scope or acceptance criterion was
given, and I did not invent one. Filed so it isn't lost — needs a sentence from the owner
before it can be sized.

### P-22 · Top bar reorder: "Metamodel" first, a "Model" dropdown · `done` (2026-08-19)
Shipped: "Edit Metamodel" renamed to **Metamodel** and moved first; **Compare, Export
and History** collapsed into a **Model** dropdown (inline `DropdownMenu` in
`TopBar.svelte`, mirroring the Artifacts menu, trigger testid `model-menu-trigger`)
with items History · Compare · Export (Export stays gated on a loaded model, now at the
item level). Final order: **Metamodel · Issues · Artifacts · Apply CR · Model ·
Settings** — pinned by an order test in `TopBar.test.ts`. The three e2e call sites that
clicked the flat History/Export buttons (`smoke`, `history`, `artifact-commit` specs)
now go through the menu. Superseded by P-23 on 2026-08-25: Apply CR moved into the Model
dropdown too, so the order is now **Metamodel · Issues · Artifacts · Model · Settings**.

### P-23 · Apply CR against the loaded model, staged not committed, multiple CRs · `done` (2026-08-25)
Shipped as one feature with Compare's new **Replace** / **Create CR** (either direction):
`POST /model/apply-cr` is a dry-run proposal over an ordered `crs` list (sequential, 409
names the failing index), `POST /model/compare` diffs the session against an uploaded
model, create ops carry an `id` hint so file ids survive staging, and one
`ModelChangeDialog` (Model menu → Compare… / Apply CR…) previews and stages through
`stageProposedOps`. The old compare page and file→file apply are gone. Spec:
`docs/superpowers/specs/2026-08-25-model-compare-apply-cr-design.md`.

### Already shipped — from the notes, no action needed
- **Artefact leases** ("extend the Phase 4 lease mechanism so users can lock artifacts"):
  done end-to-end. `art:<id>` leases in `api/locking.py`, lock-verified through
  `POST /commits`, honored by every other writer, and driven by the frontend checkout
  layer (`state/checkout.svelte.ts`, `state/artifacts.svelte.ts`). Folder leases
  (`folder:<id>`) too.
- **Artefact serialization / export / import between projects**: done as artefacts revamp
  Phase 3 — `api/artifact_bundle.py` (`datarover.artifact-bundle/v1`), the four
  `/artifacts/{export,export/preview,import/plan,import}` routes, the TopBar Artifacts
  menu, and bundle support in the New Project wizard.

If either of those is missing something you wanted, it's a **gap in a shipped feature** —
worth filing as a specific `U`-item rather than re-running the phase.

---

## 3. From the Redis lock-mirroring phase (2026-08-12)

### B-1 · The app never configures logging, so `logger.info` is invisible · `done` (2026-08-12, fix/lease-mirror-hardening)
Neither `basicConfig` nor `dictConfig` is called anywhere in `src/data_rover/`. Python
falls back to `logging.lastResort`, which emits **WARNING and above only**. All three
`logger.info` calls in the codebase are therefore silently dropped in a normal backend
run — verified empirically against a live backend on 2026-08-12.

Two of those three are the lease mirror's operator-facing signals:
- `lock_mirror.restore_leases` — "restored N mirrored lease(s)" (never seen, even though
  restoration demonstrably worked)
- `lock_mirror_redis._mark_up` — "lease mirror: Redis recovered"

Net effect: an operator sees the mirror go **down** (that one is `logger.warning`, and it
does surface) but never sees it come back, and never gets confirmation that leases
survived a restart. Behaviour is correct; the signal is swallowed.

Fix: configure logging once at app startup (uvicorn's `log_config`, or a `dictConfig` in
`main.py`) so `data_rover.*` emits INFO. Pre-existing app-wide gap, not introduced by the
mirror — but the mirror is what made it matter.

### B-2 · `to_leases` doesn't clamp restored lease lifetime against clock jumps · `done` (2026-08-12, fix/lease-mirror-hardening)
`lock_mirror.to_leases` computes `remaining = expires_at_epoch - wall_now` with no
ceiling. A backward NTP correction between mirror-write and restore yields a restored
lease living longer than `lock_ttl_seconds`; a forward jump silently drops live leases.
Parked during the final review because `to_leases` is a pure function and clamping would
give it a settings dependency — do it in `restore_leases` instead, where settings are
already reachable. Damage is bounded and self-heals at TTL.

### B-3 · Concurrent write-throughs can leave a phantom lease in the mirror · `done` (2026-08-12, fix/lease-mirror-hardening)
Two write-throughs on one project can land out of order (acquire on r1 snapshots
`{r1,r2}`; release of r2 snapshots `{r1}`; the first write lands last), leaving the mirror
holding a lease truth no longer has. No Redis outage required. The renew-heartbeat
convergence argument does **not** cover this direction — nobody heartbeats a released
lease. If the process restarts inside that window, a phantom exclusive lease is restored
and blocks a peer for up to `lock_ttl_seconds` (300s), with no in-app escape hatch (the
frontend hardcodes `steal: false`).

Currently **documented honestly** in the `lock_mirror` docstrings rather than fixed. The
cheap real fix: serialize snapshot+write per session with a dedicated mirror lock
(NOT `write_mutex`), which eliminates reordering entirely at negligible cost given
mutation frequency — and would let the module docstring drop the "may briefly lag" caveat.

### B-4 · `dr:leases:{project_id}` has no deployment namespace · `done` (2026-08-12, fix/lease-mirror-hardening)
Two backends pointed at one Redis DB will clobber each other's lease sets and
cross-restore phantom leases for same-named projects (e.g. `default`). Documented in the
`redis_url` setting docstring as an operational caveat; a key prefix setting would remove
the footgun. Relevant to R-1.

---

## 4. Reported by the owner — observed in use, not yet diagnosed

From the owner's notes, merged 2026-08-12. Unlike §5/§6, these were **seen while using
the app**: the symptom is trustworthy, the cause is not established. Reproduce before
fixing. Where I confirmed a cause against the code, the item says **confirmed** and names
the line.

### U-1 · Issues tab has no per-category filter or summary · `done` (2026-08-18, `feat/top-bar-restructure`) — issues now carry a `check` (producing-validator identity), and `IssuesPanel.svelte` (now the closable top-bar-opened Issues tab, P-10.2) renders a per-validator chip filter with counts alongside the existing origin filter.

### U-2 · xlsx autofit stops at a ceiling · `done` (2026-08-12)
The `AUTOFIT_MAX_PX = 300` constant became the `xlsx_autofit_max_px` setting
(`DATA_ROVER_XLSX_AUTOFIT_MAX_PX`) with the default raised to **600px** (~86 chars;
Excel's hard cap is 1790). Read per call in `build_workbook`, so a fresh env value takes
effect without a restart. The export still deliberately ignores per-definition
`width_px` — that half was left as-is (display preference, not export layout).

### U-3 · Snippet autocomplete: Tab doesn't accept the first suggestion · `done` (2026-08-26, fix/ux-minor-batch)
A `Tab → acceptCompletion` binding in `CodeEditor.svelte`'s `Prec.highest` keymap; with no
list open it returns false and Tab falls through to the indentation keymap as before.
`frontend/src/lib/components/Snippet/` (CodeMirror). Wanted: Tab accepts the top
completion.

### U-4 · Snippet autocomplete is not type-aware · `open`
Ctrl+Space offers the same generic completion set regardless of the receiver's type.
Making it type-aware means the client needs a model of the facade's shape — the facade is
documented in `src/data_rover/core/script/README.md`, so the open question is whether the
client hardcodes that model or the server exposes it (the latter keeps them from drifting).

### U-5 · Relationship details panel doesn't show source and destination · `done` (already shipped)
Verified 2026-08-26: `Inspector.svelte`'s `relationship-endpoints` block renders both endpoints
as `goto-source`/`goto-target` buttons that select the element, pinned by
`inspector-relationship-nav.test.ts`. The backlog entry predated the fix.
Both should be listed and **clickable** (navigate to that element's details).
`frontend/src/lib/components/Inspector.svelte` + `Inspector/RelationshipsList.svelte`.

### U-6 · Element-valued properties render a name but aren't clickable · `done` (2026-08-26, fix/ux-minor-batch)
The resolved name in `ElementRefPicker` is now a button (`element-ref-goto`) that selects the
element — navigation only, `onChange` untouched; Clear/Browse unchanged.
In the element/relationship details panel, a property whose value is an element correctly
resolves and shows its name, but clicking does nothing — it should navigate to that
element's details. `frontend/src/lib/components/Inspector/PropertyField.svelte`.
Same underlying need as U-5; likely one shared "navigate to element" affordance.

### U-7 · Deleting a project leaves the card behind with a 500 · `done` (2026-08-12)
Root cause: `delete_project` committed the DB delete, then `SessionRegistry.evict` ran
the snapshot-on-evict hook for the hot session — `write_snapshot` inserted a `Snapshot`
row whose project FK was just deleted → `IntegrityError` → 500 *after* the delete
succeeded (hence "gone on reload"). Same path also risked zombie sessions: the evict
guard (live leases / feed clients) would skip a dead project's session forever.
Fixed with `SessionRegistry.discard` (drop without snapshot, without guard), called from
`delete_project`; pinned by `test_delete_hydrated_project_discards_session_without_snapshot`
and two registry-level `discard` tests.

### U-8 · Issues tab stays empty after project creation until "Validate" is clicked · `done`
Creating a project validates everything and the bottom bar shows the error count, but the
Issues tab renders empty until an explicit **Validate**, which then reports the *same*
count. So the count and the list read from different places. Almost certainly the same
root cause as **F-4** (the issue list is only ever refreshed by `validate-action.ts`) —
fix them together in `frontend/src/lib/state/validation.svelte.ts`.

### U-10 · Table columns UX batch · `done` (2026-08-28, feat/table-ux-batch) · *2026-08-28*
Nine owner items in one pass. **Reordering**: the Columns panel's drag (and the
grid header's) auto-scrolls near the container's edge, re-hit-tests on a wheel
scroll mid-drag, and the ghost is portaled to `<body>` (it used to stay behind,
`position:fixed` inside the transformed `Dialog.Content`); "Settings" is now
**Columns**, with a **Reorder** button beside it (`ColumnReorderDialog`, names
only); and **display order is decoupled from computation order**
(`TableDefinition.display_order`, `[]` = definition order, normalized like
`export_order`; the grid and the header drag speak it, the Columns panel keeps
the constrained computation order, an empty `export_order` follows it).
**Usability**: the panel resizes from every edge/corner with a visible grip;
"Insert before/after" per kind in both the panel's per-card menu and the
header's pencil menu (`columns.ts::insertColumn`); cards get `bg-card` + a
kind-coloured left edge against the panel's `bg-popover`. **Bugs**: the sticky
header was viewport-wide while rows were wider (`min-w-max` + per-cell
`bg-card`); every card carried a permanent `transform`, a stacking context that
trapped the property-name dropdown under the next card (drag-only transforms
now, in the grid too); a mousedown on the dropdown's scrollbar blurred the input
and closed it (`preventDefault`). Not in scope, still open: P-2 (per-column
search).

### U-9 · Commit panel content overflows its bounds · `done` (2026-08-26, fix/ux-minor-batch) · *2026-08-18*
Cause confirmed as diagnosed: flex children with no `min-w-0` and unbroken strings (ids, names
without spaces). `DiffRow` label/id/endpoint/value spans and the drawer's artifact rows, view
entries and error alerts now carry `min-w-0` + `break-words`/`break-all`; the dialog keeps its
width. Pinned by `diff-row.test.ts` (class-level — happy-dom has no layout engine).
When there are validation issues — and per the owner possibly in other cases not yet
pinned down — text and controls in the commit panel spill **outside** the panel instead of
the panel growing to fit. `DiffDrawer.svelte:356` fixes the dialog at `max-w-2xl` and its
two scroll regions at `max-h-[60vh]` (`:375`, `:585`), so any unwrapped long string — an
issue message, a bare id, a `friendlyCommitError` sentence — has nowhere to go
horizontally. Likely a missing `break-words`/`min-w-0` on the issue and entry rows plus a
wider or content-sized dialog; reproduce with a commit carrying conformance issues, then
check the other sections (long artefact names, long commit errors) for the same class.

---

## 5. Diagnosed bugs — frontend

All diagnosed (not suspected) in prior sessions and judged non-blocking at the time.
**Unverified against current code.**

### F-1 · Stale preview re-arms Rebind · `done` (2026-08-12)
Fixed by making preview and rebind **mutually exclusive in flight** (the diagnosed
one-liner — guard after the diff await — misses the rebind-resolves-first timeline, where
`_rebinding` is already false again by the time the stale preview lands):
`previewMetamodelChanges` refuses while `_rebinding`, `commitMetamodelRebind` refuses
while `_previewing`, and the Rebind button gates on `ed.previewing`. Pinned by two tests
in `metamodel-editor.test.ts`.

### F-2 · `Snippet/CodeEditor.svelte` external-replace echo bug · `open` · latent · *2026-08-11*
~lines 208-221 carry the identical bug that was fixed in `MetamodelYamlEditor`: an
external `code` replacement echoes back through `onChange` as a phantom edit. Unreachable
today because no caller replaces `code` post-mount — so this is a trap for the next
caller, not a live defect. The fix pattern already exists in `MetamodelYamlEditor`
(tag own transactions with an `externalReplace` annotation, filter in the
`updateListener`).

### F-3 · `quiet.ts` omits staged view depth from the quiet predicate · `done` · *2026-08-12*
`frontend/src/lib/state/quiet.ts:33` doesn't include `getStagedViewDepth()`, so a project
with only staged **view** changes reports as quiet.

### F-4 · Validation issue list never refreshes after a commit · `done` · *2026-08-12*
`frontend/src/lib/state/validation.svelte.ts` — only `validate-action.ts` refreshes it, so
the issue list goes stale after a commit lands.

### F-5 · `ExportArtifactsDialog` seed validation uses the unfiltered header set · `open` · latent · *2026-08-09*
`ExportArtifactsDialog.svelte:95` builds its membership set from the **unfiltered**
`getCommittedArtifactHeaders()`, not the `headers` derived at `:46`. A seed carrying an
unregistered-kind id (e.g. legacy `diagram`) enters `checked` while never rendering a row.
Unreachable today: the only seed caller sources ids from `dynamicTabs`, which exist only
for registered kinds.

### F-6 · New Project wizard close-reset misses `error`/`pending` · `done` (already fixed)
Verified 2026-08-12: fixed by `36843c6` ("fix(ui): clear the previous attempt's error on
wizard close", 2026-08-10) and the subsequent wizard rework — the close-reset now clears
`error` AND `pending` under a submit-generation guard, with a close→reopen test in
`NewProjectWizard.test.ts`. The backlog entry predated the fix.

### F-7 · Frontend import cycle worked around with `setTimeout(…, 0)` · `open` · *2026-08-08*
`view → realtime → artifacts → view`, papered over in `view.svelte.ts`. Works, but it's a
load-bearing timing hack.

### F-8 · Benign metamodel-editor rough edges · `open` · cosmetic · *2026-08-11*
- `discardMetamodelDraft` doesn't clear the pending lint timer (benign — the timer lints
  `_buffer` at fire time, so post-discard it lints the baseline and clears the gutter).
- `retryMetamodelLease` clears `_lockedBy` before the retry resolves, so the editor is
  briefly writable mid-round-trip; typed characters are kept, nothing is lost.

### F-9 · HistoryDrawer doesn't consume `GET /commits/{rev}/diff` · `open` · *parked 3×*
The backend endpoint exists and renders full before/after reconstruction; the drawer
doesn't use it. No client-side commit-diff schema exists yet. Parked repeatedly in favour
of other work — folds naturally into R-2.

### F-10 · Invalid `${name}` template blocks Export, not Save · `done` (2026-08-19, feat/exporter-v2-phase1) · spec divergence · *2026-08-14*
Resolved by amending the spec rather than changing behaviour: the shipped stance (block
**Export** with a 422, never Save) is now the documented contract — see the Amendments
block appended to `docs/superpowers/specs/2026-08-13-table-export-split-and-custom-export-design.md`
(gitignored, not in this commit) — and Exporter v2 §4 extends export-time template
strictness uniformly across every template. Precisely: the exporter artifact's OWN Save
(`ExporterTab.svelte`'s Save button, staging `update_artifact`/`create_artifact`) is never
gated on template validity — an entry with a bad `${...}` template saves fine and only
422s at `POST /exports/run`. `Export/EntryLayoutDialog.svelte:48-52`'s `splitTemplateInvalid`
still disables THAT dialog's own local Save (`:122`) when its working copy's split template
is tokenless — a pre-flight check on a dialog-scoped edit buffer, not a Save-time block on
the artifact itself, so the two are not in tension: this is belt-and-braces on top of the
export-time 422, saving a round trip when the check is cheap and already in hand, not a
second enforcement point that could reject a payload Save would otherwise accept. From the
P-13/P-14 final review.

### F-11 · Custom-export picker forbids the same table twice · `done` (2026-08-19, feat/exporter-v2-phase1) · *2026-08-14*
Fixed: the add-table filter (`usedRefs`) is dropped, so a table can be added to an exporter
more than once — "export table A as a wide xlsx *and* as split-per-element JSON" is now
expressible, matching what the server already supported via `_dedupe`.

### F-12 · `ensure*Draft` close race is shared by all four editors · `open` · class fix · *2026-08-14*
Closing a tab mid-`ensure…Draft` resurrects the draft after its lease was released: `ensure`
sets `_drafts` unconditionally after both awaits. Present identically in
`snippet-editor.svelte.ts`, `table-editor.svelte.ts`, `metamodel-editor.svelte.ts` and
`custom-export-editor.svelte.ts` — the custom-export one inherited it by following the pattern,
which is why it was not fixed locally during P-14 (fixing one would make the family
inconsistent). Worth **one** fix across all four, with a shared guard, rather than four patches.

### F-13 · `onReloadModel()`/`boot()` clear staged node moves but not the YAML draft · `open` · deliberate · *2026-08-16*
Both reload paths clear `metamodel-stage.svelte.ts`'s staged node moves, but leave the
metamodel editor's YAML draft untouched. So an open metamodel tab with a dirty draft, after a
reload path calls `resetCheckout()` (which wipes the `mm` lease token client-side), can still
send a `metamodel.rebind` op on the next commit attempt with a token the server no longer
honors — one recoverable 409 (the commit fails cleanly, the draft is untouched, the user
retries and the lease re-acquires). Deliberately not fixed: clearing the draft on reload would
mean silently discarding a user's typed YAML, which is worse than one 409.

### F-14 · Discarding staged metamodel moves doesn't re-derive the canvas · `done` (2026-08-26, fix/ux-minor-batch) · cosmetic · *2026-08-16*
`discardStagedNodeMoves` now fires an `onStagedMovesDiscarded` listener (same seam shape as
`onMetamodelCommitted`) and the diagram module refetches the baseline layout on it, so every
discard caller (drawer, Discard all, tab) snaps the canvas back. The lease-conflict path in the
diagram switched to the silent `clearStagedNodeMoves` so a peer's lease keeps the drag local as
documented.
"Discard metamodel changes" in the DiffDrawer's Metamodel section wipes the staged ops
(`discardStagedNodeMoves`), so the next commit is correct, but does not re-run the diagram's
position derivation — a dragged node visibly stays at its dragged position until the
metamodel tab is closed and reopened (which re-derives `_positions` from the baseline +
now-empty staged overlay). Purely visual; no staged data survives the discard.

### F-15 · Metamodel diagram navigation — deferred refinements · `done` (2026-08-20, feat/f15-diagram-nav-refinements)
Eleven findings triaged LEAVE by the final review of `feat/metamodel-navigation` (the branch
that closed **P-17**/**P-18** and shipped the type search and the collapsible TOC panel). None
was a correctness bug; each was a refinement the shipped surface carried as-is. All eleven are
now done — the list below is kept for the rationale each fix was made against.

- **Edge hover target is ~3 screen-px wide in LOD.** `BaseEdge`'s `interactionWidth` defaults
  to 20 *flow* units, so it shrinks with zoom — exactly the state the LOD tooltip exists to
  serve. Candidate fix: `interactionWidth={lod ? 60 : 20}` in both edge components.
- **The LOD cursor is tracked on every `pointermove` while LOD is active**, hovered or not;
  the spec says only while the tooltip is visible. `&& getDiagramHover() !== null` matches it,
  and subsumes the separate observation that `_cursor` is never cleared when LOD deactivates.
- **The LOD tooltip has no viewport-edge flip** — `left: clientX + 12` runs off-screen near
  the right edge, which is precisely where the form panel and rail sit.
- **Hover is never cleared when the diagram rebuilds.** If the hovered node disappears (undo,
  a peer's rebind), `_hover` points at a dead id and the canvas stays fully dimmed until the
  next pointer event. Clearing `_hover` inside `setDiagramAdjacency` closes it.
- **`searchTypes` truncates silently at `limit = 20`** — at 300 types a two-letter query drops
  most matches with no "+N more" affordance.
- **Tab doesn't close the search dropdown** (only Escape and an outside `pointerdown` do), so
  tabbing out of the toolbar leaves an orphaned list floating over the canvas.
- **a11y: neither typeahead implements the full combobox pattern** — `role="listbox"`,
  `aria-activedescendant`, DOM focus following the active row. The metamodel type search and
  the pre-existing `Sidebar/Search.svelte` element typeahead share the gap, so it is one
  app-wide item rather than one per surface. Nothing incorrect is asserted today; this is an
  enhancement, not a false claim.
- **Untested branches** (companion to T-2): `metamodel-canvas.test.ts`'s memo-invalidation
  test only ever changes the hover, never the adjacency, so `_hlFor.adj !== _adjacency` is
  unexercised; and `metamodel-panel.svelte.ts`'s non-array-JSON and unrecognized-key read
  paths have no dedicated test.
- **`MetamodelSearch.svelte` resolves its dropdown for the outside-click check via a hardcoded
  `document.getElementById('mm-search-dropdown')`** — safe while the toolbar is a singleton,
  would cross-match the moment two mount at once.
- **The LOD edge tooltip could name both endpoints.** Both tether halves of a boxed
  relationship carry the mapping index (`assoc-in:<Rel>:<i>` / `assoc-out:<Rel>:<i>`), so the
  outer endpoints of a hovered half are recoverable — `Monitors: Building → Zone` instead of
  today's bare `Monitors`.

Shipped, all eleven:
- `EDGE_HIT_WIDTH_LOD` (60 flow units) widens both edge components' `interactionWidth` under
  LOD; `noteHoverCursor` in `state/metamodel-canvas.svelte.ts` replaces the raw setter on the
  canvas's `pointermove` and records only while the tooltip could be showing, clearing
  otherwise; `setDiagramAdjacency` drops the hover so a rebuild cannot leave the canvas dimmed
  against a dead id; Tab closes both dropdowns.
- `metamodel/diagram-tooltip.ts` is a new pure anchor function that flips the LOD tooltip to
  the far side of the cursor near a window edge (anchoring `right`/`bottom`, so the gap stays
  exact whatever the label measures). `searchTypes` now returns `{hits, total}` and the
  dropdown renders `+N more`. Both typeaheads resolve their dropdown by BOUND reference for
  the outside-click check instead of `document.getElementById`.
- Both untested branches are covered: the memo's `_hlFor.adj !== _adjacency` clause
  (`metamodel-canvas.test.ts`) and the non-array-JSON / unrecognized-key read paths
  (`metamodel-panel.test.ts`). `hoverLabel` crosses the association-class box via
  `siblingTetherId`, so either tether half reads `Monitors: Building → Zone`.
- The a11y item took BOTH typeaheads, per the reviewer's all-or-nothing call: `role="combobox"`
  + `aria-expanded`/`aria-controls`/`aria-autocomplete` on each input, `role="listbox"` on the
  list, non-interactive `<li role="option">` rows with per-instance `$props.id()` ids, and
  `aria-activedescendant` following the active row (focus stays on the input; an `$effect`
  scrolls the row into view). `Sidebar/Search.svelte` had NO keyboard navigation at all before
  this and gained ↑/↓/Enter along with it. One consequence outside the frontend unit suite:
  its rows stopped being `<button>`s, so `e2e/view.spec.ts`'s search-drag locator moved to
  `getByRole('option')` — that one spec was run and passes (`frontend-test-e2e -- -- -g
  "search result dragged into a folder"`), which also re-verifies the row drag off the new
  markup in a real browser.

### F-16 · `EntryLayoutDialog`'s Save gate on a bad split template — tension with never-block-Save · `done` (2026-08-21, feat/exporter-v2-phase3)
`Export/EntryLayoutDialog.svelte`'s `splitTemplateInvalid` disabled its own Save button while
the working copy's split filename template is tokenless — F-10 (above) already argued this is
belt-and-braces on a dialog-scoped edit buffer, not a Save-time block on the artifact itself,
and not a second enforcement point that could reject a payload Save would otherwise accept.
Exporter v2 Phase 2 widened the same gate from `format === 'json'` to the whole json family
(`json || jsonl`), so it also disabled Save for a `jsonl` entry with a bad split template.
Resolved in Phase 3: Save no longer blocks on it (matching F-10's principle and the object-shape
`key_column` hint's stance) — an inline `entry-split-template-warning` next to Save replaces the
gate, and enforcement stays the export-time 422.

### F-17 · Rules tab Save stays enabled on a document the server will reject · `done` (2026-08-26, fix/ux-minor-batch) · *2026-08-24*
Save is disabled (with a title) while `draft.lintErrors` is non-empty; drift warnings never gate
it, per the distinction below.
`components/Rules/RulesTab.svelte` disables Save only while the tab is lock-denied, so an
unparseable rule set can be staged. It then 422s the **whole** commit batch
(`api/artifact_ops.py`: `invalid validation_rules payload: …`), taking unrelated model and view
edits down with it. `POST /commits/preview` catches it first, which is the mitigation — but the
client already knows the document is invalid, since `draft.lintErrors` is exactly that answer.
Note the tension with F-10/F-16, which argue *against* Save-time gates: the difference is that
those blocked on a **presentation** setting only export-time rendering could judge, whereas this
one is a structural payload error the server refuses at save on every path. Disabling Save (or
confirming) is the cheap version; the alternative is letting preview keep owning it.

---

## 6. Diagnosed issues — backend

### K-1 · `expand_targets` degrades against a cold `session.view` · `open` · *2026-08-08*
`routes/locks.py` ~:84. Consequence is false-409 only (never a missed lock), which is why
it was deferred.

### K-2 · Overlap-staleness completeness debt · `open` · *named in the Redis spec's non-goals*
`routes/commits.py` ~:306. Commit staleness is overlap-based with a completeness guard
that falls back to a strict 409 whenever the journal tail can't account for the rev gap.
The debt is the fallback's breadth.

### K-3 · Artefacts Phase 3 minors · `open` · cosmetic · *2026-08-08 → 2026-08-10*
- Inert `ack_errors` in the 422→409 remap.
- ~~"Imported 1 artifacts" — unpluralized default message~~ **done** (2026-08-26).
- Unbounded bundle sizes on import/export.
- `importer._landable_artifacts` vs `derive_plan_ex` order-of-checks reason-string
  mismatch (cosmetic divergence between two paths that should report identically).

### K-4 · Stale cross-reference comments · `open` · cosmetic · *2026-08-08*
`routes/ops.py` ~:707/:714 reference "create_commit's own `created_view`"; `commits.py`
~:688 has an orphan short comment line and bare `created_view` mentions in the b/b3
preamble. Fix on the next touch of those files.

### K-5 · Refresh mid-edit strands the `mm` lease for the full TTL · `open` · by design · *2026-08-11*
Inherent to the Phase 4 memory-only registry. Bounded (300s), and same-holder leases don't
self-block, so the user who refreshed isn't locked out of their own work. The lease mirror
does **not** change this — it makes the strand survive a restart too.

### K-6 · History diff is slow on a big model · `done` (2026-08-26, perf/journal-only-history-diff) · owner-reported · *2026-08-12*

Closed as the owner proposed, one step further: instead of a reference list, every journal
writer stores the touched entities' FULL before/after state on the row (`Commit.entity_states`,
nullable JSON, capped at `ENTITY_STATES_MAX` = 5000 touched entities → NULL → reconstruction
fallback, alembic `0013`), because a reference list alone cannot render `modified` — the
inverse patch only carries touched keys. `GET /commits/{rev}/diff` is now O(commit); the
frontend's per-commit Diff was switched to it (it previously fetched `GET /commits/{rev}/model`
twice and diffed client-side, so the backend route had no app caller). Measured at 320k:
11 ms on the journal path vs. 42.7 s reconstructing (+1.6 GB transient RSS). The two-revision
Compare still reconstructs (O(model), deferred by design). Baseline rows keep NULL. Also folds
the "backfill or tolerate NULL" question: NULL is tolerated, never backfilled.

Measured 2026-08-26 on a 320k-element fixture (212 MiB snapshot): each `reconstruct_model_at`
is a full snapshot download + `json.loads` (3 s) + `build_model_from_dicts` (~8 s after K-20,
~30 s before) — **two per diff click**, plus ~2 × 1 GB transient RSS. Next in the large-model
performance program after K-20 (see K-21 → K-25 for the rest of the program and its order).

`GET /commits/{rev}/diff` reconstructs before/after state per entity
(`api/commit_diff.py`), which doesn't scale with model size. Owner's proposal: store a
reference list of everything a commit changed (elements, artefacts, …) on the commit row
so the diff reads it instead of reconstructing.

That's cheap to do: `commits` already carries `ops`/`inverse_ops` as JSON, and
`api/invalidation.touched_keys` **already derives touched ids from a batch** — the same
function could populate a new `touched` column at commit time, with no new derivation
logic. Two things to settle: the column is additive but existing rows have no value
(backfill from `ops`, or tolerate `NULL` = fall back to today's path), and a reference
list alone gives you *what changed*, not *what it changed from* — so before/after values
still need the journal. Alternative designs welcome; this one is just the cheapest.
Folds naturally into R-2.

### K-7 · Duplicate type names are silently accepted by the whole stack · `open` · *2026-08-13*
`core/metamodel/check.py`'s `check_metamodel` builds `element_names = {e.name for e in
mm.elements}` — a **set** — and never compares its cardinality to `len(mm.elements)`. So a
metamodel defining two element types with the same name produces **zero** validation
errors. `core/metamodel/schema.py` then builds its lookup caches **first-wins**
(`types_by_name.setdefault(et.name, et)`, `rel_types_by_name.setdefault(...)`, ~:250-255),
and the frontend's `metamodel/yaml-edit.ts` `typeMap` resolves first-wins too (it returns
the first `name`-matching map in the section).

Consequence: the duplicate is accepted everywhere, and every edit addressed **by name**
resolves to the FIRST definition while the diagram canvas — which keys nodes into xyflow's
`nodeLookup`, last-wins — renders the SECOND. The second type silently absorbs nothing and
the first silently absorbs everything.

Ruled a pre-existing engine gap and out of scope during the metamodel diagram editor work
(`feat/metamodel-diagram-editor`), on condition it be filed here. The diagram's forms now
prevent it at the form boundary (`metamodel/helpers.ts` `typeNameCollision`), so it is only
reachable by hand-editing YAML — but that is **one toggle away in the same tab**, not an
external-file scenario, which is why it is worth closing properly.

Fix is roughly four lines: a cardinality check in `check_metamodel` over `mm.elements` and
`mm.relationships`, reporting each repeated name. Cheap; the only question is whether any
existing fixture/example metamodel would start failing.

### K-8 · A rebound commit persists the whole model's conformance issues, uncapped · `open` · *2026-08-16*
A rebind-carrying `POST /commits` batch replaces the dirty-scope validation splice with a
full `Scope.all()` sweep and splices the RESULT into `Commit.issues` (JSON) at persist time —
the whole model's conformance issue list, with no cap. This mirrors the retired standalone
`POST /metamodel/rebind` route exactly, so it is **not a regression** introduced by the
metamodel commit-flow feature; it's the same precedent `ISSUES_RESPONSE_MAX` (5000) already
exists for on the live `GET /model/issues` read path (see CLAUDE.md's note on that cap), just
never applied to the persisted commit row. Worth revisiting alongside K-6 (history diff cost)
since both are about a rebind-scale commit paying whole-model costs.

### K-9 · `POST /metamodel` / `DELETE /metamodel` mutate `session.metamodel` without `write_mutex` · `open` · pre-existing · *2026-08-16*
Both routes (`routes/metamodel.py`) rely on the honor-only `_peer_mm_conflict` lease check
alone — no `session.write_mutex` is held around the read-then-mutate. Racing either against a
`POST /commits/preview` or `POST /commits` mid-flight could observe (or leave) `session.metamodel`
`None` between a pre-mutex read and the mutex-held restore in `create_commit`'s unwind path.
`create_commit` itself already carries the identical exposure elsewhere in its own preamble
(read before mutex), so this is not a new risk introduced by the metamodel commit-flow
feature — filed here because it was noticed while auditing that path's mutex discipline for
this feature, not because anything here changed.

### K-10 · `POST /tables/export`'s `json_split.filename_template` skips token validation · `done` (2026-08-20) · *2026-08-19*
Closed in the shared engine rather than the route: `table_export_engine.run_table_export`
now runs `validate_tokens(split.filename_template, SPLIT_TOKENS)` beside the existing
`validate_template` call, so BOTH callers (`/tables/export` and `/exports/run`) reject an
unknown token — the standalone route's existing `ValueError → 422` mapping carries it.
Pinned by `test_unknown_token_in_split_template_answers_422`.
The two export routes are asymmetric on naming strictness: `POST /exports/run` validates
every template's `${...}` tokens up front and 422s on an unknown one, but
`POST /tables/export` renders a table's own `json_split.filename_template` through the same
context-token substitution with **no** `validate_tokens` pass (see `routes/tables.py` vs.
`routes/exports.py:167-174`) — so a typo'd `${revv}` there ships verbatim into filenames
instead of failing loudly. Pre-dates Exporter v2 (the old code literal-replaced `${name}`
and left everything else verbatim); Exporter v2 Phase 1 scoped `routes/tables.py` to the
`template_vars` thread-through only. Closing it means running the standalone route's split
template through `naming.validate_tokens(..., SPLIT_TOKENS)` and mapping the `ValueError`
to a 422. Surfaced during the Exporter v2 Phase 1 Task 5 review and deliberately parked as
out of scope for that pass.

### K-11 · CSV export writes untrusted cell text through `csv.writer` unmitigated · `open` · deliberate · *2026-08-20*
`core/table/csv_export.py`'s `render_csv` puts `cell_text`'s raw model-property output
straight through `csv.writer` with no formula-injection mitigation. `api/table_export.py`'s
xlsx writer, three files away, hardens the identical untrusted content with
`"strings_to_formulas": False` and an explicit comment calling out the risk — so an
element or property named e.g. `=HYPERLINK("http://evil","click")` ships as inert text in
the xlsx but becomes a LIVE formula the moment the CSV is opened in Excel/LibreOffice/
Sheets, and a CSV is if anything MORE likely to be double-clicked into a spreadsheet than
an xlsx is.

Ruled a deliberate, documented posture rather than a bug during the Exporter v2 Phase 2
final review: the standard mitigation (a leading `'`/tab/space before anything
formula-shaped) MUTATES the field for the machine consumers — `csv.reader`, pandas, a data
pipeline — the CSV format exists to serve, and RFC-4180 has no formula concept for a
mitigation to appeal to in the first place. xlsx has no such non-spreadsheet reader to
protect, which is why hardening it is free and hardening CSV is not. The asymmetry is now
recorded rather than silent — see `csv_export.py`'s module docstring (the "Formula
injection" paragraph, added alongside this entry) for the full reasoning both ways. Worth
revisiting if a consumer ever reports opening exported CSVs directly in a spreadsheet tool
as a primary workflow rather than an edge case.

The owner confirmed this keep-unsanitized posture on 2026-08-20 (Exporter v2 Phase 3 review):
the decision is closed, not merely recorded — no mitigation is planned unless the "revisiting"
trigger above actually fires.

### K-12 · `RunExportIn.definition` had no cap on entry count · `done` (2026-08-21, feat/exporter-v2-phase4) · *2026-08-21*
`POST /exports/run` is a viewer-callable, read-only-by-`authz` POST, and `RunExportIn.definition`
(P-16, Exporter v2 Phase 3) let it run an arbitrary, ungated `ExporterDefinition` — including one
built client-side with an unbounded `entries` list. Each entry evaluates a whole table (O(model)),
synchronously, in one request: an attacker-sized `entries` array could chain N such evaluations
into a single call with no server-side ceiling. Fixed in Exporter v2 Phase 4 by capping
`ExporterDefinition.entries` at `MAX_EXPORTER_ENTRIES = 50` (`core/table/exporter.py`,
`Field(max_length=50)`, spec §17.1) — a schema bound in the `SNIPPET_MAX_CODE_BYTES` tradition:
it rejects at `POST /artifacts` save AND at `RunExportIn.definition` request-parse time (both go
through the same `ExporterDefinition` type), deliberately NOT an export-time strictness rule,
unlike every other exporter guard in this file — the never-block-Save rule governs strictness
only export-time rendering can detect, and an oversized entry list is detectable earlier than
that on both paths. Surfaced during the
Exporter v2 Phase 3 review; closed as the first task of Phase 4.

### K-13 · `expand_scope` recomputed its seed set per `(rule, path, depth)` triple · `done` (2026-08-24, feat/validation-rules) · perf · *2026-08-24*
Closed as a side effect of the retype under-approximation fix. Dropping the per-step
`far_types` gates left the seed set independent of `(rule, path, depth)`, so it is now built
once at the top of `expand_scope` instead of rebuilt in the innermost loop. The remaining
cost is the reverse hops themselves — deliberately more of them than before, since the walk
no longer prunes by far type (see the CLAUDE.md note on why that pruning was unsound).
Re-open only if profiling shows the extra adjacency walking matters on a real model.

### K-14 · `CompiledRules.eval_errors` has a `reset_eval_errors()` with no caller · `open` · *2026-08-24*
Two thirds of this landed on `feat/validation-rules`: the counter is now replaced by whole-object
swap under a lock (an unlocked `dict(compiled.eval_errors)` snapshot can no longer tear), and a
rule that raises logs one traceback per `(check, exception type)` per run instead of one per
failing element — the original hazard, which on a 100k-element model was 100k tracebacks per sweep.

What remains: `reset_eval_errors()` exists and **nothing calls it**, so the number
`GET /model/issues` reports is still lifetime evaluations rather than current state; and the wire
dict still has one key per rule with no ceiling, where the design calls for *capped* reporting.
The natural caller is the start of a full background sweep, which re-derives every count anyway.
Cap the dict the way `ScriptWarningLog` caps distinct warning kinds — keep counting a key already
present, drop brand-new keys past the cap.

Separately, the client decodes `rules_status.eval_errors` (`frontend/src/lib/api/validation.ts`)
and renders it nowhere, so a rule failing on every element it visits is invisible in the UI: no
issue, no banner, no chip. Either surface it beside the skipped-rules banner or record the
omission deliberately.

### K-15 · `POST /rules/lint` hydrates the session; `/metamodel/lint` deliberately does not · `open` · *2026-08-24*
`routes/rules.py::lint_rules` depends on `get_request_session`, so a debounced per-keystroke
lint hydrates a cold project — the exact cost `routes/metamodel_swap.py::lint_metamodel` avoids
by taking no `Session` dependency at all. The dependency is not gratuitous: drift warnings need
`session.metamodel`. A fix has to keep drift working without full hydration — read the
metamodel blob straight off `MetamodelRow` for the lint, or make the drift half opt-in so the
parse+schema half stays hydration-free.

### K-16 · `core/metamodel/loader.py` has the alias-bomb weakness rules YAML just closed · `open` · *2026-08-24*
`feat/validation-rules` taught `parse_rule_set` to refuse YAML aliases, because PyYAML memoizes
anchors into a shared-reference DAG that loads in flat time while pydantic then walks it as a
tree — ~360 bytes of nested aliases measured 6.4 s and 493 MB, and one more level OOMed, all
under every size cap (they measure source text). `core/metamodel/loader.py` is the only other
`yaml.safe_load` in the repo and has the identical shape on the metamodel upload and
`POST /metamodel/lint` paths — and that lint route, like the rules one, is debounced per
keystroke. Deliberately left out of the P-12 wave as out of that branch's scope. The rules fix
(`_NoAliasLoader` in `core/validation/rules/schema.py`) is the model; a metamodel author has no
more use for anchors than a rule author does, but confirm that against
`examples/smart-city.metamodel.yaml` before refusing them.

### K-18 · The strict gate cannot tell a flipped rule verdict from a pre-existing one · `open` · deliberate · *2026-08-24*
`api/rules.py::attributable_issues` lets **every** `rule:` verdict through the strict-mode gate,
wherever it sits, because reach expansion exists precisely so a far edit can flip a rule the batch
never touched. The cost is the converse case: an element that ALREADY violated a rule, pulled into
scope only by the expansion, blocks a strict commit that had nothing to do with it. Distinguishing
the two needs a diff against the prior issue store for that owner (`ValidationState.issues_for`)
rather than a check-name test. Chosen over-blocking rather than under-blocking, matching the
widening's own over-approximation stance — but the built-in half of this problem was worth fixing,
so the rule half is worth revisiting. Not a regression against `main`, where rules did not exist.

### K-17 · A rules-artifact edit persists the whole `applies_to` population's issues · `open` · *2026-08-24*
Same shape as K-8, different trigger. A commit touching a rules artifact widens the validation
splice to the `applies_to` population of the old ∪ new compiled sets — correct, since issues
minted by a deleted or renamed rule have to drop — but that population lands in the response's
`issues_added` **and** in the `Commit.issues` JSON column, so on a large model one rule edit
writes a very large journal row. K-8 already records the rebind case; rule edits are far more
frequent than rebinds. Whatever caps K-8 should cap this too.

### K-19 · `POST /projects` is the one upload path the body cap doesn't reach · `open` · *2026-08-26*
`deps.read_capped_body` caps the two raw-body routes (`POST /model/upload`, `POST /model/compare`)
at `max_request_body_bytes`, 413 over. The project-creation upload takes **FormData**, not a raw
body, so it never calls the helper and stays unbounded — and it is the path that accepts a
metamodel + model + view + artifact bundle in one request, so it is not the small one. Needs a
different mechanism than `read_capped_body` (Starlette parses multipart itself; the cap has to
land on the parser or on the parts, not on a byte stream the route reads). Same 413 contract when
it lands, so a client can keep telling "too large" from "malformed".

### K-20 · The trigram search index was built inline by `IndexSet.rebuild()` · `done` (2026-08-26, perf/deferred-search-index) · perf · *2026-08-26*
Measured on a 320k-element / 239k-relationship fixture (212 MiB snapshot — production
size): `build_model_from_dicts` 30.0 s of which the trigram index 22.5 s, index RSS +1.78 GB
of which the trigram postings ~1.5 GB (29.5M posting entries; production uuid7 ids add ~28
per element). The index was also rebuilt — and discarded — by every `rebuild()` caller that
never searches: rebind preview (twice, under `write_mutex`), rebind commit (+unwind),
`/metamodel/diff`, apply-cr per CR, history reconstruction. Fixed: `rebuild()` no longer
builds it (`search_ready=False`, scan fallback), `api/search_index_build.py` builds the live
session's index in the background, rebind paths keep it via `rebuild(keep_search=True)`.
Same branch fixed a latent bug: `rebuild()` never cleared its per-type metamodel caches, so
a containment- or key-flipping rebind left the containment tree, roots order and uniqueness
groups stale until eviction. NOT done (deliberate): shrinking the posting sets — memory stays
~1.5 GB for the live session; revisit only if RSS binds after K-21.

### K-21 · Snapshots are stored indented and uncompressed · `done` (2026-08-26, perf/compressed-snapshots) · perf · *2026-08-26*
Snapshots are now a gzip member (level 3) of the COMPACT document, encoded in batches of
2000 entities per `json.dumps` (`serialize.iter_model_json_compact`, `api/snapshot_codec.py`);
the reader sniffs the gzip magic, so pre-existing `.json` rows load untouched (no migration,
no `encoding` column). Measured at scale 320 (320k elements / 239k relationships) through the
real app on the memory store: snapshot blob **212 MiB → 10.9 MiB**; in-process
`write_snapshot` **2.99 s → 1.59 s**; `decode_snapshot` 2.77 s (was 2.9 s
`json.loads` of the indented text); hydrate end-to-end 42.9 s with sync sweeps.
Spike numbers behind the two knobs (scale 170): batching the encoder 1.58 → 0.82 s; gzip
1/3/6/9 = 0.26/0.29/0.62/2.37 s for 6.7/5.8/4.9/4.5 MiB.
The periodic snapshot (`_maybe_periodic_snapshot`) now runs on a background job
(`api/snapshot_job.py`) that takes `write_mutex` itself, so the 200th commit no longer pays
the encode; rebind-forced, evict and baseline snapshots stay synchronous.

### K-22 · Uniqueness validator builds a whole-model position map per scoped run · `done` (2026-08-27, perf/uniqueness-position-index) · perf · *2026-08-26*
`IndexSet.element_order` (element id → monotonic insertion sequence number, maintained by
the two element hooks and re-derived by `rebuild()`; `verify_consistent` checks the order
invariant) replaces the validator's per-run `{eid: i for i, eid in enumerate(model.elements)}`
— 79 ms + 17 MiB per build at 320k, paid in ~120 of the sweep's ~160 element chunks and in
every commit touching a duplicate group. Measured at scale 320 with 231 sporadic duplicate
groups injected (the fixture generator avoids duplicates): element half of the sweep
**17.10 s → 5.47 s** (median 126 → 32.7 ms per chunk); full-scope
uniqueness run 185 → 92 ms; `create_element` / `delete_element` 46.0 / 17.8 µs per
op (was 42.8 / 16.8 — the index is one dict insert / one pop); `rebuild()` 3.32 s (was
3.23); +15.9 MiB resident. The per-sweep hoist alternative was declined: a fresh
pipeline per request means every commit would still pay the build, and the core has no
mutation counter to key a cached map on.

### K-23 · `Model.set_property`/`delete_property` copy the property list and build a name set per write · `done` (2026-08-27, perf/property-write-hot-path) · perf · *2026-08-26*
The spike said the list copy was 2.5 µs of a 76 µs write: ~85 % was `on_properties_changed`
re-deriving the element's WHOLE trigram set for one changed value (and 95 % of a 130 µs
first touch of a never-indexed element — the replay tail's case). Three legs:
`Metamodel.effective_*_property_names` (cached frozensets, shared with `_check_patch_keys`);
`IndexSet.on_property_changed(entity, prop, old_value)`, which diffs the search index from
the changed value's text (removal candidates verified by substring against the other fields,
the sorted tuple patched with `bisect`; whole-element fallback for list values) —
`verify_consistent` pins it byte-identical to a full build; and per-element ownership of
the search index (`_trigrams_of` entry ⇔ indexed, `()` included), so a bulk-loaded element
the chunked build has not reached is left to that build instead of being indexed on first
touch. Measured at scale 320: cold `set_property` **129.8 → 5.6 µs**, warm
**75.8 → 34.5 µs**, restore-style replay 54.5 → 23.8 µs per write, a 200-batch
tail of 10 × 3-key `update_element` **736 → 108 ms** cold / 409 → 127 ms
warm, `_check_patch_keys` 2.49 → 1.17 µs; 0 of 3000 edited elements differ from a full
derivation and `verify_consistent` passes at 320k.

### K-24 · Untyped navigation scope sorts every element id · `done` (2026-08-27, perf/untyped-navigation-scope) · perf · *2026-08-26*
`core/navigation/evaluate.py::_scope_ids` built `set(model.elements.keys())`, re-looked every id
up for a criteria filter that ran `all(())` even with no criteria, and `sorted()` the hash-ordered
survivors — once per table per commit (`TableOrderCache` is rev-keyed). The spike put the set at
pure loss: 48 ms to build, a per-id lookup, and a real O(n log n) sort (172 ms) where the dict's
own insertion order is a presorted run (production ids are UUIDv7, the importer's sequential).
Now the untyped branch walks `model.elements.values()`, an empty criteria list short-circuits
to `sorted(...)` in both branches, and the two matchers are plain loops; the result stays the
ascending-id list (row order and paging byte-identical — returning insertion order was decided
against, see the spec's non-goals). Measured at scale 320 (320,640 elements): untyped no-criteria
**465 → 24.1 ms**, untyped + one criterion **762 → 307.4 ms**, typed `Person` (51,200 el)
45 → 16.6 ms; a shuffled insertion order (the degraded case) 167.4 ms; 0 of 40 scope shapes
differ from the set-based derivation on both the ordered and the shuffled model.

### K-25 · `GET /model/relationships` is unpaged · `open` · perf · *2026-08-26*
`routes/relationships.py:19` materializes all ~400k relationships into pydantic models with
no `limit`/`offset`; `source_id`/`target_id` filters are already served by
`IndexSet.outgoing_ids`/`incoming_ids`. No app caller (`frontend/src/lib/api/relationships.ts`
is test-only). Page it or delete it. Last in the program.

### K-26 · A wide element input charges every input element to the cell's read-set · `open` · perf · *2026-08-27*
`core/script/facade_src.py::_dr_call_entry` fetches every `elements`-input id eagerly through
`_fetch_element`, which notes a read unconditionally. A navigation input can reach up to
`EvalLimits.max_chains` (5,000) elements, so one input can push a call past `_READS_CAP`
(2,000) → `reads=None` → "depends on everything" → evicted on every commit, and past
`ScriptCellCache.put`'s `_MAX_STORED_READS` too. Conservative and correct, but such a cell
stops being incrementally cacheable. Cheapest fix: a sentence in `core/script/README.md`'s
read-set section so authors know a wide element input costs invalidation granularity. Lazy
handle construction would fix it properly but breaks the read-set-is-conservative invariant.

### K-27 · The host→guest frame is unbounded in the inputs direction · `open` · *2026-08-27*
`api/script_runner.py::_WasmSnippetSession.call` puts every resolved input (and the projected
input elements) on the `call` frame with no size cap; a property input over many roots or a
5,000-element navigation input fails as guest OOM → `ScriptError(kind="memory")` — degraded,
not a 500, and it mirrors the pre-existing root-projection exposure, so not a new risk class.
`snippet_transform_max_bytes` is the precedent; a symmetric `snippet_inputs_max_bytes`
(both directions, 422/error cell over) would be cheap insurance. Inputs are host-built from
the model — no client-forgeable path.

### K-28 · Console "Run as value" on a two-arg `value()` dies with a bare `TypeError` · `open` · *2026-08-27*
`derive_entry_points` now advertises `"value"` for a 2-arg snippet, but the console run path
(`api/script_runner.py` `_run_embedded`, the `fn(els)` call) has no inputs to pass, so a snippet
written for a table column with inputs shows an enabled "Run as value" and fails with
`TypeError: value() missing 1 required positional argument: 'inputs'`. Self-explanatory, but a
targeted message ("this value() takes column inputs; run it from the table") or disabling the
entry in the console for arity-2 snippets would save a support round-trip.

---

## 7. Cleanups & dead code

| ID | Item | Source |
|---|---|---|
| C-1 | `setMetamodelFilename` / `setFilename` in `frontend/src/lib/state/file.svelte.ts:27` — zero callers since the swap drawer was deleted. Delete both together. | 2026-08-11 |
| C-2 | Three `mm`-lease re-exports in `frontend/src/lib/state/index.ts` ~:205-207 — zero consumers (the editor imports them by relative path). | 2026-08-11 |
| C-3 | `_seed_view` conftest duplication across 4 test files — consolidate. | 2026-08-08 |
| C-4 | `routes/ops.py::undo` never migrated onto `_CommitUnwind` (the commit path's shared unwind helper). | 2026-08-09 |
| C-5 | `bindableOpen(get, set)` helper to collapse five store↔dialog open-mirrors. Declined once as a 5-file zero-behaviour-change refactor. | 2026-08-10 |
| C-6 | `done` (2026-08-14) — extracted to `frontend/src/lib/artifacts/kinds.ts` (`REGISTERED_KINDS`/`KIND_ICONS`/`SECTION_KINDS`), now the single source consumed by `ExportArtifactsDialog`, `ImportArtifactsDialog`, `ArtifactsSection`, `TreeRow`, `DiffDrawer` and the state unions. | 2026-08-10 |
| C-7 | `inspection-history.svelte.ts` — `backEntries`/`forwardEntries` are near-identical mirrored loops. | SDD ledger |
| C-8 | `HistoryNav.svelte` — ~30 duplicated lines between the Back and Forward dropdown blocks, differing in ~6 tokens. Awkward to extract because `bind:open` needs a distinct `$state` per menu. | SDD ledger |
| C-9 | `DropdownMenu.Item` uses `onclick` at 6 sites where `onSelect` is the repo majority (16 sites); `onSelect` also fires for keyboard selection. | SDD ledger |
| C-10 | `done` (2026-08-19, feat/exporter-v2-phase1) — the wire entry was renamed `ExporterEntry` (not `CustomExportEntry`, per the `custom_export` → `exporter` kind rename that landed in the same pass) alongside `export-layout.ts`'s `ExportEntry` layout row, resolving the naming collision. | P-14 final review, 2026-08-14 |
| C-11 | `pixi run -e core-dev ruff check tests/api/` reports 5 errors in files this branch never touched. No pixi task lints `tests/` at all (`core-lint` only covers `src/`), so this debt is invisible to the normal toolchain — it was found only by running the linter against the test tree by hand. Pre-existing, confirmed 2026-08-16. | metamodel commit-flow final review |
| C-12 | `src/data_rover/api/routes/commits.py` is ~1785 lines and holds `/open`, `/commits`, `/commits/preview`, `/commits/revert`, the `_CommitUnwind` ledger, the lock-verification helpers and the staleness backstop. The natural seams are the preview/revert routes and the unwind ledger; the commit route itself is one long ordered sequence and does not want splitting. | P-12 final review, 2026-08-24 |
| C-14 | A rule's `check` is `rule:<name>`, and names are unique only *within* a rule set — two `validation_rules` artifacts can each define `has-zone`. Their issues then share one Issues-panel chip and one `eval_errors` bucket. Either qualify the check with the artifact id or record the merge as accepted. | P-12 re-review, 2026-08-24 |
| C-15 | `RulesValidator`'s generated message is `"Rule 'x' violated[: description]"`, where the design's pinned shape is `"<rule-name>: <failed-assertion summary>"`, and it never names the far elements that witnessed the failure. The design hedges that context with "where cheaply available", so the omission is fine — but the format is a straight deviation. Match it or amend the design. | P-12 re-review, 2026-08-24 |
| C-13 | ~~`frontend/src/lib/api/rules.ts`'s `RulesLintErrorSchema` duplicates `api/types.ts`'s `MetamodelLintErrorSchema` field for field.~~ **done** (2026-08-24, feat/validation-rules) — the client now reuses one shared schema, matching the backend's `LintErrorOut`. | P-12 final review, 2026-08-24 |
| C-16 | `frontend/src/lib/table/columns.ts::remapColumnRefs` calls `f(i.ref.index)` up to three times per script input (`.some` predicate, `.map` condition, `.map` value). `f` is pure and throws-on-forward, so a hoist must still *call* it once per input. | script-column-inputs final review, 2026-08-27 |
| C-17 | `done` (2026-08-28, feat/table-ux-batch) — `columnRefs` returns `{index, why}`; the error now reads `column N reads input "x" from column M` for a script input. | script-column-inputs final review, 2026-08-27 |
| C-18 | `ScriptInputsEditor.svelte` calls `nameError(inp.name, i)` twice per row per render (the `{#if}` guard and the span body); a per-row `$derived` errors array is tidier. Imperceptible at ≤50 inputs. | script-column-inputs final review, 2026-08-27 |
| C-19 | Mid-file imports appended by TDD steps in `tests/table/test_schema.py`, `tests/script/test_embed_cache.py`, `tests/api/test_script_sweep.py` (ruff E402 — invisible because no task lints `tests/`, see C-11); plus `core/script/README.md` ~§142 states the `step`/`transform` one-arg rule twice within four lines. | script-column-inputs final review, 2026-08-27 |

---

## 8. Test gaps, flakes, and a11y

### T-2 · Untested branches · `open`
- `routes/commits.py::revert_commit`'s rules path — the revert route validates through
  `session_pipeline` (~:1677) like every other converted call site, but no test asserts a
  revert refreshes rule issues.
- `routes/commits.py::preview_commit`'s rebind path with rules — `candidate_pipeline`
  (~:603) recompiles the committed rule sources against the candidate schema so a preview
  of a `metamodel.rebind` shows rule flips; only the non-rebind preview branch is covered.
- `Workspace.svelte` close-path metamodel branch (redundant by design with the
  component's own unmount teardown, but unpinned).
- `commitMetamodelRebind`'s `isProjectQuiet()` guard branch.
- `util/long-press.ts` — `destroy()` detaching its listeners, and the `update()` method,
  which is part of the exported interface a consumer relies on.

### T-3 · Brittle test selector · `open`
The bare-id fallback assertion selects on Tailwind utility classes (`.min-w-0.truncate`)
with no testid anchor, so an unrelated layout tweak breaks it. Adding a testid to the
component is now an option (it wasn't when the finding was raised).

### T-4 · Known flakes · `open` · *re-run and move on*
- e2e auth/session family — `frontend/e2e/helpers/auth.ts:33`.
- `tests/model/test_search_index.py::test_string_properties_indexed_non_strings_ignored`
  (~0.8% failure rate; **root cause confirmed 2026-08-16, pre-existing on the tree before
  the metamodel commit-flow branch**: the test's `"123"` trigram probe is all-hex, so it
  collides with random UUIDv7 element ids at a measured ~0.29% rate — not a search-index
  bug, a fixture that shares an alphabet with the ids it's searching among).
- `tests/api/test_projects_wizard.py::test_wizard_create_reports_skipped_artifacts` —
  order-dependent, observed once on 2026-08-12 (`TypeError: string indices must be
  integers`), passes in isolation and on re-run. **Reconfirmed 2026-08-16, pre-existing**:
  flakes roughly 1 run in 30 even in isolation, so "passes in isolation" above was an
  under-sample, not a clean bill of health.
- `tests/api/test_exports_route.py::test_two_runs_at_one_rev_are_byte_identical` —
  a zip/xlsx determinism test, unrelated to validation rules. Flaked once on a
  full-suite run during the custom-validation-rules branch's work (2026-08-24),
  reran clean twice; not yet diagnosed.

### T-5 · a11y: HistoryNav announces a popup that can't be opened · `open`
The trigger keeps `aria-haspopup`/`aria-expanded` from bits-ui's `{...props}` spread while
`onkeydown={undefined}` removes bits-ui's keyboard open path — a screen-reader user is told
about a popup they cannot open. Primary navigation stays keyboard-reachable (native
`<button>` → `onclick` → `goBack()`). Note: keyboard *shortcuts* (Alt+arrows) were cut as
YAGNI by spec — the aria mismatch is a separate question.

### T-6 · `pointercancel` without `contextmenu` strands `fired` · `open` · narrow
`util/long-press.ts` — leaves `fired` stranded `true` until the next `pointerdown` resets
it. Judged outside the contract's scope when raised.

### T-7 · No e2e coverage for recent features · `open`
Live metamodel editing and the artifacts import/export flows have no e2e tests. Deferred
every time they've come up. **The metamodel diagram surface (P-9) joins them**: it is
unit-covered (yaml-edit round-trips, `diagram-build`, `arrange`, the state module's
rename deferral, the canvas and form components), but nothing exercises the gestures
end-to-end — drag a node → reload → position persisted; draw a connection → popover →
relationship in the YAML; rename in the form → cascade with comments intact; rebind →
positions survive under the new names. Those four are exactly the paths where the
frontend and the layout route have to agree, and they are currently verified only by a
manual browser pass. The 2026-08-20 metamodel-navigation features (LOD, hover
highlighting, type search, panel TOC/collapse) join this list — unit-covered, no e2e.
`ModelChangeDialog` (Compare… / Apply CR…, 2026-08-25) joins them on the same terms: the dialog,
`stageProposedOps`, the CR helpers and both routes are unit- and API-covered, but nothing
exercises pick a file → Preview diff → Replace → commit, or the multi-CR ordering and its 409,
against a real backend.

---

## 9. Operational / infrastructure

### O-1 · `.env.example` ships the lease mirror commented out · `open` · by design
`docker-compose` starts a `redis` service unconditionally, but `DATA_ROVER_REDIS_URL` is
commented out, so the container sits unused and the mirror code path gets zero incidental
exercise in local dev. Deliberate (enabling it by default would be a behaviour change) —
but worth revisiting once the mirror has soaked.

### O-2 · Redis holds PII and is unauthenticated in compose · `open` · documented
The mirrored payload carries lock tokens, holder user ids, holder emails and the resource
ids each user is editing, into a store compose exposes on 6379 with no auth. Mitigated:
a token is **not** a standalone capability — `release`, `renew` and `verify_held` all
require `le.holder == user.id`, so a stolen token is useless without authenticating as its
holder. Documented in the `redis_url` setting docstring; network isolation (or `rediss://`)
is the operator's job. Revisit if Redis ever leaves the private network.

### O-3 · `dr-tidy` does not lint or format `tests/` · `open` · *2026-08-26*
`core-format`/`core-lint` and their backend twins set `cwd` to the package directories, so
`ruff format`, `ruff check`, mypy and pyright all run over `src/data_rover/{core,api}` and never
see `tests/`. A badly formatted or lint-dirty test file passes the repo's own tidy gate, and the
gap is invisible — `dr-tidy` reports "All checks passed" either way. Every test file added since
has been formatted only because someone ran ruff on it by hand. Fix is a task (or a `cwd`) that
covers `tests/` too; the only decision is whether the type-checkers join ruff there, since the
test suite leans on fixtures pyright will have opinions about.

---

## 10. Deferred by explicit decision — **re-ask before starting**

These were declined by the project owner, not merely unscheduled. Several were declined
more than once. Treat starting one as a scope change that needs a fresh decision.

Two entries here were **superseded** on 2026-08-12 by the owner's own feature notes — they
are struck below and now live in §2. A decision recorded here is not permanent; it just
can't be reversed by an implementer acting alone.

**Product / features**
- ~~**UI-assisted (form-based) metamodel editing**~~ — deferred during Phase 5
  brainstorming (Phase 5 is raw-YAML-only *by decision*, not omission).
  **Superseded 2026-08-12 → P-9.**
- **Initial-bind authoring in the metamodel editor** — the wizard/upload path was kept;
  the tab entry stays disabled with no metamodel bound.
- **Server-side drafts** — rejected in favour of localStorage.
- **Rename detection in the metamodel differ** — remove+add is the chosen identity rule.
- ~~**Hard-verify (token-required) rebind**~~ — honor-don't-require was chosen explicitly
  (spec 2026-08-10). **Reversed 2026-08-16** for the commit path only: the metamodel
  commit-flow feature flips the `mm` lease from honor-only to hard-verified at
  `POST /commits` for any batch carrying a `metamodel.*` op (spec
  `2026-08-16-metamodel-commit-flow-design.md` §3) — the honor-only contract existed
  specifically for the standalone `POST /metamodel/rebind` route, which has since retired.
  `POST /metamodel` and `DELETE /metamodel` keep the original honor-only
  `_peer_mm_conflict` check (`routes/metamodel.py`), since they're the only callers left of
  the old contract.
- **Real CR workflow**, **metamodel partial-edit ops**, **fine-grained ops inside artifact
  payloads** — out of scope per the artefacts revamp spec
  (`2026-07-29-artefacts-revamp-design.md:104`).
- ~~**Multiple named views**~~ — same spec, same non-goals list.
  **Superseded 2026-08-12 → P-8.**
- **Auto-placement of imported artifacts in the view; bundle folder placements** —
  declined twice. The bundle carries no placement data by design.
- **Stateful/staged import with a server-side token** — rejected; stateless re-send is
  the design.

**Architecture**
- **Redis-authoritative locking**, and **per-lease Redis structures** — both proposed and
  rejected in favour of the whole-set JSON mirror.
- **Redis persistence/volume in compose** — rejected: leases are TTL-bounded, so a Redis
  restart is indistinguishable from ordinary lease expiry.
- **Retiring the legacy `/model/ops`, `/model/undo` and direct-mutation routes** — the
  frontend has fully migrated off them, but the routes stay for tests/scripts pending a
  dedicated retirement phase.
- ~~**A `hasUnsavedWork()` term for the metamodel buffer**~~ — deliberate: the draft
  persisted to localStorage and survived navigation, so leaving lost nothing. (`isTabDirty`
  already had a metamodel arm.) **Reversed 2026-08-16**: the metamodel commit-flow feature
  makes the YAML buffer and the diagram's staged node moves commit CONTENT — they ride the
  next `POST /commits` batch exactly like a staged model/artifact/view op — so leaving the
  workspace now abandons an uncommitted batch just like the other three families, and
  answering differently for the metamodel term was the inconsistency, not the prompt.
  `state/unsaved.ts`'s `hasUnsavedWork()` now has a `getStagedMetamodelDepth() > 0` term.
- **Lint via a mode flag on `/metamodel/diff`**, and client-side YAML re-serialization for
  the baseline — both rejected in favour of the two dedicated routes.
- **A global store for dialogs, or route-based flows** — thin-client + component-local
  dialogs was chosen.

**Process / infra**
- ~~**Pushing to `origin`** — never asked for.~~ **Superseded 2026-08-26**: the owner asked
  for merge-and-push of `fix/ux-minor-batch`; `main` is pushed from here on.
- **Committing anything under `docs/superpowers/` or `.superpowers/`** — gitignored by
  convention.
- **AbortSignal plumbing for wizard uploads** — a cancelled submit still uploads the full
  multipart body and the server still imports an orphan project; the client only refreshes
  the list. Parked as out-of-cleanup-scope; raise as a candidate task rather than doing it
  silently.

---

## 11. Ideas — unvalidated, no commitment

- **Surface mirror health in the UI** — the realtime feed already carries lock events;
  a "leases are not being mirrored" indicator would make B-1's degradation visible to
  users rather than only to log readers.
- **Structured logging** — if B-1 is addressed anyway, JSON logs with a project/user
  context would make the multi-tenant backend far easier to debug than the current
  bare-string warnings.
- **Move the in-memory model into Redis?** (owner's open question, 2026-08-12) — my read
  is that it costs more than it buys *today*, but it's worth measuring rather than
  assuming. The whole Phase 3 design is "the `Session` is a **cache** over a durable
  journal", and the model is ~80 MB with a no-copy mutation boundary: reads are pointer
  derefs into live Python objects. Redis would put serialization on the read path for
  every element page, validation sweep and script cell — the exact hot paths the
  architecture was built to keep copy-free. It only starts paying off as part of R-1,
  where a *second instance* needs to see the same model; at that point the real question
  is which of shared-store vs. affinity-routing (the current plan) is cheaper, and that's
  a benchmark, not an opinion.
