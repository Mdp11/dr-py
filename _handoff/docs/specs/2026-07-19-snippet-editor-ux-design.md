# Snippet editor UX improvements — design

Date: 2026-07-19
Status: approved

## Problem

Four UX gaps in the snippet workspace tab (`frontend/src/lib/components/Snippet/`):

1. The `value`/`step` entry-point options are disabled with no explanation of
   what they are or how to enable them.
2. Code completion feels broken: `autocompletion({ override: [...] })`
   suppresses ALL default completion, and the custom source only fires in three
   narrow contexts (`dr.` members, type-name strings, `receiver.` with a typed
   partial). Most typing produces no popup.
3. The docs panel is a fixed 320px sidebar with everything stacked in
   accordions — too narrow, too dense, hard to retrieve anything.
4. New snippets start with a real comment (`DEFAULT_CODE`) the user must
   delete, instead of placeholder ghost text.

## Design

### 1. Entry points — explain + insert stub

Backend semantics (from `core/script/runner.py` + `lint.py`): `value(el)` and
`step(el)` are read-only per-element entry points. The server calls the
snippet's one-arg top-level function of that name with the bound element and
reports `repr(return value)`; `dr` writes raise `ReadOnlyError` in those modes
(`record_ops` is only true for `entry="script"`). `derive_entry_points` (AST)
unlocks an entry when the code defines a matching one-arg top-level function.

UI changes in `SnippetTab.svelte`:

- The entry `<select>` options are always selectable (drop the `disabled`
  attributes).
- When the selected entry is not `script` and not in `lint.entryPoints`, show
  an inline hint bar under the toolbar:
  > `value` runs a top-level function `def value(el):` against a chosen
  > element (read-only). Your snippet doesn't define one yet. **[Insert stub]**
- **Insert stub** appends a small documented stub for the selected entry to
  the code (via the normal `updateSnippetCode` path so dirty/lint flow
  applies). The debounced lint (~300 ms) then reports the entry as available
  and the Run gate opens.
- Run stays disabled while: selected entry ∉ `lint.entryPoints`, or a
  non-`script` entry has no bound element (existing rule).

Stub content:

```python
def value(el):
    # Read-only: compute and return a value for the bound element.
    return el.name
```

```python
def step(el):
    # Read-only: one tick of a step-wise evaluation for the bound element.
    return el.name
```

### 2. Completion — facade + general Python

In `CodeEditor.svelte`, stop overriding completion. Register three sources:

- The existing facade source (`computeCompletions`) — unchanged logic,
  registered as a Python language-data autocomplete source; its options keep
  a boost so `dr.`/type-string/Element contexts rank above generic words.
- `globalCompletion` from `@codemirror/lang-python` — keywords + builtins.
- `localCompletionSource` from `@codemirror/lang-python` — variables and
  functions defined in the document (scope-aware).

`basicSetup`'s default autocompletion UI stays; only the source configuration
changes. Hover docs (`resolveDocAt`) unchanged.

### 3. Docs — modal with tabs

Delete the sidebar usage (`showDocs` + `w-80` region in `SnippetTab.svelte`).
The **Docs** toolbar button opens a dialog instead — existing `ui/dialog` +
`ui/tabs` primitives, same shape as `SettingsDialog.svelte`, wide content
(~`max-w-3xl`, tall scrollable body). Three tabs:

- **API Reference** — facade entries grouped `dr` / `Element` / errors, with
  signatures, doc text, and examples. Filter box at the top narrows entries
  by name/signature/doc text as you type.
- **Project** — element types (properties, multiplicity, abstract flag) and
  relationship types of the open project. Same filter-box treatment.
- **Limits & rules** — run limits (`docs.limits`) and `docs.notes`, roomier
  than today but content unchanged.

`SnippetDocsPanel.svelte` is replaced by the new modal component
(`SnippetDocsDialog.svelte`); `ensureSnippetDocs`/`getSnippetDocs` and the
`docs-view` helpers are reused as-is.

### 4. Placeholder instead of starter comment

- `DEFAULT_CODE` in `snippet-editor.svelte.ts` becomes `''` (new drafts start
  empty). The "don't discard draft" comparison logic that referenced
  `DEFAULT_CODE` as "real content" is updated accordingly.
- `CodeEditor.svelte` adds CM's `placeholder()` extension with the previous
  guidance text as multi-line ghost content (DOM element — the string form
  collapses newlines). Standard behavior is kept deliberately: the ghost text
  shows only while the document is empty and disappears on first input (not
  on focus), so the hint stays readable in a focused empty editor.

## Error handling

- No new server interaction; all changes are client-side. Stub insertion goes
  through the existing draft-update path, so save conflicts, dirty tracking,
  and lint errors behave as today.
- If `docs` fail to load, the modal shows the existing "Docs unavailable."
  state; completion degrades to keywords + local words (facade source already
  returns null without docs).

## Testing

Vitest (happy-dom), following existing test layout:

- `completion-source` tests extended for coexistence with default sources
  (facade options still produced and boosted in their contexts).
- `SnippetTab` tests: entry select always enabled; hint bar appears for an
  undefined entry; Insert stub updates code via `updateSnippetCode`; Run
  disabled until lint lists the entry.
- `SnippetDocsDialog` tests: tabs render the three sections; filter narrows
  reference/project entries; unavailable-docs state.
- Placeholder: new draft has empty `code`; editor renders placeholder element
  when empty (DOM assertion).
- Existing tests referencing `DEFAULT_CODE` or `SnippetDocsPanel` updated.

## Out of scope

- Server-side changes of any kind (entry-point derivation, docs payload).
- Resizable panels, docs search across the whole app, cancel/abort semantics.
