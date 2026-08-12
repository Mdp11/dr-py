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

Last updated: 2026-08-12 · repo head at time of writing: `a510171`

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

Test baseline on `main`: `core-test` 1739 passed / 29 deselected · `frontend-test`
1863 passed (193 files) · `dr-tidy` clean · Redis integration 3 passed.

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
Commit-history browser, revert-to-commit, optional strict mode. Two known blockers
already in the code: `/commits/revert` answers 409 across any range containing
**artifact ops**, and likewise across **metamodel rebind** ranges. Also folds in F-9
(HistoryDrawer consuming `GET /commits/{rev}/diff`), which has been parked three times.
Source: master spec §12; handoffs 2026-08-09 → 2026-08-11. Size: large.

---

## 2. Feature backlog — owner-requested

From the owner's running notes, merged 2026-08-12. These are **wanted**, not scheduled:
unscoped, unestimated, and most need a brainstorm or a spec before they're actionable.
Where the codebase already contains part of the answer, the item says so — several of
these are smaller than they look, and two turned out to be already shipped (see the end
of this section).

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

### P-9 · Metamodel visualization and editing from the frontend · `open` · **supersedes a prior decision**
Editing partly exists (the live YAML metamodel tab). The **UI-assisted/form-based**
half was explicitly deferred during Phase 5 brainstorming — this note supersedes that
decision. **Visualization** is entirely new and probably the bigger piece.

### P-10 · Top bar restructure · `open`
Main sections move to the top bar, and all editing moves inside tabs — so while creating
a navigation or editing a table column, element browsing and search stay usable.

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

### P-13 · JSON export: one file per base element, with a name template · `open`
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

### P-14 · New artefact kind: custom export · `open` · **needs brainstorming**
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

### B-2 · `to_leases` doesn't clamp restored lease lifetime against clock jumps · `open` · small
`lock_mirror.to_leases` computes `remaining = expires_at_epoch - wall_now` with no
ceiling. A backward NTP correction between mirror-write and restore yields a restored
lease living longer than `lock_ttl_seconds`; a forward jump silently drops live leases.
Parked during the final review because `to_leases` is a pure function and clamping would
give it a settings dependency — do it in `restore_leases` instead, where settings are
already reachable. Damage is bounded and self-heals at TTL.

### B-3 · Concurrent write-throughs can leave a phantom lease in the mirror · `open` · small
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

### B-4 · `dr:leases:{project_id}` has no deployment namespace · `open` · small
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

### U-1 · Issues tab has no per-category filter or summary · `open` · enhancement
Wanted: filter the issue list by error category, with a summary count per category across
the top. `frontend/src/lib/components/Workspace/IssuesPanel.svelte`. Note that issues
already carry `IssueCategory` (STRUCTURAL / CONFORMANCE) plus a per-validator identity, so
"category" needs a definition first — the two-tier commit gate is probably the wrong axis
for a user-facing filter; the validator (endpoint typing / multiplicity / facets /
uniqueness / …) is probably the right one.

### U-2 · xlsx autofit stops at a ceiling · `open` · **confirmed** · one-line
Not a bug — a deliberate cap. `AUTOFIT_MAX_PX = 300` (~43 characters) in
`src/data_rover/api/table_export.py:43`, applied at `:188` via `ws.autofit(AUTOFIT_MAX_PX)`
so one huge cell can't blow a column out (Excel's own hard cap is 1790px). Also relevant:
the export **deliberately ignores** each definition's on-screen `width_px`. Fix is a
choice, not an investigation — raise the constant, make it a setting, or honour per-column
widths for columns that ask for it.

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

### U-7 · Deleting a project leaves the card behind with a 500 · `open`
The card stays in the list with a 500 error under it; a page reload shows it correctly
gone — so the **delete itself succeeds** and the failure is in the response or in what the
client does after it. Start at `src/data_rover/api/routes/projects.py:231`
(`delete_project`) and `tenancy.py:242`, then
`frontend/src/lib/components/projects/ProjectCard.svelte:45`. Worth checking whether the
500 comes from a follow-up refresh hitting the just-deleted project rather than from
`DELETE` itself.

### U-8 · Issues tab stays empty after project creation until "Validate" is clicked · `open`
Creating a project validates everything and the bottom bar shows the error count, but the
Issues tab renders empty until an explicit **Validate**, which then reports the *same*
count. So the count and the list read from different places. Almost certainly the same
root cause as **F-4** (the issue list is only ever refreshed by `validate-action.ts`) —
fix them together in `frontend/src/lib/state/validation.svelte.ts`.

---

## 5. Diagnosed bugs — frontend

All diagnosed (not suspected) in prior sessions and judged non-blocking at the time.
**Unverified against current code.**

### F-1 · Stale preview re-arms Rebind · `open` · one-line fix · *2026-08-11*
`MetamodelTab.svelte`'s Rebind button isn't gated on `ed.previewing`, and
`previewMetamodelChanges` has no `_rebinding` guard. Sequence: Preview → Preview again
(in flight) → Rebind → rebind resolves and nulls `_preview` → the second preview resolves
and sets `previewCurrent` back to true. The panel then shows a diff computed against the
**pre-rebind** metamodel with no staleness warning, and Rebind re-arms for a redundant
identical-text rebind — which journals a commit and bumps `model_rev`.
Fix: `if (gen !== _gen || _rebinding) return;` after the diff await, or `|| ed.previewing`
on the button.

### F-2 · `Snippet/CodeEditor.svelte` external-replace echo bug · `open` · latent · *2026-08-11*
~lines 208-221 carry the identical bug that was fixed in `MetamodelYamlEditor`: an
external `code` replacement echoes back through `onChange` as a phantom edit. Unreachable
today because no caller replaces `code` post-mount — so this is a trap for the next
caller, not a live defect. The fix pattern already exists in `MetamodelYamlEditor`
(tag own transactions with an `externalReplace` annotation, filter in the
`updateListener`).

### F-3 · `quiet.ts` omits staged view depth from the quiet predicate · `open` · *2026-08-12*
`frontend/src/lib/state/quiet.ts:33` doesn't include `getStagedViewDepth()`, so a project
with only staged **view** changes reports as quiet.

### F-4 · Validation issue list never refreshes after a commit · `open` · *2026-08-12*
`frontend/src/lib/state/validation.svelte.ts` — only `validate-action.ts` refreshes it, so
the issue list goes stale after a commit lands.

### F-5 · `ExportArtifactsDialog` seed validation uses the unfiltered header set · `open` · latent · *2026-08-09*
`ExportArtifactsDialog.svelte:95` builds its membership set from the **unfiltered**
`getCommittedArtifactHeaders()`, not the `headers` derived at `:46`. A seed carrying an
unregistered-kind id (e.g. legacy `diagram`) enters `checked` while never rendering a row.
Unreachable today: the only seed caller sources ids from `dynamicTabs`, which exist only
for registered kinds.

### F-6 · New Project wizard close-reset misses `error`/`pending` · `open` · *2026-08-09*
`NewProjectWizard.svelte:34-44` clears five inputs plus `skipped`/`createdId`, but not
`error` (`:20`) or `pending` (`:21`) — so a failed attempt's error message reappears when
the dialog is reopened.

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

---

## 7. Cleanups & dead code

| ID | Item | Source |
|---|---|---|
| C-1 | `setMetamodelFilename` / `setFilename` in `frontend/src/lib/state/file.svelte.ts:27` — zero callers since the swap drawer was deleted. Delete both together. | 2026-08-11 |
| C-2 | Three `mm`-lease re-exports in `frontend/src/lib/state/index.ts` ~:205-207 — zero consumers (the editor imports them by relative path). | 2026-08-11 |
| C-3 | `_seed_view` conftest duplication across 4 test files — consolidate. | 2026-08-08 |
| C-4 | `routes/ops.py::undo` never migrated onto `_CommitUnwind` (the commit path's shared unwind helper). | 2026-08-09 |
| C-5 | `bindableOpen(get, set)` helper to collapse five store↔dialog open-mirrors. Declined once as a 5-file zero-behaviour-change refactor. | 2026-08-10 |
| C-6 | `SECTION_KINDS` / registered-kind selector duplicated across the export dialog, `ArtifactsSection`, `ImportArtifactsDialog` ICONS and the state unions — extract a shared selector. | 2026-08-10 |
| C-7 | `inspection-history.svelte.ts` — `backEntries`/`forwardEntries` are near-identical mirrored loops. | SDD ledger |
| C-8 | `HistoryNav.svelte` — ~30 duplicated lines between the Back and Forward dropdown blocks, differing in ~6 tokens. Awkward to extract because `bind:open` needs a distinct `$state` per menu. | SDD ledger |
| C-9 | `DropdownMenu.Item` uses `onclick` at 6 sites where `onSelect` is the repo majority (16 sites); `onSelect` also fires for keyboard selection. | SDD ledger |

---

## 8. Test gaps, flakes, and a11y

### T-1 · No `CommandPalette` test file exists at all · `open`
Nothing matching in `frontend/src/lib/components/__tests__/`. The palette's
`{#if canEdit()}` gating on `action:import-artifacts` ships with zero coverage.

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
  (~0.8% failure rate).
- `tests/api/test_projects_wizard.py::test_wizard_create_reports_skipped_artifacts` —
  order-dependent, observed once on 2026-08-12 (`TypeError: string indices must be
  integers`), passes in isolation and on re-run. Unconfirmed whether it predates that date.

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
every time they've come up.

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
- **Hard-verify (token-required) rebind** — honor-don't-require was chosen explicitly.
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
- **A `hasUnsavedWork()` term for the metamodel buffer** — deliberate: the draft persists
  to localStorage and survives navigation, so leaving loses nothing. (`isTabDirty` *does*
  have a metamodel arm.)
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

- **Key-prefix setting for the lease mirror** (see B-4) — turns a documented footgun into
  a configuration knob, and is a prerequisite for a shared-Redis multi-deployment setup.
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
