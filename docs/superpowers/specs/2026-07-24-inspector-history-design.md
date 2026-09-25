# Inspector inspection history — design

**Date:** 2026-07-24
**Status:** Approved

## Summary

Back/forward navigation for the element details panel (Inspector). The app records
every element the user inspects; two arrow buttons in the Inspector header walk that
trail with browser semantics. A long-press (or right-click) on either arrow opens a
dropdown listing up to 10 entries in that direction — Name + Stereotype +
ellipsized id — and picking one jumps straight to it.

## Decisions (from brainstorming)

- **Elements only.** Relationship selections and deselects (`select(null)`) do not
  push history entries; back/forward skip over them.
- **Per-direction dropdowns**, browser-style: long-press Back lists up to 10 entries
  behind the cursor (nearest first); long-press Forward lists up to 10 ahead.
- **In-memory only.** History resets on page reload and on project switch. No
  localStorage persistence.
- **Capture at the choke point.** History is pushed inside `select()` in
  `selection.svelte.ts` — the single function all navigation paths (containment
  tree, search, command palette, graph, inspector relationship endpoints, results
  panels, table cells) already funnel through — rather than an explicit
  `visitElement()` wrapper (misses future call sites) or an Inspector `$effect`
  observer (mount-lifecycle edge cases).

## State module — `frontend/src/lib/state/inspection-history.svelte.ts`

New module (`history.svelte.ts` is taken by the commit-history browser). Follows the
state-folder conventions: module-private `$state`, accessor functions only, a
`reset*()` for tests, re-exported from `state/index.ts`.

```ts
type VisitEntry = { id: string; name?: string; type_name?: string };
// name/type_name are the LAST-KNOWN resolution, filled in lazily by the dropdown —
// not trusted to exist. Entries are pushed with only the id (the element may not
// be fetched yet at select() time).

let _stack: VisitEntry[] = $state([]);
let _cursor = $state(-1);   // index of the current entry in _stack
let _navigating = false;    // re-entrancy guard: replay must not re-push
```

API:

- `pushVisit(id: string)` — no-op when `_navigating` is set or when
  `id === _stack[_cursor]?.id` (consecutive dedup). Otherwise: truncate the stack
  after the cursor (a new visit destroys the forward stack, like a browser), append
  `{ id }`, advance the cursor. Stack is capped at **50** entries; overflow drops the
  oldest entry and shifts the cursor.
- `canGoBack(): boolean` / `canGoForward(): boolean`.
- `goBack()` / `goForward()` / `goTo(index: number)` — set `_navigating`, call
  `select({ kind: 'element', id })`, move the cursor, clear the guard in `finally`.
- `backEntries(limit = 10)` / `forwardEntries(limit = 10)` — nearest-first slices
  (with their absolute stack indices) for the dropdowns.
- `noteResolved(id, name, type_name)` — write-back hook the dropdown uses to stamp a
  successful display resolution onto matching entries.
- `remapIds(idMap: Record<string, string>)` — rewrites stored entry ids after a
  commit delta; called from the same place `model.svelte.ts` (~line 374) already
  remaps the live selection through `d.id_map`.
- `resetInspectionHistory()` — clears everything; called from the project-open flow
  (alongside `initWorkspaceTabs(projectId)`) and in test `beforeEach`.

## Capture hook — `selection.svelte.ts`

One guarded line inside `select(s)`:

```ts
if (s?.kind === 'element') pushVisit(s.id);
```

This creates a module cycle (selection imports `pushVisit`; inspection-history
imports `select`). ES-module cycles are benign when all cross-references happen at
call time rather than module-init time, which is the case here. If the bundler or
tests choke on it anyway, the fallback is inversion: inspection-history exposes
`registerNavigate(fn)` and selection (or an init site) registers `select` into it,
so only one import direction remains.

## Entry display resolution

The dropdown resolves display data **at open time**, not push time:

1. `getStagedNameOverride(id)` (uncommitted rename overlay) →
2. `getTreeElements()` merged cache (`elementDisplayName(el)` + `el.type_name`) →
3. entry's last-known `name`/`type_name` from a previous resolution →
4. ellipsized id alone.

Successful resolutions are written back onto the entry (`noteResolved`), so an
element deleted later still shows its last-known name in the dropdown. Entries for
deleted elements remain navigable: landing on one shows the Inspector's existing
"Selection not found" state. No pruning.

## UI — Inspector header nav cluster

- A thin toolbar row at the top of `Inspector.svelte`, rendered in **all** Inspector
  states (no-selection, loading, not-found, loaded) so Back still works after a
  deselect. Lucide `ChevronLeft` / `ChevronRight` in ghost icon `Button`s
  (`ui/button`), disabled per `canGoBack()` / `canGoForward()`.
- Each arrow is wrapped in a **controlled** bits-ui `DropdownMenu` (`bind:open`,
  programmatic open — the default click-trigger is not used).
- **Long-press gesture** — new reusable Svelte action (e.g.
  `lib/actions/long-press.ts`): `pointerdown` starts a ~500 ms timer; `pointerup`
  before it fires → normal click (navigate one step); `pointermove` beyond a small
  threshold, `pointerleave`, or `pointercancel` cancels; when the timer fires, the
  ensuing click is suppressed and the menu opens. `contextmenu` (right-click) also
  opens the menu, matching browser toolbar behavior.
- **Menu items**: Name (regular weight), Stereotype (muted), ellipsized id
  (mono, `text-xs`, CSS `truncate`). Selecting an item calls `goTo(index)` and
  closes the menu. Max 10 items per direction.

## Testing

- **State test** `frontend/src/lib/state/__tests__/inspection-history.test.ts`
  (modeled on `workspace.test.ts`): push/consecutive-dedup/forward-truncation/50-cap
  (cursor shift), back/forward/goTo movement and `select()` invocation, the
  re-entrancy guard (goBack must not push), `remapIds`, `resetInspectionHistory`.
- **Component test** co-located with the existing Inspector tests
  (`components/__tests__/`, MSW + `mount`/`flushSync`): arrows disabled on empty
  history and enabled after visits; click-Back selects the previous element;
  long-press (vitest fake timers + dispatched `PointerEvent`s, precedent in
  `Table/__tests__/TableGrid.test.ts`) opens the dropdown with resolved
  Name/Stereotype/id rows; clicking a row jumps and updates the cursor.
- Wiring checks: barrel export in `state/index.ts`; a one-line entry in
  `frontend/README.md` "Where to find things"; reset called on project open;
  remap called on commit delta.

## Out of scope (YAGNI)

Keyboard shortcuts (Alt+←/→), localStorage persistence, relationship visits,
pruning deleted entries, backend involvement of any kind.
