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

Last updated: 2026-08-20 · repo head at time of writing: `main` at `1c95ba3`
(top-bar-restructure merged). The 2026-08-18 additions were a batch of owner notes: P-10
gained five concrete sub-items, P-15 → P-21 and U-9 are new, and T-1 was retired as stale
while verifying them. The 2026-08-19 additions are two more owner notes: P-22 (top bar
reorder + Model dropdown, a P-10 follow-up) and P-23 (Apply CR against the loaded model,
staged not committed, multiple CRs). A same-day pass on `feat/exporter-v2-phase1` (Exporter
v2 Phase 1) closes P-15.2, P-15.3, F-10, F-11 and C-10, leaves P-15.1 open (scheduled for
Exporter v2 Phase 3), and marks P-16 in progress. The 2026-08-20 metamodel-navigation pass
on `feat/metamodel-navigation` closes P-17 and P-18, and also ships the two owner-requested
navigation features (search autocomplete, collapsible panel) recorded in the same day's
spec.

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

### P-1 · Additional inputs for `value` / `step` entry points · `open` · design-heavy
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

### P-12 · Custom advanced validation rules · `open` · design-heavy
User-defined rules outside the metamodel, with arbitrary cross-element conditions
("if x has y, then z must have k"). One decision is already made for you: `IssueCategory`
splits STRUCTURAL (hard-fails a commit, 422) from CONFORMANCE (counted, never blocks).
User-authored rules almost certainly must be CONFORMANCE — a user rule that can block
every commit is a foot-gun with no escape hatch.

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

### P-15 · Custom export: picker, file name and folder paths · `open` · follows P-14
Three follow-ups on the shipped `custom_export` artefact (owner notes, 2026-08-18).
Independent of each other: .1 is frontend-only, .2 and .3 touch the wire schema and
`POST /exports/run`.

**P-15.1 · A real add-table picker.** `open` · scheduled: Exporter v2 Phase 3.
`Export/ExporterTab.svelte:393-407` (renamed from `CustomExportTab.svelte` in the rename
sweep) is a bare `<select>` with one `<option>` per table. Wanted: the visual treatment of
`ExportArtifactsDialog.svelte`, plus **search-by-name with autocomplete** the way element
search already works (`Sidebar/Search.svelte` is the typeahead to mirror). **F-11** (already
resolved, see below) lived in the same file's `usedRefs` filter, which forbade the duplicate
entries the server explicitly supports — that part is settled; only the picker's visual
treatment and search remain open here.

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

Both a custom export run (owner item 8.3) and an ordinary artefact **bundle** export
(item 10) should work against **staged, uncommitted** state. Today neither can: both read
committed `ArtifactRow`s on the request's DB transaction, so an artefact that has never
been committed cannot be exported at all, and an edited one silently exports its last
committed version — the worse of the two failure modes. This is a design question rather
than a patch: either the export routes learn to accept a client-supplied draft payload
(and then must not trust it any more than any other client input — see how
`importer.trust_artifacts` splits its two callers), or the client renders locally. Decide
it alongside P-15, since "a custom export whose entries are still drafts" is exactly the
case that prompted the note.

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
now go through the menu.

### P-23 · Apply CR against the loaded model, staged not committed, multiple CRs · `open` · design-heavy
Three changes to the Apply CR flow (owner notes, 2026-08-19):

- **No model file upload.** `ApplyCrDialog.svelte` today drives the legacy/inline mode of
  `POST /model/apply-cr` — the user picks a model file *and* a CR file, and the result is
  saved back out as a new file. Wanted: the CR applies to the **currently loaded model**.
  Half the answer already exists: the route's **session mode** (`routes/change_request.py`
  — `model` field absent) applies the CR to the session model. But session mode
  **replaces the session model and bumps `model_rev` directly**, which conflicts with the
  next point, so it is a starting point, not the answer.
- **Staged, not committed.** After apply, every change the CR produced should land in the
  **staged buffers** (the client's checkout/commit flow), for the user to review and
  commit — not as an already-durable mutation. That means the CR has to come back to the
  client as **op proposals** (the `OpIn` vocabulary) rather than being applied
  server-side — closer in spirit to how snippet runs *propose* ops than to today's
  apply-cr. Probably a preview/dry-run shape: server applies the CR transiently, derives
  the op batch + conflicts, rolls back, and the client stages the ops.
- **Multiple CRs at once.** Apply several CR files in one go. Needs a decision on
  ordering and cross-CR conflict semantics (two CRs touching the same element: sequential
  apply with the second seeing the first's result, or reject as a conflict?).

Adjacent to (but not the same as) the **"Real CR workflow"** entry in §10's deferred
list — that was the full authoring/review lifecycle; this is a UX + staging rework of
the existing apply endpoint. Still worth a re-ask if scope creeps toward workflow.

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

### U-3 · Snippet autocomplete: Tab doesn't accept the first suggestion · `open`
`frontend/src/lib/components/Snippet/` (CodeMirror). Wanted: Tab accepts the top
completion.

### U-4 · Snippet autocomplete is not type-aware · `open`
Ctrl+Space offers the same generic completion set regardless of the receiver's type.
Making it type-aware means the client needs a model of the facade's shape — the facade is
documented in `src/data_rover/core/script/README.md`, so the open question is whether the
client hardcodes that model or the server exposes it (the latter keeps them from drifting).

### U-5 · Relationship details panel doesn't show source and destination · `open`
Both should be listed and **clickable** (navigate to that element's details).
`frontend/src/lib/components/Inspector.svelte` + `Inspector/RelationshipsList.svelte`.

### U-6 · Element-valued properties render a name but aren't clickable · `open`
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

### U-9 · Commit panel content overflows its bounds · `open` · *2026-08-18*
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

### F-14 · Discarding staged metamodel moves doesn't re-derive the canvas · `open` · cosmetic · *2026-08-16*
"Discard metamodel changes" in the DiffDrawer's Metamodel section wipes the staged ops
(`discardStagedNodeMoves`), so the next commit is correct, but does not re-run the diagram's
position derivation — a dragged node visibly stays at its dragged position until the
metamodel tab is closed and reopened (which re-derives `_positions` from the baseline +
now-empty staged overlay). Purely visual; no staged data survives the discard.

### F-15 · Metamodel diagram navigation — deferred refinements · `open` · *2026-08-20*
Eleven findings triaged LEAVE by the final review of `feat/metamodel-navigation` (the branch
that closed **P-17**/**P-18** and shipped the type search and the collapsible TOC panel). None
is a correctness bug; each is a refinement the shipped surface can carry as-is.

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
- "Imported 1 artifacts" — unpluralized default message (**test-pinned**, so fixing it
  requires touching the test).
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

### K-6 · History diff is slow on a big model · `open` · owner-reported · *2026-08-12*
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

---

## 8. Test gaps, flakes, and a11y

### T-2 · Untested branches · `open`
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
- **Pushing to `origin`** — never asked for. `main` is 67+ commits ahead deliberately.
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
