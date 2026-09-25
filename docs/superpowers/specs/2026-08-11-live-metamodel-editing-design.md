# Live metamodel editing (Phase 5)

**Date:** 2026-08-11
**Status:** approved (brainstorm 2026-08-11)

## Context

Phase 5 of the artefacts-revamp program: replace the SwapMetamodelDrawer with a
live, in-app metamodel editor. Phase 4 (spec
`2026-08-10-metamodel-lease-structural-diff-design.md`) deliberately built its
lease and diff logic outside the drawer so this phase could delete it:

- `POST /metamodel/diff` returns the structural + validation-impact preview.
- `POST /metamodel/rebind` is the owner-only, journaled, quiet-project landing
  path; it (and upload/clear) honors the `mm` lease honor-don't-require.
- `frontend/src/lib/state/metamodel-lease.svelte.ts` is the reusable `mm`
  lease lifecycle (generation-guarded).
- `frontend/src/lib/components/MetamodelStructuralDiff.svelte` is the
  standalone diff renderer, minimally styled on purpose — this phase restyles
  it in place.
- Rebind persists the ORIGINAL request blob (Correction A), so the stored
  `MetamodelRow.blob` is always the author's source, comments and formatting
  intact.

## Decisions (brainstorm outcomes)

1. **Scope: raw YAML editing only.** UI-assisted form editing (types/
   properties/enums via forms) is a later phase on the same seams.
2. **Host surface: a singleton `metamodel` workspace tab** (new tab kind
   alongside `navigation | table | snippet`; no `artifactId`; opening again
   focuses the existing tab). Opened from the TopBar project menu — "Swap
   Metamodel" becomes "Edit Metamodel" — and the command palette.
3. **Feedback is tiered**: debounced cheap lint (`POST /metamodel/lint`,
   parse + schema only) while typing; full `POST /metamodel/diff` only on an
   explicit "Preview changes"; rebind to land. No per-keystroke model
   validation.
4. **The `mm` lease is acquired on first edit** (owner-gated), not on tab
   open and not at preview. Released on tab close, unmount, discard, and
   after a successful rebind. Conflict → read-only with holder email.
5. **SwapMetamodelDrawer is deleted this phase.** One surface; the lease
   module and structural-diff component survive it as designed.
6. **Drafts persist to localStorage** per project; restored with a notice on
   reopen. The lease does NOT survive a refresh — it re-acquires on the next
   edit.
7. **API shape A/A**: new `GET /metamodel/raw` (stored source blob verbatim)
   and new `POST /metamodel/lint` (parse/schema check, structured errors).
   No mode flags on existing routes; the Phase 1–4 backend contract stays
   frozen (ADD only).
8. **Initial-bind authoring is out of scope**: the tab entry stays disabled
   while no metamodel is bound (parity with today's Swap entry); a fresh
   project binds its first metamodel via the wizard/upload path.

## UX flow

Layout: CodeMirror YAML editor (new `@codemirror/lang-yaml` dependency) as
the main pane; collapsible preview panel; toolbar with Preview, Rebind,
discard-draft, and the holder/conflict banner.

Roles: **owners edit; editors and viewers get a read-only viewer** of the
current metamodel source (new capability — today non-owners cannot see the
YAML at all). No preview/rebind controls for non-owners: only owners can
land a rebind, so a non-owner "preview" of an unedited buffer is pointless.

Owner session:

1. Tab open → `GET /metamodel/raw` fills the buffer (baseline).
2. First keystroke that diverges from baseline → `acquireMetamodelLease()`.
   Typing is not blocked while the acquire is in flight. On conflict the
   editor becomes read-only with "Metamodel locked by <email>" and a retry
   affordance; characters already typed are KEPT in the buffer (and the
   localStorage draft) — they are local-only and become editable again once
   a retry acquires the lease.
3. While typing → debounced `POST /metamodel/lint`; diagnostics render in
   the CodeMirror lint gutter (best-effort line positions).
4. "Preview changes" → `POST /metamodel/diff`; the panel shows the restyled
   `MetamodelStructuralDiff` plus the validation-impact section (counts
   line, now-failing / now-passing lists, CAP-200 truncation — lifted from
   the drawer).
5. "Rebind" (enabled when the project is quiet AND a preview has run on the
   CURRENT buffer — any further edit invalidates the preview and disables
   Rebind until re-previewed, so unreviewed changes can never land) →
   `POST /metamodel/rebind` with optional commit message and
   `base_rev = model_rev`. On success: refresh metamodel state
   (`setMetamodel`, issues, summary), baseline := landed blob, draft
   cleared, lease released, tab stays open.

Dirty buffer mirrors to localStorage (debounced). Reopening the tab with a
stored draft restores it with a "draft restored" notice and a discard
action; the lease is NOT auto-acquired on restore — it re-acquires on the
next actual edit (or an explicit resume action), so a restored draft under a
peer's lease opens read-only rather than fighting.

Tab close AND component unmount both release the lease — fixing the
drawer's known unmount-without-close lease leak pattern.

## Backend changes

Two new routes in `routes/metamodel.py`; nothing else changes. No Alembic
migration, no lock-table changes, no changes to rebind/diff/upload.

### `GET /metamodel/raw`

Response `{blob: str, source: "stored" | "serialized"}`.

Serves the project's current `MetamodelRow.blob` verbatim (model row →
`metamodel_id` → `content.get_metamodel_row`). If the session holds a
metamodel but no durable row resolves (legacy/test sessions), degrade to
serializing `session.metamodel` with `source: "serialized"` — house
"degraded, never failed" stance. 404 only when no metamodel is bound at
all.

### `POST /metamodel/lint`

Response `{ok: bool, errors: [{message: str, line: int | null,
column: int | null}]}`.

Body handling mirrors `_read_metamodel_blob` (YAML or JSON body). Runs
`load_metamodel_str` only — never touches the model, no `write_mutex`,
cheap enough for debounced calls. YAML syntax errors carry line/column from
the `yaml` error marks (1-based lines); `MetamodelError` schema failures
generally carry message-only (null position). **Always 200** — a failed
parse is the result, not an error.

Not added to `authz._READ_ONLY_POST_SUFFIXES`: it is only reachable from
the owner-gated editing flow, and non-viewer members can POST anyway.

## Frontend changes

### `state/metamodel-editor.svelte.ts` (new)

Singleton editor state, re-exported through the `$lib/state` barrel. Owns:
baseline blob, buffer, derived `dirty`, lint diagnostics, preview result,
rebind status, draft persistence. **Composes** the existing
`metamodel-lease` module — first divergent edit calls
`acquireMetamodelLease()`; it never re-implements lease logic and adds no
competing generation guard on the lease (the lease module's guard is the
only one for that concern; the editor module guards only its own
fetch/lint/preview async against tab-close with its own generation).

### Components (new folder `components/Metamodel/`)

- **`MetamodelTab.svelte`** — workspace tab host: toolbar, editor pane,
  preview panel, read-only/locked/draft-restored states. Registered in the
  workspace tab renderer for the `metamodel` kind.
- **`MetamodelYamlEditor.svelte`** — thin CodeMirror host (`basicSetup` +
  `@codemirror/lang-yaml` + lint gutter fed via `setDiagnostics` from
  server lint results). Its own component, NOT a reuse of
  `Snippet/CodeEditor.svelte`, which is Python-specific (completions,
  hover docs, run keymap); shared styling conventions, not shared code.
- **`MetamodelPreviewPanel.svelte`** — hosts the restyled
  `MetamodelStructuralDiff` plus the validation-impact rendering moved out
  of the drawer.

`MetamodelStructuralDiff.svelte` is restyled **in place** — no fork.

### Workspace + entry points

- `metamodel` joins the tab-kind union in `state/workspace.svelte.ts` with
  a `PREFIX` entry; `openTab` dedupes it as a singleton (no artifactId).
- Tab-close and unmount paths call `dropMetamodelLease()` when held.
- TopBar: `swapOpen`/drawer wiring replaced by an "Edit Metamodel" action
  opening the tab (still disabled when `metamodel === null`). Command
  palette entry updated.
- **Deleted**: `SwapMetamodelDrawer.svelte` and its test file.

### Draft persistence

localStorage key scoped by project id; written debounced while dirty;
cleared on rebind success and explicit discard.

## Error handling

- **Lint call fails** (network/5xx): gutter clears, editing continues —
  lint is advisory, never blocking.
- **Preview 422** (unparseable candidate): preview panel shows "candidate
  invalid" with the server message; buffer stays editable.
- **Rebind 409** — the drawer's three structured branches move verbatim:
  `metamodel locked` (+ holder email), `active locks` (not quiet), stale
  `base_rev` ("re-run preview"). **Rebind 422**: invalid candidate.
  Anything else: generic "no changes were applied".
- **Lease conflict on first edit**: read-only banner with holder email;
  retry re-attempts acquire.
- **Raw fetch fails on tab open**: tab-level error state with retry;
  nothing else in the workspace is affected.

## Testing

- **API** (`tests/api/`, hermetic SQLite): `GET /metamodel/raw` returns the
  stored blob byte-identical after upload and after a rebind (Correction A
  made observable); `serialized` fallback; 404 when unbound.
  `POST /metamodel/lint`: valid → `ok: true`; YAML syntax error →
  line/column populated; `MetamodelError` schema failure → message with
  null position; always 200.
- **Frontend** (vitest; `mount`/`flushSync`/`unmount` — no
  testing-library): editor state module (dirty→acquire, conflict→
  read-only, draft write/restore/clear, preview + rebind flows incl. the
  three 409 branches, generation guard on tab close mid-flight);
  `MetamodelYamlEditor` diagnostics wiring; `MetamodelTab` render states
  (read-only role, locked banner, preview panel, draft notice); workspace
  singleton-tab behavior; TopBar entry change. Drawer tests deleted with
  the drawer.
- No new e2e (program-consistent).

## Out of scope

- UI-assisted (form-based) metamodel editing — a later phase.
- Initial-bind authoring in the editor (wizard/upload path remains).
- Server-side drafts; AbortSignal plumbing.
- Rename detection in the differ (settled: remove+add).
- HistoryDrawer consumption of `GET /commits/{rev}/diff` (stays parked).
- Rebind revert (Phase 8); Redis-mirrored locks (Phase 7).
- Hard-verify (token-required) rebind — honor-don't-require stands.
