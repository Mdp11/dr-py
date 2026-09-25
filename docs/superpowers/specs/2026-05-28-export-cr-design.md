# Export Change Request (CR) — Design

**Date:** 2026-05-28
**Status:** Approved for planning
**Scope:** Frontend-only feature in the SvelteKit app. Adds the ability to optionally produce a Change Request (CR) file — a JSON describing the diff between the pre-save baseline and the just-saved model — alongside the existing model save.

---

## 1. Purpose

A user editing a model wants, when committing their changes, to also emit a self-contained "Change Request" file that captures **just the diff** they're applying. The CR has two consumers:

1. **Manual review** — a reviewer can read the CR and understand the changes without diffing two whole model files.
2. **Programmatic replay** — the CR can be applied to a copy of the baseline model to reproduce the same state.

The CR is **optional** and produced in the same action as a normal save. The user opts in per save via a checkbox in the existing pending-changes drawer.

---

## 2. User-facing behavior

### 2.1 TopBar
No change. The button stays **"Save"** (the model is always saved; CR is an opt-in side-output, not an alternative export).

### 2.2 DiffDrawer (pending-changes dialog)
A single checkbox **"Export CR"** is added to the drawer, in a row directly above the `Cancel` / `Save` footer buttons.

- Default state: unchecked.
- Disabled while a save is in flight.
- Resets to unchecked when the drawer is closed (same lifecycle as `lastResult`).
- The footer Save button keeps its existing label (`Save (N)` / `Saving...`) — the checkbox state does not change it.

### 2.3 Save action when checkbox is checked
After the existing save succeeds (POST + write model JSON), a **second** OS save dialog opens, pre-filled with the CR filename. The browser's last-used-directory behavior typically lands the user back in the same folder; they can confirm or redirect.

If the user cancels the CR dialog, the model save still stands. An inline notice in the drawer reports "Model saved. CR export cancelled." Nothing else is rolled back.

### 2.4 Fallback (no File System Access API)
When `showSaveFilePicker` is unavailable, both files are triggered as `<a download>` downloads and land in the browser's Downloads folder. This is unavoidable — there is no portable cross-browser way to write a sibling file.

---

## 3. CR file format

Format identifier: `datarover.cr/v1`.

```json
{
  "format": "datarover.cr/v1",
  "createdAt": "2026-05-28T14:30:22.123Z",
  "baseline": {
    "filename": "myModel.json",
    "elementCount": 42,
    "relationshipCount": 17
  },
  "ops": {
    "elements": {
      "added":    [ <Element>, ... ],
      "modified": [ { "id": "...", "before": <Element>,      "after": <Element> }, ... ],
      "deleted":  [ <Element>, ... ]
    },
    "relationships": {
      "added":    [ <Relationship>, ... ],
      "modified": [ { "id": "...", "before": <Relationship>, "after": <Relationship> }, ... ],
      "deleted":  [ <Relationship>, ... ]
    }
  }
}
```

### 3.1 Shape rules
- `added` carries the full new entity exactly as it appears in the saved model.
- `modified` carries `{id, before, after}` with the **full** pre- and post-state of the entity (option C1 chosen during brainstorming for ease of manual review and to support optional 3-way merging later).
- `deleted` carries the full pre-deletion entity (same justification as `before`: lets a reviewer see what was lost; lets a replayer optionally verify the entity matches before deleting).
- An entity whose `before` and `after` are equal under deep JSON equality does **not** appear in `modified`.

### 3.2 Identity guarantees
All IDs in the CR are real, server-canonicalized IDs. This is achieved by building the CR from the **post-save returned model** (not the working snapshot, which may contain `tmp_*` placeholders). See §4.

### 3.3 Provenance (`baseline`)
- `filename` — the model filename in effect at the time of save (may be `null` if unknown).
- `elementCount` / `relationshipCount` — counts of the **pre-save baseline**, to give a reviewer a rough integrity signal.
- No hashes for v1 (YAGNI — add if drift-detection becomes a real requirement).

### 3.4 `createdAt`
ISO 8601 UTC timestamp, milliseconds precision (`new Date().toISOString()`).

---

## 4. Data flow inside `DiffDrawer.onSaveClick`

1. Capture `oldBaseline = getBaseline()` and `oldFilename = getFilename()` **before** anything mutates.
2. Run the existing save pipeline: `saveCurrentModel(getWorkingModel())` → on success, `result.model` is the canonicalized `newModel`.
3. `saveJsonToFile(newModel, suggestedName, getFileHandle())` — existing model save (silent if a file handle exists, else opens the OS dialog).
4. **If the "Export CR" checkbox is checked**:
   - Build `cr = buildChangeRequest(oldBaseline, newModel, oldFilename)`.
   - Compose `crFilename = '<TS>_<modelBase>.cr.json'`:
     - `<TS>` = local-time `YYYYMMDDTHHmmss` (e.g. `20260528T143022`). No colons (Windows-incompatible).
     - `<modelBase>` = saved model's filename with its trailing extension stripped (`myModel.json` → `myModel`). If `oldFilename` is null/empty, fall back to `model`.
   - `saveJsonToFile(cr, crFilename, null)` — `null` handle forces a fresh save dialog (W1) / triggers a second download in the fallback path (W3).
   - If `saveJsonToFile` rejects with `AbortError`, set `lastResult` to an informational notice "Model saved. CR export cancelled." Run the state cleanup in step 5 **except** for closing the drawer — leave the drawer open so the notice is visible. The user closes it via Cancel.
   - Other errors during CR write: same behavior, but with an error-styled `lastResult` ("Model saved. CR export failed: \<message\>"). Drawer stays open.
5. Existing post-save cleanup: `setBaseline(newModel)`, `setFilename(saved.filename)`, `setFileHandle(saved.handle)`, `resetOps()`, `clearIssues()`. Close the drawer (`open = false`) **only** if the CR step was either not attempted (checkbox unchecked) or fully succeeded.

### 4.1 Failure semantics
| Step that fails | What happens |
|---|---|
| Save (step 2 or 3) | Existing behavior; CR is not attempted. Drawer stays open with error. |
| CR build (step 4 internal) | Should not fail for valid data; if it throws, treat as a CR error (model save stands). |
| CR file write (step 4 dialog) — `AbortError` | Informational notice, model save stands, drawer closes. |
| CR file write — other error | Inline error notice, model save stands, drawer closes. |

The invariant: a successful model save is **never** rolled back because of a CR-side problem.

---

## 5. Module boundaries

### 5.1 New pure helper — `buildChangeRequest`
Lives next to existing save logic. Two reasonable homes:

- `src/lib/state/save.ts` (alongside `saveCurrentModel`, `resolveTempIds`), or
- a new `src/lib/state/cr.ts` if `save.ts` is starting to do too much.

Decision deferred to the implementation plan; both are acceptable. The helper signature:

```ts
export interface ChangeRequest { /* shape per §3 */ }

export function buildChangeRequest(
  baseline: ModelOut,
  saved: ModelOut,
  baselineFilename: string | null,
  now?: () => Date
): ChangeRequest;
```

Pure (no state reads, no I/O). `now` is injectable for testing.

### 5.2 New pure helper — `composeCrFilename`
```ts
export function composeCrFilename(modelFilename: string | null, now?: () => Date): string;
```
Returns `<YYYYMMDDTHHmmss>_<base>.cr.json`. Local time. Pure. Injectable clock.

### 5.3 `DiffDrawer.svelte` changes
- One new `$state` boolean: `exportCr = $state(false)`.
- Checkbox row added in the dialog footer, above existing buttons.
- `onSaveClick` extended per §4.
- `onOpenChange(false)` also resets `exportCr = false`.

### 5.4 `fileSave.ts`
No change. Existing `saveJsonToFile(value, suggestedName, handle | null)` already supports the two modes we need (handle-reuse for the model, `null` to force a fresh dialog for the CR).

### 5.5 `TopBar.svelte`
No change.

---

## 6. Testing

### 6.1 Unit tests (`buildChangeRequest`)
- Empty diff → empty `ops` (all three buckets are empty arrays for both elements and relationships).
- One added element → present in `ops.elements.added` exactly once.
- One modified element (property change) → present in `modified` with full `before`/`after`, **not** in `added` or `deleted`.
- One deleted element → present in `deleted` with full pre-deletion entity.
- Entity present in both with structurally equal content → does **not** appear in `modified`.
- Same coverage for relationships.
- `baseline.elementCount` / `relationshipCount` reflect the pre-save baseline, not the saved model.
- `createdAt` formatted via injectable clock.

### 6.2 Unit tests (`composeCrFilename`)
- Standard filename: `myModel.json` → `20260528T143022_myModel.cr.json`.
- Filename without extension: `myModel` → `20260528T143022_myModel.cr.json`.
- Null/empty filename: `null` → `20260528T143022_model.cr.json`.
- Filename with multiple dots: `my.model.json` → `20260528T143022_my.model.cr.json` (strip only the last extension).
- Timestamp uses local time, zero-padded, no colons.

### 6.3 Component tests (`DiffDrawer`)
Mock `saveJsonToFile` and the API client.

- Checkbox unchecked + successful save → `saveJsonToFile` called **once** with the model.
- Checkbox checked + successful save → `saveJsonToFile` called **twice**: first with the model + existing handle, then with a `ChangeRequest`-shaped value, `null` handle, and a `.cr.json` name.
- Checkbox checked, CR write throws `AbortError` → baseline/filename/handle/ops/issues are all updated as if save succeeded, drawer stays open, an informational `lastResult` is shown.
- Checkbox checked, CR write throws a non-`AbortError` → same as above but with an error-styled `lastResult`.
- Checkbox checked, save (step 2) fails → CR helper is **never** called.
- `exportCr` resets to `false` when the drawer is closed and reopened.

### 6.4 Playwright smoke
Extend the existing e2e: open the diff drawer with pending changes, toggle "Export CR", click Save, assert that **two** file-save invocations occur (or, in fallback mode, two downloads). The CR's filename matches the `<TS>_<base>.cr.json` shape.

---

## 7. Non-goals

- No backend changes. No new API. No persistence of CRs on the server.
- No "apply CR" UI in this iteration — the CR format is *designed* to be replayable, but a UI/CLI to replay one is out of scope.
- No diff-of-the-diff display in the drawer. The drawer already shows pending changes; the checkbox only governs whether a CR file is also emitted.
- No baseline/metamodel hashing. Provenance is filename + counts only.
- No CR history / undo of an exported CR.
- No multi-file CR bundling.

---

## 8. Open items deferred to the implementation plan

- Whether `buildChangeRequest` lives in `save.ts` or a new `cr.ts` (judgment call based on `save.ts` size at implementation time).
- Exact wording of the inline notices ("Model saved. CR export cancelled.", and the CR-error variant).
- Whether the checkbox label should be `Export CR` or `Also export CR` (defer to implementer; a one-word label is fine given the section context).
