# Code Execution M1 — Frontend Design Spec

Date: 2026-07-17
Status: approved (user-reviewed brainstorm; decisions D1–D6 below answered by
the user before this spec was written)
Parent spec: `2026-07-17-code-execution-design.md` (§5 facade UX, §7 console &
frontend). Backend counterpart: merged to `main` as `48a0901` (run/lint/cancel
routes, WASM runner, `code_snippet` artifact kind, server-derived
`entry_points`).

## 1. Overview

The M1 frontend gives users an in-browser Python snippet workspace against the
live MBSE model: a CodeMirror editor with server-side lint diagnostics, a
console that runs snippets through `POST /snippets/run` and renders
stdout/result/error, an ops-preview list whose "Stage ops" folds the run's
dry-run op batch into the **existing** staged-edits buffer (from there the
normal review/commit flow applies, indistinguishable from manual edits), and
`code_snippet` artifacts saved/listed/opened exactly like navigations and
tables.

### Goals

- Write, lint, run, and iterate on Python snippets without leaving the
  workspace.
- Make snippet-proposed model edits reviewable and committable through the
  existing staged-buffer + lock + DiffDrawer machinery — no parallel apply
  path.
- Persist snippets as `code_snippet` artifacts with the same draft-tab →
  save → sidebar-library lifecycle as navigations/tables.
- Honest UX around the M1 backend's real semantics: no-op cancel, `stale`
  runs, fail-fast concurrency, truncation.

### Non-goals (M1)

- Table `ScriptColumn` / navigation `ScriptStep` embedding UIs (M2/M3) — but
  the entry-point plumbing (`value`/`step` test runs, header badges) lands now.
- Streaming console output, run history, snippet caching, a facade docs panel
  (M4).
- Real cancellation (backend M2) — the Stop button is wired but honest about
  the timeout.
- Any change to the run/lint/cancel API contract. The single sanctioned
  backend change is D6 (additive `entry_points` on artifact headers).

## 2. Decisions (user-answered, 2026-07-17)

- **D1 — Editor: CodeMirror 6.** New deps under `frontend/`: `codemirror`,
  `@codemirror/lang-python`, `@codemirror/lint`. Monaco rejected (weight,
  worker friction with the static Vite build); textarea rejected (no
  diagnostics UX).
- **D2 — Inline runs allowed.** A draft (unsaved) snippet tab can run via
  `SnippetRunIn.code`; saving binds the tab to an artifact. Runs always send
  the **current editor code** (inline), even when the tab is bound to an
  artifact — what you see is what runs; `artifact_id` runs are for embedding
  contexts (M2/M3).
- **D3 — Honest Stop.** Stop calls `POST /snippets/cancel`, transitions the
  run to `stopping`, shows "Stopping — run ends at wall timeout", and
  discards the eventual response. Never pretends the run died instantly.
- **D4 — Element context picker = selection + search.** A "Use current
  selection" affordance plus a fuzzy-search input reusing
  `GET /model/elements?q=`. No full picker-dialog reuse in M1.
- **D5 — Snippet workspace surface = third dynamic tab kind** (`'snippet'`),
  mirroring `navigation`/`table` (draft tabs, `bindTabToArtifact`, per-project
  persistence). Presented as a recommendation, unopposed.
- **D6 — Sidebar entry-point badges via a backend header change.**
  `ArtifactHeaderOut` gains a server-derived, optional `entry_points` field
  populated for `code_snippet` rows (extracted from the stored payload, which
  the server already owns/derives). Explicit user scope decision — chosen over
  lazy payload fetches because the M2/M3 pickers filter by entry point and
  will want it anyway. Additive and backward-compatible; does not touch the
  snippet run/lint/cancel contract.

## 3. Backend addition (D6)

- `schemas.py::ArtifactHeaderOut` — add `entry_points: list[str] | None =
  None` (`None` for non-snippet kinds; the derived list for `code_snippet`).
- `routes/artifacts.py` — header construction (list + the header part of
  `ArtifactOut`) populates it from `payload["entry_points"]` for
  `kind == "code_snippet"`. The value is already server-derived on every
  create/update by `_apply_derived_metadata`; this only surfaces it.
- Tests: extend the existing artifact-route tests (list shows
  `entry_points` for a snippet row, `None`/absent for a navigation row;
  update recomputes it).
- Frontend `ArtifactHeader` zod schema gains the matching optional field.

## 4. Surface & navigation

- **`workspace.svelte.ts`**: extend `DynamicTab.kind` union and `PREFIX` with
  `snippet: 'snip'`. Everything else (draft ids, re-key on save, localStorage
  persistence, close/retitle) comes free. The `initWorkspaceTabs` legacy
  default (`kind ?? 'navigation'`) stays as-is.
- **`ArtifactsSection.svelte`**: third `SECTIONS` entry — `kind:
  'code_snippet'`, title "Snippets", singular "snippet", icon `FileCode`
  (lucide), `open` → `openArtifactTab('snippet', …)`. New/open/rename/delete/
  drag-to-view are config-driven and need no new logic. Rows render
  entry-point badges (small `value`/`step` chips from the D6 header field;
  `script` is universal and not badged).
- **No one-click execution** (parent spec §7/§9): sidebar and view-tree rows
  open the editor tab; the only run affordance is inside the tab, next to the
  visible code.
- **Workspace routing**: `Workspace.svelte` renders `SnippetTab` for
  `kind === 'snippet'` tabs, mirroring how navigation/table tabs mount.

## 5. Components

### `CodeEditor.svelte` (thin CodeMirror 6 wrapper)

- Python language mode, standard basic setup, controlled `code` in /
  `onChange` out, and a diagnostics prop rendered through `@codemirror/lint`'s
  `setDiagnostics` (severity mapping: lint `error` → CM `error`, `warning` →
  `warning`). Exposes a "go to line" imperative hook for traceback links.
- Deliberately logic-free: CM6 does not meaningfully run under happy-dom, so
  all testable behavior (debounce, state, mapping) lives outside it.

### `SnippetTab.svelte`

Editor above a console panel. Console contents:

- **Toolbar**: Run (and Ctrl/Cmd+Enter inside the editor), Stop (visible while
  `running`/`stopping`), entry selector (`script` default; `value`/`step`
  options enabled only when lint's `entry_points` includes them), Save /
  Save-as-artifact (name prompt on first save, mirroring nav/table), dirty
  marker.
- **Element context row** (only when entry is `value`/`step`): shows the bound
  element (name + type), "Use current selection" button (reads the workspace
  selection), and a fuzzy-search input (`GET /model/elements?q=`, same
  debounce/shape as existing search affordances) to bind a different element.
  Run is disabled in `value`/`step` mode until an element is bound.
- **Output panes**: stdout (monospace, preserved whitespace), `result_repr`
  (when non-null), error pane (kind badge — `syntax`/`runtime`/`timeout`/
  `memory` are the kinds the M1 runner actually produces; `cancelled`/`limit`
  render generically if they ever appear — message, collapsible traceback
  with `File "<snippet>", line N` references clickable → editor line),
  `duration_ms`, `truncated` indicator ("output truncated at server limit").
- **Stale banner**: when the last result has `stale: true` or its `model_rev`
  no longer equals the store's current rev — "The model changed during/after
  this run; results may be out of date. Re-run before staging."
- **Ops preview + Stage**: a list of the run's proposed ops (one row per op:
  kind, target type/name or id, compact property summary) and a
  "Stage ops (N)" button — behavior in §7.

## 6. State & API client

### `lib/api/snippets.ts`

`runSnippet(body)`, `lintSnippet(code)`, `cancelSnippet(runId)` — zod schemas
mirroring `SnippetRunIn`/`SnippetRunOut`/`SnippetLintOut`/`SnippetErrorOut`
field-for-field (`ops` reuses the existing `Op` wire types from
`state/ops.ts`; they are already identical to the backend's `OpIn`).

### `lib/state/snippet-editor.svelte.ts`

Mirrors the navigation-editor store pattern (per-tab keyed state, generation
counters, reset hooks). Component-local state was considered and rejected: it
breaks the established convention and is untestable in vitest. Per `tabId`:

- **Draft**: `{ code, artifactId, artifactRev, savedCode }`; dirty ⇔
  `code !== savedCode`; `isArtifactDirty('code_snippet', id)` extended so the
  sidebar `*` marker works. Save-conflict marker on a 409 (peer bumped
  `artifact_rev`), like nav/table drafts.
- **Lint**: debounced (~300 ms) `POST /snippets/lint` on every edit;
  `{ diagnostics, entryPoints }`. A generation counter drops stale responses.
  Entry-point availability in the toolbar derives from this (live), not from
  the saved artifact.
- **Run**: `{ phase: 'idle' | 'running' | 'stopping', runId, result:
  SnippetRunOut | null }`. `run()` generates `run_id = crypto.randomUUID()`,
  sends `{ run_id, code, entry, element_id? }`, and installs the response only
  if its generation is current (a late response after Stop/close/newer-run is
  discarded). `stop()` calls cancel, sets `stopping`; the run's eventual
  response is dropped and phase returns to `idle` with a "stopped" notice.
- **Element context**: `{ elementId, label }` per tab, set by the picker row.
- **Error surfaces**: HTTP 429 → "Another run is already in progress" notice
  (per-user fail-fast cap, no queuing); 503 → "Code execution is unavailable
  on this server" (runner not booted — guest binary absent); network/5xx →
  generic run-failed notice. All non-2xx leave the last successful result
  visible.
- `closeDraft`/`resetSnippetEditors` clear every per-tab key, cancel timers,
  bump generations (nav-editor discipline; nothing leaks across projects).

## 7. Stage-ops flow (the one new mechanism)

On "Stage ops":

1. **Remap temp ids.** The facade numbers temp ids per run (`tmp_1`, …), so
   two staged batches would collide. Build `mapping = { tmp_N → createTempId() }`
   for every `create_*` op in the batch, then rewrite each op's `temp_id`,
   `source_id`, `target_id`, and ref-shaped property values (reusing
   `remapValue`/`remapProperties` from `state/remap.ts`).
2. **Prefetch pre-state.** `ensureElement`/`ensureRelationship` every
   `update_*`/`delete_*` target so `emit`'s optimistic journal records real
   pre-state (targets may be uncached — the snippet saw the server model, not
   the client cache).
3. **Acquire locks all-or-nothing** through the existing edit-gate
   (`editLock` for `update_element`; `deleteLock` for `delete_element`;
   `connectLock(source, target)` for `create_relationship`; relationship
   update/delete and element create per the edit-gate's existing intent
   mapping). Any refusal → stage nothing, standard lock-conflict notice.
   Temp-id endpoints need no lock (same rule as the backend's
   `required_locks`).
4. **`emit()` each op in order.** From here the batch is indistinguishable
   from manual edits: client-side undo, per-element revert, DiffDrawer
   preview, commit, lock release.
5. **Gating.** Stage is disabled (with the stale banner as explanation) when
   the result is stale per §5; re-checked at click time against
   `getModelRev()`. Stage is hidden for viewers (`canEdit() === false`) —
   they can still run/lint. After a successful stage, the ops-preview shows
   "staged" and the button disables until the next run (prevents accidental
   double-staging of the same batch).

## 8. Artifact save

- `artifacts.svelte.ts` gains `createCodeSnippetArtifact(name, { schema_version,
  language: 'python', code })` mirroring the nav/table creators (create →
  `loadArtifacts()` → return). Updates go through the existing
  `updateArtifact` with `artifact_rev`.
- The client **never sends `entry_points`** (server-derived; a sent value is
  ignored/overwritten) and always adopts the response's payload +
  header `entry_points`.
- First save of a draft: create → `bindTabToArtifact(tabId, id)` → adopt
  `savedCode`/`artifactRev`. Subsequent saves: update; 409 → save-conflict
  marker with the same resolution UX as nav/table (keep mine / take theirs).

## 9. Error handling summary

| Situation | Surface |
| --- | --- |
| Lint diagnostics | Editor gutter + squiggles; warnings never block run/save; syntax errors don't block Run (the run reports `kind="syntax"` authoritatively) |
| Run `error.kind` syntax/runtime/timeout/memory | Error pane with kind badge, message, collapsible traceback, editor line links |
| `stale: true` / rev moved | Banner + Stage disabled until re-run |
| `truncated: true` | Inline indicator on stdout/result pane |
| HTTP 429 (concurrency cap) | Transient notice, run not started |
| HTTP 503 (runner absent) | Persistent console notice |
| Stop pressed | `stopping` state, honest copy, response discarded |
| Lock conflict on stage | Existing lock-notice, nothing staged |
| Artifact save 409 | Save-conflict marker, nav/table resolution UX |

## 10. Testing

- **vitest + MSW** (patterns from existing state tests):
  - `snippet-editor`: run happy path; late-response discard (generation);
    stop → discard; 429/503 notices; lint debounce + stale-lint discard;
    entry-point gating; element-context binding.
  - Stage-ops: temp-id remap correctness (cross-referencing create/connect
    batch), ensure-prefetch, lock-refusal stages nothing, stale gating,
    staged ops land in `getStagedOps()` and optimistic caches.
  - Artifacts: `createCodeSnippetArtifact`, save/409-conflict, header
    `entry_points` parsing.
  - Components: console rendering states (result/error/stale/truncated/
    stopping) with a mocked editor.
- **Playwright e2e** (`snippet-flow.spec.ts`, existing helper pattern —
  cookie login, `default` project): new snippet → type code with a lint-warn
  import → gutter diagnostic appears → fix → Run (real backend; WASM runner
  if the guest binary is fetched, else the spec is skipped with a clear
  message — same conditionality as the backend integration test) → stdout
  asserted → run a `dr.create` snippet → Stage ops → DiffDrawer → Commit →
  element visible in the tree.
- **Gates per task**: `cd frontend && npm test`, `npm run check`; e2e for the
  integration task; `pixi run tidy` (and `pixi run test-core` for the D6
  backend task) before finishing.

## 11. Out of scope / deferred

- M2/M3/M4 embedding + polish (parent spec §14); real cancel; run history;
  facade docs panel; streaming output.
- No new backend surface beyond D6. Deferred backend Minors from the M1
  backend arc stay deferred (e.g. `limit`/`cancelled` error kinds are never
  produced today — the console renders them generically if they ever appear).
