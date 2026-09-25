# Multi-element `value` snippets — design

Date: 2026-07-19
Status: approved (brainstorming session)

## Goal

The `value` snippet entry point currently binds exactly one element:
`def value(el)` receives a single `Element` handle. Change it to accept
**1 or more** elements. `step` is deliberately unchanged (single element,
per-node simulation context).

## Decisions (from brainstorming)

1. **Signature: always a list.** `def value(elements):` receives a
   `list[Element]`, length ≥ 1, in bound order — always a list, even when a
   single element is bound. No varargs, no arity dispatch. Existing
   single-element snippets migrate from `el.x` to `elements[0].x`
   (acceptable break; self-contained app, no external snippet corpus).
2. **Scope: only `value`.** `def step(el):` keeps its single-element
   contract.
3. **Binding UX: additive chip list.** The snippet tab's element-context row
   shows removable chips; "Use current selection" and the search dropdown
   append (duplicates ignored); each chip has an ×, plus clear-all. In
   `step` mode the same row caps at one chip (picking replaces).
4. **Wire shape: unify on `element_ids`.** Replace `element_id: str | None`
   with `element_ids: list[str]` end-to-end (API schema, `RunRequest`, guest
   start message). No compatibility shim — backend and frontend ship
   together, no external API consumers.

## Contract

- `value(elements)` — `elements` is a `list[Element]` in the order the ids
  were sent in `element_ids`. Never empty at runtime when invoked through
  the route (validated up front).
- `step(el)` — unchanged single `Element`.
- Arity rule unchanged for both: exactly one positional argument.
  `lint.derive_entry_points` logic is untouched; only the lint warning text
  for `value` changes to say "the list of elements" (message for `step`
  keeps "the element").
- `value`/`step` runs remain `record_ops=False` (read-only; `dr` writes
  raise `dr.ReadOnlyError`) — unchanged.

## Backend changes

- **`src/data_rover/api/schemas.py` — `SnippetRunIn`**: drop
  `element_id: str | None`; add `element_ids: list[str] =
  Field(default_factory=list)`. Add a model validator (alongside the
  existing exactly-one `code`/`artifact_id` check) enforcing:
  - `entry == "value"` → `len(element_ids) >= 1`
  - `entry == "step"` → `len(element_ids) == 1`
  - `entry == "script"` → no constraint (field ignored).
  Pydantic validation failure surfaces as the usual 422.
- **`src/data_rover/core/script/runner.py` — `RunRequest`**: replace
  `element_id: str | None = None` with
  `element_ids: list[str] = field(default_factory=list)`; update the
  docstring (context elements for `value`/`step`).
- **`src/data_rover/api/routes/snippets.py`**: pass
  `element_ids=payload.element_ids` into `RunRequest`.
- **Runners** (both must stay behaviorally identical):
  - `src/data_rover/api/script_runner.py`: the guest start message carries
    `"element_ids"` (list) instead of `"element_id"`; the embedded bootstrap
    `_main` builds `els = [dr.element(i) for i in element_ids]` and calls
    `fn(els)` for `entry == "value"`, `fn(els[0] if els else None)` for
    `entry == "step"` (runner layer stays lenient; the route validates
    counts).
  - `tests/script/trusted_runner.py`: same change in-process.
  - A nonexistent id raises `dr.NotFoundError` inside the run and surfaces
    as a `runtime` `ScriptError`, exactly like today's single-id behavior.
- **`src/data_rover/core/script/lint.py`**: entry-signature warning message
  becomes per-entry ("the list of elements" for `value`, "the element" for
  `step`); arity check itself unchanged.

## Frontend changes

- **`frontend/src/lib/state/snippet-editor.svelte.ts`**: run state swaps
  `elementId: string | null` / `elementLabel: string | null` for an ordered
  `elements: { id: string; label: string }[]`. Replace
  `setSnippetElementContext` with `addSnippetElement(tabId, id, label)`
  (append; ignore duplicate id; in `step` mode replace instead of append),
  `removeSnippetElement(tabId, id)`, and `clearSnippetElements(tabId)`.
  `runSnippetTab` guard becomes `rs.entry !== 'script' &&
  rs.elements.length === 0`; the request sends
  `element_ids: rs.entry === 'script' ? undefined : rs.elements.map(e => e.id)`.
- **`frontend/src/lib/api/snippets.ts`**: `element_id?: string` →
  `element_ids?: string[]` in the run-request type.
- **`frontend/src/lib/components/Snippet/ElementContextRow.svelte`**: chip
  row per decision 3. Existing micro-search and "Use current selection"
  mechanics are kept; both now call `addSnippetElement`. Chips render label
  (+ × button); a clear-all control appears when ≥ 2 chips. Keep the
  existing `snippet-element-search` test id.
- Behavior on entry switch between `value` and `step`: keep the bound list;
  `step` runs use it only if it has exactly one element (Run disabled
  otherwise is NOT added — instead, switching to `step` with ≥ 2 chips
  truncates to the first chip, matching the "picking replaces" cap so the
  UI never shows an unrunnable step state).

## Docs

- `src/data_rover/core/script/README.md`: read-only stance section and any
  `value` signature mentions updated to the list contract.
- `routes/snippets.py` docs payload (`_SNIPPET_DOC_NOTES` / facade docs):
  update only if a note mentions the single-element `value` contract (the
  facade docstrings don't describe entry points; verify during
  implementation).
- Frontend `SnippetDocsDialog.svelte` / entry-point help text: update
  wording if it states "the element".

## Testing (TDD, mirroring existing layout)

- `tests/script/` (trusted runner): `value` receives a list — single id
  arrives as 1-item list; multiple ids arrive in bound order; unknown id →
  `runtime` error; `step` still receives a single element.
- Lint tests: updated warning text for `value`, unchanged for `step`;
  `derive_entry_points` unchanged.
- `tests/api/` route tests: 422 for `value` with empty `element_ids`, 422
  for `step` with 0 or 2 ids, passthrough of `element_ids` into the runner,
  `script` ignores the field.
- `tests/api/test_snippets_wasm.py` (integration-marked): update
  `test_wasm_value_entry` to the list contract; add a two-element case.
- Frontend vitest: state mutators (append/dedupe/remove/clear, step-mode
  replace + truncate-on-switch), run guard, request payload;
  `ElementContextRow` chip interactions.

## Out of scope

- Type-based binding ("all elements of type X" as one chip) — considered,
  deferred.
- Multi-element `step`, multi-select global selection, and any change to
  op-recording or the bridge read protocol.
