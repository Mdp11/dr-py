# Embedded snippet test panel

**Date:** 2026-07-21
**Status:** approved, ready for planning
**Area:** `frontend/src/lib/components/Snippet/`, `frontend/src/lib/components/{Table,Navigation}/`

## Problem

A saved `code_snippet` artifact can be run interactively from the Snippet
workspace tab: bind one or more elements, hit Run, read stdout / the result
repr / the traceback. An **embedded** snippet cannot. Embedded snippets are the
ones reached through `SnippetSourceEditor` — a table script column
(`ScriptColumnEditor`) and a navigation script step (`ScriptStepRow`) — and
there the user writes `value(elements)` / `step(el)` blind, saves the column or
step, and infers correctness from whatever the table or the navigation result
dock ends up showing. A failing snippet surfaces as an error cell or a pruned
chain, several layers away from the code that caused it.

This spec adds a **Test** panel to the embedded editor: bind elements the same
way the Snippet tab does, run, and read the result in place.

## What already exists (and is therefore not in scope)

The backend needs no changes. `POST /snippets/run` (`api/routes/snippets.py`)
already:

- accepts **either** inline `code` **or** a saved `artifact_id`
  (`SnippetRunIn._exactly_one`),
- accepts `entry: "script" | "value" | "step"` plus `element_ids`, and
  enforces the count rules in the request schema — `value` requires ≥ 1 id,
  `step` requires exactly 1 (`SnippetRunIn._entry_context`), so a bad request
  422s before a sandbox instance is consumed,
- is listed in `authz._READ_ONLY_POST_SUFFIXES`, so a **viewer** may test a
  snippet, and
- reads `session.model` without the write mutex and reports
  `stale = start_rev != end_rev`.

The element context a test run simulates is faithful: a script column evaluates
`script.call(code, "value", roots)` where `roots` are the row's
source-resolved elements (`core/table/evaluate.py`), and a script step calls
`step(el)` per frontier element. "Pick some elements, run `value()`" is exactly
one row's evaluation.

This is a **frontend-only** feature.

## Design

### Placement

The panel lives **inside** `SnippetSourceEditor`, below the ref/inline mode
toggle and the code editor — a collapsed `Test` disclosure that expands to an
element-binding row, a Run button, and a result view. The code stays visible
while testing, which is the point: these editors are narrow side panels used
while iterating on a formula.

```
┌ script column ─────────────┐
│ [saved][inline]            │
│ ┌ code ──────────────────┐ │
│ │ def value(elements):   │ │
│ │     return ...         │ │
│ └────────────────────────┘ │
│ [▸ Test]                   │
│ Elements: [Bus 12 ×] [+ 🔍]│
│ [Run]        ready · 12ms  │
│ ┌ result ────────────────┐ │
│ │ ['A', 'B']             │ │
│ └────────────────────────┘ │
└────────────────────────────┘
```

The panel appears in **both** modes. In `inline` mode the run sends `code`; in
`saved` mode it sends `artifact_id`. Saved mode is nearly free (the API already
takes an artifact id) and closes a real gap: verifying that the snippet you
just picked from the dropdown behaves correctly *in this column*, without
opening its workspace tab.

### State ownership

Run state is **component-local** to a new `SnippetTestPanel.svelte`: plain
`$state`, a `runSeq` generation counter, and an `onDestroy` that bumps it so an
in-flight response cannot write to an unmounted panel. This mirrors what
`SnippetSourceEditor` already does for its debounced lint — the precedent is
one file up.

Two alternatives were rejected:

- **A keyed store** (`snippet-test.svelte.ts`) would let a result survive
  collapsing and reopening the panel, but it needs a caller-supplied key, and a
  navigation script step is identified only by its index in the step array.
  That key shifts when a step is reordered or removed, silently re-attaching
  one step's result to another. Real bug surface for a small win.
- **Reusing `snippet-editor.svelte.ts`'s run functions** is worse still: they
  are welded to `_drafts`, tab ids, and the save/rekey lifecycle. Generalizing
  that load-bearing M1 module for a scratch panel is not worth it.

The consequence — collapsing the panel discards the last result — is accepted.
It is a scratch test, not a saved artifact.

Multiple panels can be mounted at once (a table with several script columns, a
path with several script steps). Component-local state handles that with no
keying scheme at all.

### Components

#### 1. `ElementContextRow.svelte` → controlled

Today it reads and writes the tab-keyed store directly (`getSnippetRun(tabId)`,
`addSnippetElement(tabId, …)`, `removeSnippetElement`, `clearSnippetElements`).
Change its props to:

```ts
{
  entry: 'value' | 'step';
  elements: SnippetBoundElement[];
  onAdd: (id: string, label: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}
```

Its component-local debounced fuzzy search stays exactly as-is, as does its
read of the *global* selection stores (`getSelection`, `getMultiSelectedIds`)
behind **Use current selection** — those are genuinely global, not tab state.
The `step`-replaces / `value`-appends rule moves from the store's
`addSnippetElement` into the two callers' `onAdd` handlers.

`SnippetTab` passes store-backed props; `SnippetTestPanel` passes its local
`$state`. One component, identical mental model in both places.

#### 2. `SnippetConsole.svelte` → split

Extract a pure `SnippetResultView.svelte` over props:

```ts
{
  phase: SnippetRunPhase;
  notice: string | null;
  result: SnippetRunOut | null;
  stale: boolean;
  canStage: boolean;
  onGoToLine: (line: number) => void;
}
```

It renders what `SnippetConsole` renders today: the running/stopping spinner,
the notice line, the stale banner, stdout, the result repr, the
duration/truncated footer, the error box with clickable traceback frames
(reusing `snippet/console-view.ts`'s `errorKindLabel` / `tracebackLines` /
`isResultStale` / `opSummary`), and the op list.

`SnippetConsole.svelte` stays as the thin store-bound wrapper that owns
staging: it keeps `stage()`, `stageError`, and the Stage button, and passes
`canStage`.

#### 3. New `SnippetTestPanel.svelte`

Props: `{ snippet: SnippetSource; entry: BoundEntry; entryPoints: string[] }`.

Owns `open`, `elements`, `phase`, `result`, `notice`, `runSeq`. Renders the
disclosure, `ElementContextRow`, the Run button, and `SnippetResultView` with
`canStage={false}`.

Run sends:

```ts
{
  run_id: crypto.randomUUID(),
  ...(snippet.definition ? { code: snippet.definition.code } : { artifact_id: snippet.ref }),
  entry,
  element_ids: elements.map((e) => e.id)
}
```

Error mapping matches `runSnippetTab` verbatim so the vocabulary is consistent
across the app:

- `429` → "Another run is already in progress — wait for it to finish."
  (`snippet_per_user_concurrency` defaults to 1, so testing while a console run
  is live is a normal occurrence, not a defect.)
- `503` → "Code execution is unavailable on this server." (no guest binary
  fetched → `main._boot_script_runner` leaves the runner `None`.)
- otherwise → "Run failed — check your connection and try again."

Staleness is `isResultStale(result, getModelRev())`, rendered by
`SnippetResultView`'s existing banner.

#### 4. Ops

Embedded `value()` / `step()` evaluation never applies ops — `routes/tables.py`
and the navigation evaluator only ever read. But a test run *does* record op
proposals, and hiding them would hide a genuine bug in the user's code.

So: **list the ops, offer no Stage button**, and print a warning line above
them:

> This snippet mutates the model — embedded `value()` / `step()` runs are
> read-only and these ops are discarded.

That is `canStage={false}` plus one extra line in `SnippetTestPanel`.

#### 5. `SnippetSourceEditor.svelte`

Renders `<SnippetTestPanel>` below the mode toggle in both modes, passing:

- inline mode: its already-tracked local `entryPoints` (from the debounced
  `/snippets/lint` response),
- saved mode: `[entry]` — the ref dropdown is already filtered by
  `entryAvailable`, so a selectable ref provably has the entry point.

### Run gating

Run is disabled unless **all** of:

1. a snippet is configured — a `ref` is picked, or inline `code` is non-empty
   (the unconfigured `{}` source has nothing to run);
2. the entry point is available — `entryAvailable(entry, entryPoints)`. The
   existing amber `snippet-entry-warning` ("define `value()` to use this
   snippet here") already explains why, so no second message is needed;
3. the element count fits the entry — `value` needs ≥ 1, `step` needs exactly
   1.

These mirror the server's `SnippetRunIn` validators, so the UI never sends a
request that would 422. The gate also lives in the run function itself, not
only on the button, because `Mod-Enter` in the embedded `CodeEditor` calls it
directly — same discipline as `runSnippetTab`'s `entryAvailable` guard.
`SnippetSourceEditor` currently passes `onRun={() => {}}` to `CodeEditor`; that
wires to the panel's guarded run (opening the panel if collapsed).

### No Stop button

M1's `POST /snippets/cancel` performs a real registry + ownership check but the
abort itself is a no-op (`_noop_cancel`) — a run still ends only at
`wall_timeout_s`, which defaults to 10 seconds. The Snippet tab's Stop button
is honest about this in its notice text; in a small embedded panel with a
10-second ceiling it would be noise. Omitted.

## Testing

Vitest component tests (happy-dom + MSW), alongside the existing
`components/Snippet/__tests__/`:

- inline mode Run posts `code` (not `artifact_id`), with the bound
  `element_ids` and the correct `entry`;
- saved mode Run posts `artifact_id`;
- Run is disabled with 0 elements for `value`, with 2 elements for `step`,
  when the entry point is missing, and when the source is unconfigured;
- `429` and `503` responses render their respective notices;
- a result carrying ops lists them and renders **no** Stage button, plus the
  read-only warning;
- unmounting mid-run neutralizes the in-flight response (no state write, no
  console error).

Regression coverage for the two refactors: the existing
`SnippetTab` / console tests must keep passing unchanged in behaviour, with
props threaded instead of store reads.

One e2e leg added to `frontend/e2e/script-embedding.spec.ts`: open the column
manager → add a script column → write an inline `value()` → expand Test → bind
an element → Run → assert the rendered result.

## Out of scope

- **Context-aware prefill** ("use a row from this table", "use the current
  frontier"). Faithful, but it couples `SnippetSourceEditor` to `TableView`
  page data and `NavigationBuilder` results at both call sites. The shared
  search + **Use current selection** path covers the common case.
- Persisting test bindings with the column/step definition.
- Any backend change.
