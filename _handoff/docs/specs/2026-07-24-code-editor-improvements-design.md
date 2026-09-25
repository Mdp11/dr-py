# Code editor improvements (Session 7) — design

Date: 2026-07-24
Status: approved

Three independent improvements to the CodeMirror-based Python snippet editor
(`frontend/src/lib/components/Snippet/CodeEditor.svelte` and its two hosts):

12. Drag to enlarge the editor vertically in every instance.
13. Replace the stock Ctrl+F search panel chrome with a designed one.
14. A Reformat button that also sanitizes tabs/spaces.

## Context — what exists today

`CodeEditor.svelte` is mounted in exactly two places:

- **`SnippetTab.svelte`** — the standalone snippet workspace tab. The editor and
  the run console split the tab body as a fixed `flex-[3]` / `flex-[2]` pair,
  with no divider.
- **`SnippetSourceEditor.svelte`** — the shared inline editor for a table script
  column (F4) and a navigation script step (F6). The editor box is a hard
  `h-48`.

Indentation policy already exists and is deliberate (`lib/editor/indent.ts`,
`lib/editor/indent-extension.ts`): **four spaces per level, never a tab**,
because the sandbox compiles snippets with CPython's tokenizer, which rejects
mixed tab/space indentation with `TabError`. `expandTabs` is column-aware (so
`"  \tx"` becomes four columns, not six — the same rule CPython uses), Tab and
Shift-Tab move one level, pasted text containing tabs is expanded on the way in,
and a conditional "Fix indentation" button appears whenever a tab survives in
the document. *This is the "something already done" the request refers to; it
stays, and item 14 builds on it rather than replacing it.*

Search is whatever `basicSetup` provides — `searchKeymap` and
`highlightSelectionMatches` only, no `search()` configuration. The panel is
CodeMirror's default: browser-default `<input>`s, text buttons (`next`,
`previous`, `all`, `replace`, `replace all`) and raw checkboxes, anchored at the
bottom. `theme.ts` styles only the panel's background, so everything inside it
is unthemed — that is the ugliness item 13 names.

## Decisions

| Question | Decision |
|---|---|
| Indentation unit | **Stays 4 spaces** (PEP 8). No change to `INDENT_WIDTH`. |
| Formatter | **Server-side `ruff format`** via a new endpoint. |
| Resize model | **Splitter** in the standalone tab, **bottom-edge grip** inline. |
| Size persistence | **Global per-kind**, in `localStorage`. |
| Search panel | **Custom panel** via `search({ createPanel })`. |
| Format button placement | **Inside `CodeEditor`**, so all instances get it. |

---

## 1. Vertical resize (item 12)

### `lib/editor/editor-size.ts` (new, pure)

No Svelte, no DOM beyond `localStorage`, so the geometry unit-tests without a
browser — mirrors `components/Sidebar/split.ts`.

```
INLINE_MIN_H = 96, INLINE_MAX_H = 800, INLINE_DEFAULT_H = 192   // 192px === today's h-48
SPLIT_MIN_PANEL_H = 80, SPLIT_DEFAULT_RATIO = 0.6                // ≈ today's flex-[3]/flex-[2]

clampInlineHeight(px: number): number
clampSplitRatio(r: number): number
splitHeights({ containerH, ratio, dividerH, minPanelH }): { topH, bottomH }
ratioFromPointer({ pointerY, containerH, dividerH, minPanelH }): number
loadInlineHeight() / saveInlineHeight(px)
loadSplitRatio()  / saveSplitRatio(r)
```

Storage keys: `ui.snippet.inlineEditorH`, `ui.snippet.tabSplitRatio`. Both
loaders are `browser`-guarded and fall back to the default on a missing,
non-numeric or out-of-range value — a corrupt key must never render a 0-height
editor.

`splitHeights` and `ratioFromPointer` carry the same clamping contract as
`Sidebar/split.ts`: neither panel drops below `minPanelH`, and when the
container is too short to hold two minimums the **editor** yields first so the
console keeps as much of its minimum as fits.

### `lib/state/editor-size.svelte.ts` (new, reactive)

Module-level `$state` seeded from the loaders on first read, written through on
every set. Shape follows `snippet-collapse.svelte.ts`:

```
getInlineEditorHeight(): number
setInlineEditorHeight(px: number): void
getSnippetSplitRatio(): number
setSnippetSplitRatio(r: number): void
resetEditorSize(): void   // test isolation
```

Global per-kind is the point: dragging one inline editor resizes **every**
mounted one live, and the size survives reload. This is what makes the
navigation-step case work at all — `SnippetSourceEditor`'s `collapseKey` doc
comment records that nav-step keys are minted fresh on every dialog open, so a
per-instance persisted size would reset there every time.

### `components/ResizeHandle.svelte` (extended)

`side` widens from `'left' | 'right'` to `'left' | 'right' | 'top' | 'bottom'`.
For `axis: 'y'` it now selects **which panel grows**: `'top'` (drag down grows
the panel above) or `'bottom'` (drag up grows the panel below). The signed-delta
line becomes:

```
axis === 'y' ? (side === 'top' ? delta : -delta) : side === 'left' ? delta : -delta
```

The default stays `'left'`, which for `axis: 'y'` falls through to the existing
drag-up-grows behaviour — so both current `axis="y"` call sites
(`routes/p/[projectId]/+page.svelte`'s results panel, `NavigationBuilder`'s
results dock) are unchanged. Document the fall-through in the prop comment; it
is load-bearing, not incidental.

### `SnippetSourceEditor.svelte`

`h-48` becomes `style="height:{getInlineEditorHeight()}px"`, and a
`ResizeHandle axis="y" side="top"` grip renders immediately below the editor
box, inside the same bordered container so it reads as part of the editor.
`min`/`max` come from `INLINE_MIN_H`/`INLINE_MAX_H`; `onchange` writes the
store.

### `SnippetTab.svelte`

The `flex-[3]` / `flex-[2]` pair becomes a measured split. A container ref plus
`ResizeObserver` feeds `containerH` (the pattern `VerticalSplit.svelte` already
uses); `splitHeights` resolves the two pixel heights; a divider strip between
them handles the drag through `ratioFromPointer` against the container's
`getBoundingClientRect()`.

The divider uses window-level pointer listeners with teardown on
`pointerup`/`pointercancel` and on unmount, exactly as `VerticalSplit` does — a
divider that stays locked to the pointer after a system interruption is the
failure mode being guarded against.

---

## 2. Search panel (item 13)

### `lib/editor/search-panel.ts` (new)

Exports `luxurySearch: Extension` = `search({ top: true, createPanel })`, added
to `CodeEditor`'s extension array **after** `basicSetup`. `basicSetup`
contributes only `searchKeymap` and `highlightSelectionMatches`, never a
`search()` configuration, so there is no duplicate panel and no precedence
subtlety of the kind the `Mod-Enter` binding needed.

The panel is a plain-DOM class implementing CodeMirror's `Panel` interface
(`dom`, `top`, `mount()`, `update(update)`, `destroy()`). **No nested Svelte
root inside CodeMirror** — a mounted component inside a panel CodeMirror creates
and destroys on its own schedule buys lifecycle problems for styling
convenience. Icons are therefore inline SVG built from lucide's 24×24 stroke
geometry.

All behaviour delegates to `@codemirror/search`'s own commands and state —
`getSearchQuery`, `setSearchQuery`, `SearchQuery`, `findNext`, `findPrevious`,
`replaceNext`, `replaceAll`, `closeSearchPanel` — so every existing keybinding
keeps working and the panel owns presentation only.

Layout (the approved mock):

```
╭─ top of editor ───────────────────────────╮
│ ▸ [ dr.elements        ]  3/17  ‹ ›    ✕ │
│     Aa  .*  ab|                           │
╰───────────────────────────────────────────╯
  ▸ expands the replace row
```

- Row 1: disclosure chevron, search field, match counter, prev/next icon
  buttons, close.
- Row 2: `Aa` (match case), `.*` (regexp), `ab|` (whole word) as toggle chips.
- Row 3: replace field + Replace / Replace all, rendered only when the chevron
  is open.
- Enter → find next, Shift-Enter → find previous, Escape → close, all bound on
  the search input.

**Match counter.** Counted by running `SearchQuery.getCursor` over the document
and locating the current selection among the hits. **Capped at 1000 matches**,
rendering `999+` past that — without a cap, a one-character query on a long
snippet turns every keystroke into a full-document scan. An invalid regexp
renders the field in an error state and a `—` counter rather than throwing.

**Styling** lives in `theme.ts` under `cm-dr-search*` class names, beside the
existing `.cm-panels` rules. That is the same mechanism as the rest of the
editor theme and, unlike Tailwind utility strings assembled in a `.ts` file, it
does not depend on Tailwind's content-scanning heuristics finding them.

---

## 3. Reformat (item 14)

Indentation stays four spaces; `expandTabs`, `indentUnit`, `tabSize`, the
Tab/Shift-Tab bindings and paste-time normalization are all unchanged. What is
new is a real formatter and a single control that fronts both it and the tab
sanitization.

### Backend — `api/script_format.py` (new)

Sibling of `api/script_runner.py`. Formatting is an API-layer concern (it shells
out), so it stays out of `core/`, which is deliberately dependency-light.

`ruff format` is safe on untrusted input in a way the runner is not: ruff parses
and prints, it never executes the snippet. No sandbox is involved.

```
format_code(code: str, *, timeout_s: float) -> FormatResult
```

Resolves `ruff` once via `shutil.which` (cached) and pipes the code through:

```
ruff format - --stdin-filename snippet.py --config indent-width=4
```

`indent-width` is pinned explicitly from one shared constant rather than left to
ruff's default, so the formatter and the editor's `INDENT_WIDTH` cannot drift
apart silently. Line length stays at ruff's default (88).

Outcomes: formatted source; a parse error (ruff exits non-zero with a message on
stderr); ruff not found; timeout.

### Backend — `POST /snippets/format`

In `routes/snippets.py`, beside `run`/`lint`/`cancel`.

- Request `SnippetFormatIn { code }`, response `SnippetFormatOut { code, changed }`.
- **422** with ruff's message when the code does not parse.
- **503** when ruff is not on `PATH`. This mirrors the missing-guest-binary
  posture already established for `/snippets/run`: degraded, never fatal, and
  never a 500.
- Reuses `SNIPPET_MAX_CODE_BYTES` for the size cap.
- Added to `authz._READ_ONLY_POST_SUFFIXES` alongside `/snippets/run` and
  `/snippets/lint`, so a viewer may format their own draft. Formatting reads
  nothing from the model and writes nothing to it.

New setting `snippet_format_timeout_s` (default 5.0, `DATA_ROVER_SNIPPET_FORMAT_TIMEOUT_S`).
`ruff` moves into `[feature.api.dependencies]` in `pixi.toml` (it is currently
`core-dev` only).

### Frontend

`lib/api/snippets.ts` gains `formatSnippet(code)`.

`CodeEditor.svelte` gets a corner control that **absorbs the current "Fix
indentation" button**. On activation it:

1. Expands tabs locally with `expandTabs` — tab-indented code is a `TabError` at
   parse time, so without this step ruff would 422 on exactly the documents that
   most need formatting.
2. Posts the expanded source to `/snippets/format`.
3. Replaces the document in **one undoable transaction**, restoring the cursor
   to the same line number, clamped to the new document length.
4. On failure renders a transient inline message ("Can't format: syntax error at
   line 3"). Never throws, never clears the user's code.

Bound to `Shift-Alt-F` (the VS Code convention) through the same
`Prec.highest`-guarded keymap the `Mod-Enter` run binding uses, and disabled
while a format request is in flight or after a 503.

The control's chrome is restyled to match the new search panel: a muted chip
that lifts to full contrast on editor hover/focus, warning-tinted while a tab
character still survives in the document (`hasTabs`), with the tooltip
explaining why. Living inside `CodeEditor` means the standalone tab, table
script columns and navigation script steps all get it from one implementation.

`data-testid="snippet-fix-indent"` is replaced by `data-testid="snippet-format"`;
the existing assertions on the old id move with it.

---

## 4. Testing

**Vitest** (`frontend`)

- `lib/editor/__tests__/editor-size.test.ts` — clamps at both bounds, defaults on
  corrupt/missing/out-of-range storage, `splitHeights` minimum-yield ordering,
  `ratioFromPointer` clamping, storage round-trip.
- `lib/editor/__tests__/search-panel.test.ts` — against a real `EditorView` in
  happy-dom (the existing `code-editor.test.ts` proves this works): panel opens,
  counter text, next/previous wrap, each toggle chip changes the query, replace
  row discloses, Escape closes.
- `components/Snippet/__tests__/code-editor.test.ts` — extended with format
  button coverage via MSW (`lib/api/__tests__/server.ts`): success replaces the
  doc in one undo step, tabs are expanded before the request, 422 renders the
  inline message and leaves the doc intact, 503 disables the control.
- `components/Snippet/__tests__/snippet-source-editor.test.ts` — extended: the
  grip changes the rendered height and the value persists through the store.

**Pytest** (`tests/api/test_snippets_format.py`, new)

Formats a document; `changed` is `False` for already-formatted input; 422 on a
syntax error; a viewer is allowed; the size cap rejects oversized code; 503 when
`shutil.which` is monkeypatched to `None`.

**Playwright** — untouched. The three existing specs boot a real backend, and
none of this changes a flow they assert.

## 5. Documentation

- `frontend/README.md` — the editor section gains the two size stores, the
  custom search panel, and the format flow.
- `CLAUDE.md` — the snippet paragraph gains the `/snippets/format` endpoint and
  the `ruff` runtime dependency.

## Out of scope

- Changing the indentation unit (explicitly kept at 4).
- Formatting anything other than Python snippets.
- Per-instance size memory (rejected: nav-step keys are remounted fresh).
- Reformat-on-save or format-on-type.
