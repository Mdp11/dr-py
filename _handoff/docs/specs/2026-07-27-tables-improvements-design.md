# Tables improvements — design

Date: 2026-07-27

Five independent fixes to the table/navigation editing surfaces. Four are
frontend-only; one removes a warning from the Python core. They share no state
and can be implemented and reviewed in any order.

---

## 1. Column header band in the table settings dialog

**Problem.** In `ColumnManager.svelte` every column card renders its kind badge,
name input and action buttons in the same flat visual register as the editor
body below it. With a script or navigation column expanded, the card reads as
one undifferentiated block and the column's identity is hard to find.

**Change.** Promote that row to a header band inside the card.

- The card (`div[data-col-drop]`) gains `overflow-hidden` so the band's tint
  reaches the rounded corners, and loses its own padding.
- The existing `div.flex.flex-wrap.items-center.gap-1.5` becomes the band:
  `bg-muted/50`, `border-b border-border/70`, and its own padding.
- The per-kind editor body (`NavigationColumnEditor` / `PropertyColumnEditor` /
  `ScriptColumnEditor`) is wrapped in a padded container, replacing the padding
  the card used to supply. `ScriptColumnEditor`'s own `mt-1.5` wrapper margin is
  dropped where it now double-spaces.
- The kind badge gains a per-kind accent colour so `ELEMENT` / `PROPERTY` /
  `NAVIGATION` / `SCRIPT` are distinguishable at a glance. Colours come from
  existing Tailwind/theme tokens — **no new CSS custom properties**, and each
  must be legible in both light and dark themes.
- The name input gains `font-medium` and a border that is transparent until
  hover/focus, so it reads as a title while remaining obviously editable
  (placeholder behaviour is unchanged).
- The detached drag ghost (same file, `column-drag-ghost`) mirrors the band's
  styling so grabbing a card does not change its appearance.

**Non-goals.** No change to the row's contents, ordering, or any handler. This
is presentation only.

---

## 2. Discard confirmation for the table settings dialog

**Problem.** Cancel, the X, Escape and an overlay click all discard every staged
definition edit with no warning. A composed script column can vanish on a
stray Escape.

**Scope.** The one table settings dialog in `TableView.svelte`. That dialog is
also what the grid's header pencil (`header-edit-{i}`) opens — "after editing a
header" and "in table settings" are the same surface. Navigation dialogs and
the nine existing `window.confirm` call sites are out of scope.

### New component: `ui/confirm-dialog`

A small reusable confirmation dialog under
`frontend/src/lib/components/ui/confirm-dialog/`, following the existing
`ui/dialog` folder convention (`confirm-dialog.svelte` + `index.ts`).

Props: `open` (bindable), `title`, `description`, `confirmLabel`,
`cancelLabel`, `variant` (`'default' | 'destructive'`, default `'default'`),
`onConfirm`, `onCancel`.

Styling follows the app's existing vocabulary — `font-display` light-weight
tracked title over popover tokens, generous spacing, a muted description, and a
right-aligned footer with the dismissive action first. It carries
`data-testid="confirm-dialog"`, `data-testid="confirm-dialog-confirm"` and
`data-testid="confirm-dialog-cancel"`.

The component is written to be reusable but has exactly one consumer in this
change. Retrofitting the `window.confirm` call sites is explicitly **not** part
of this work.

### New state predicate

`frontend/src/lib/state/table-editor.svelte.ts` exports:

```ts
export function hasSuspendedTableEdits(tabId: string): boolean
```

returning `_suspended.has(tabId) && definitionFingerprint(tabId) !== _suspended.get(tabId)`.

It reuses the fingerprint the suspension machinery already records at dialog
open, so "changed" means exactly what `resumeTableEvaluation` means by it. Sort
remaps are not in the fingerprint; they only ever occur alongside a definition
edit (remove/move/clone), so they cannot produce a false negative. Re-exported
from `state/index.ts` beside the other suspension functions. It is called from
event handlers, never from a template — no reactivity requirement.

### Wiring in `TableView.svelte`

The existing `onOpenChange(false)` body (revert-unless-saved, clear focus,
resume) moves verbatim into a function `applyClose()`. It is safe to call twice:
`revertSuspendedTableEdits` returns early once `_suspendedSnapshot` is dropped,
and `resumeTableEvaluation` returns early once `_suspended` is dropped.

- `requestClose()`: if `hasSuspendedTableEdits(tabId)` → `confirmDiscardOpen = true`;
  otherwise `applyClose(); settingsOpen = false`.
- **Cancel** becomes a plain `<button>` (no longer `Dialog.Close`) calling
  `requestClose()`. It keeps `data-testid="settings-cancel"`.
- **X**: `Dialog.Content` gets `showCloseButton={false}`; a custom X button
  calling `requestClose()` replaces it, carrying
  `data-testid="settings-close"` and an `sr-only` "Close" label.
- **Escape / overlay**: `Dialog.Content` gets `onEscapeKeydown` and
  `onInteractOutside` handlers that `preventDefault()` and open the confirm
  when `hasSuspendedTableEdits(tabId)` is true, and otherwise fall through to
  the primitive's own close (which reaches `onOpenChange`).
- **Save** is unchanged: it stays a `Dialog.Close` that sets `settingsSaved`
  first, so it closes through `onOpenChange` → `applyClose()`.
- `onOpenChange(false)` now just calls `applyClose()`.

Because `settingsOpen = false` is an external assignment, bits-ui does not fire
`onOpenChange` for it — this is why `requestClose()`/the confirm path must call
`applyClose()` themselves. The existing comment in the file documenting that
gotcha is extended rather than replaced.

### Confirm popup behaviour

Rendered as a nested `Dialog.Root` inside the settings dialog's markup.

- Title: "Discard changes?"; description names what is lost ("Your unsaved
  column changes will be lost.").
- "Keep editing" (cancel) dismisses the confirm only; the settings dialog stays
  open with edits intact.
- "Discard changes" (destructive confirm) → `confirmDiscardOpen = false`,
  `applyClose()`, `settingsOpen = false`.
- Escape inside the confirm dismisses the confirm, not the settings dialog —
  bits-ui's layer stack gives the topmost dialog the key. This is asserted by a
  test rather than assumed.

---

## 3. New script editors open expanded

**Problem.** `SnippetSourceEditor` defaults to collapsed. Adding a script step
or column therefore produces a chevron the user must immediately click; the
whole point of the click was to write code.

**Change.** Seed only *newly created* editors as expanded. Existing editors keep
opening collapsed, so a settings dialog with several script columns stays
readable.

`frontend/src/lib/state/snippet-collapse.svelte.ts` gains:

```ts
/** Seed a not-yet-seen key as expanded. No-op if the key already has a
 *  value, so a user's own toggle is never stomped. */
export function seedSnippetExpanded(key: string): void
```

Re-exported from `state/index.ts`. Call sites, each seeding the same key the
corresponding editor will read:

| Call site | Key |
|---|---|
| `ColumnManager.addScriptColumn` | `` `${tabId}::col:${newIndex}` `` |
| `TableView.addColumnFromHeader('script')` | `` `${tabId}::col:${newIndex}` `` |
| `PathCard.addScriptStep` | `` `${tabId}::${pathKey(path)}::step:${index}` `` |
| `PathCard`'s inline `+ script` insert | `` `${tabId}::${pathKey(path)}::step:${i}` `` |

In both table paths the new column is appended, so `newIndex` is
`columns.length - 1` after the mutation.

**Documented caveat.** Keys embed the column/step index, so a mid-list insert
re-associates keys with neighbouring editors and a previously-toggled
disclosure can appear shifted by one. The collapse store's docstring already
declares that a cosmetic, self-healing miss and declines structural remapping;
this change inherits that stance and the docstring is extended to say so
explicitly for the seeding path.

---

## 4. Bare spinner while script columns compute

**Problem.** The strip reads "Computing script columns 7/42 (17%) — values fill
in as they finish". The counters are sweep-internal and the sentence explains a
mechanism the user did not ask about.

**Change.** In `TableView.svelte`'s `scriptStatus?.state === 'computing'`
branch:

- Keep the strip element and its `data-testid="table-script-status"`, so the
  tab's fixed chrome — and therefore the virtualizer's row math, which the
  existing comment above the strip explains at length — is unchanged.
- Keep the spinner span.
- Remove the count text, the `sweepPercent` span, and the trailing "values fill
  in as they finish" clause.
- Delete the now-unused `sweepPercent` `$derived`.
- Swap `aria-live="polite"` for `role="status"` and add an `sr-only` span
  reading "Computing script columns", so the state is still announced with no
  visible text.

The `failed` branch is untouched — that message is an error, not a loading
state.

---

## 5. Drop the "already visited in the chain" warning

**Problem.** A script navigation step that returns an element already in the
chain is dropped by the cycle guard. That is intended behaviour — an identity
return ("keep this element") is a normal idiom — yet it raises a warning badge,
training users to ignore the badge.

**Change.** Stop emitting it, and remove the code entirely (self-contained app,
no external consumers).

- `src/data_rover/core/navigation/evaluate.py` — delete the
  `if script is not None and exclude_visited:` block that counts `dropped` and
  calls `script.add_warning(...)`, together with its explanatory comment. The
  cycle guard in the loop below already performs the dropping and is unchanged.
  The `ScriptWarningCode` import stays — three other codes in the file still
  use it.
- `src/data_rover/core/script/warnings.py` — remove
  `NAV_ALREADY_VISITED = "nav_already_visited"` from `ScriptWarningCode`.
- `frontend/src/lib/script/warnings.ts` — remove the `nav_already_visited`
  case. The function's `default` branch (falls back to `detail`, then the raw
  code) still degrades readably if an older server ever sends one.

**Not changed.** The warning aggregation machinery, the other four warning
codes, the badge/panel UI, and the `exclude_visited` cycle guard itself.

---

## Test impact

Existing tests that must be updated:

- `frontend/src/lib/components/Table/__tests__/TableView.test.ts` — two tests
  (~line 181 and ~line 228) click `settings-cancel` after making edits; they
  now hit the confirm gate and need the discard step. One test (~line 265)
  asserts the "Computing script columns 7/42" copy.
- `tests/navigation/test_script_step.py` and `tests/script/test_warnings.py` —
  drop/invert `nav_already_visited` assertions.
- `frontend/src/lib/script/__tests__/warnings.test.ts` — drop the
  `nav_already_visited` case.

New tests:

- Settings dialog: confirm appears on Cancel when dirty; closes silently when
  clean; Escape is gated when dirty; "Discard changes" reverts the staged
  definition and closes; "Keep editing" leaves the dialog open with edits
  intact; Escape inside the confirm dismisses only the confirm.
- `seedSnippetExpanded`: does not overwrite an existing value; each of the four
  add paths renders its new editor expanded while a sibling stays collapsed.
- Navigation: a script step returning an already-visited element still drops it
  and emits **no** warning.
- Column header band: the kind badge and name input render inside the band
  element (a light structural assertion; visual styling is not unit-tested).

## Verification

`pixi run dr-tidy`, `pixi run core-test`, and
`pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'` must
all pass.
