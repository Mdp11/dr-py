# data-rover-py — frontend

A SvelteKit single-page UI for the `data-rover-py` MBSE engine. Browse a model,
edit elements and relationships against a live metamodel, validate, and commit —
all against a FastAPI backend session that holds the model and streams deltas,
pages, and files to the browser. Edits are staged locally and committed under a
lock; see the staged-commit flow below.

The app is rendered statically (adapter-static) and proxies `/api/v1/*` to the
backend in dev. It does not require Node at runtime — only at build time.

## Running

All tasks are wired through `pixi` so you don't need a global `node`.

```sh
# install the npm deps (creates frontend/node_modules)
pixi run frontend-install

# dev server on http://127.0.0.1:5173 (proxies /api/v1 -> :8000)
pixi run frontend-dev

# production build into frontend/build (static, hashed assets)
pixi run frontend-build
```

In a separate terminal, start the backend (`pixi run -e api serve`) before
opening the dev server so the API calls succeed.

## Layout

The UI is a fixed grid:

```
┌──────────────────────────────────────────────────────────┐
│  TopBar   metamodel ▾  model ▾   Validate   Commit (n)   │
├────────────┬─────────────────────────┬───────────────────┤
│  Sidebar   │  Workspace              │  Inspector        │
│  Search    │  ┌────────────────────┐ │  Properties       │
│  Types  +  │  │ Detail / Graph /   │ │  Relationships    │
│  Tree      │  │ Issues             │ │                   │
│            │  └────────────────────┘ │                   │
├────────────┴─────────────────────────┴───────────────────┤
│  StatusBar   n elements · n staged · errors/warn · rev   │
└──────────────────────────────────────────────────────────┘
```

- **TopBar** — load a metamodel from file, load a model from file, Undo the
  last staged edit, trigger validation, open the Commit review (`DiffDrawer`),
  browse the durable commit history (`HistoryDrawer`), and open **Settings**
  (`SettingsDialog`) where an owner can toggle **strict mode**.
- **Sidebar** — fuzzy search, type filter (each concrete type has a `+` button
  to create a new element of that type), containment tree with keyboard nav and
  per-row lock badges.
- **Workspace** — tabbed Detail / Graph / Issues view of the current
  selection.
- **Inspector** — property form + relationships list + new-relationship
  picker for the selected entity (gated when the resource is locked by a peer).
  For elements it also carries a **lock/unlock control** (`Inspector/LockControl`)
  in the Properties header: **Lock** checks the element out without editing it
  (`editLock`); **Unlock** releases my lease (`discardElement`), confirming first
  when the element has staged edits (they are discarded); a peer's lock shows as
  a disabled "Locked by …" badge.
- **StatusBar** — model size, staged-change counter, validation summary,
  live/presence indicator, current model filename.

## Keyboard shortcuts

| Shortcut           | Action                             |
| ------------------ | ---------------------------------- |
| `Cmd/Ctrl+K`       | Open the command palette           |
| `Cmd/Ctrl+S`       | Open the Commit review             |
| `Cmd/Ctrl+E`       | Run validation                     |
| `Cmd/Ctrl+1`       | Switch to Detail tab               |
| `Cmd/Ctrl+2`       | Switch to Graph tab                |
| `Cmd/Ctrl+3`       | Switch to Issues tab               |
| `Arrow Up/Down`    | Move focus in the containment tree |
| `Arrow Left/Right` | Collapse / expand tree row         |
| `Enter` / `Space`  | Select focused tree row            |

`Cmd+K` and `Cmd+S` fire even when focus is inside an input; the others are
suppressed while typing.

## Architecture

### State model (staged-commit flow)

The **backend session model is the source of truth**; the client never holds
the whole model. The central store is `lib/state/model.svelte.ts`, and editing
follows a pessimistic **check-out → stage → commit** loop (Spec B):

1. The store caches only the **fetched subset** of the model — entities
   brought in by paged reads, searches, neighborhoods, and commit deltas —
   plus model-wide counters (`/model/summary`) for headers and the status bar.
2. The user's edits are emitted as **ops** (`create_element`,
   `update_element`, `delete_element`, and the matching three for
   relationships). Each op is applied to the local caches **optimistically**
   and pushed onto a **staged-edits buffer** — there is **no auto-flush**.
   Property updates of the same entity coalesce into one staged op. The buffer
   is held locally until an explicit commit.
3. The **first edit of a resource auto-acquires a lock** through the checkout
   store (`lib/state/checkout.svelte.ts`): it derives the required locks from
   the staged ops, calls `POST /locks`, and starts a heartbeat that renews the
   leases (`POST /locks/renew`) while the buffer is dirty. A 409 lock conflict
   surfaces as an edit-gate notice and the edit is refused. Lock expiry
   (observed over the realtime feed) marks the resource stale.
4. **Commit** (`Cmd/Ctrl+S` opens the review in `DiffDrawer`) runs
   `POST /commits/preview` to validate the staged dirty set, shows the diff +
   any conformance issues / structural blockers, then `POST /commits` to apply
   the batch durably; on success it clears the staged buffer, installs the
   server's canonical delta (`applyDelta`), and **releases the held locks**.
   A stale-rev 409 or a structural-blocker 422 is surfaced as a commit error.
5. **Undo** is **client-side** over the staged buffer (`popLastStaged` reverts
   the last staged op from its per-op journal); per-element and discard-all
   reverts (`revertStagedFor` / `revertAllStaged`) work the same way. There is
   no server-side undo in the editing loop.
6. Reads are **paged/on-demand**: element pages and fuzzy search
   (`/model/elements`), containment tree roots/children
   (`/model/containment/*`), and BFS neighborhoods for the graph view
   (`/model/elements/{id}/neighborhood`).
7. **Export** streams the last committed session state to a file: a picked
   file goes up as a raw `fetch` body (`POST /model/upload`, no JS-side parse)
   or by server path (`POST /model/load`); export pipes `GET /model/download`
   into a File System Access writable (or writes server-side via
   `POST /model/save`), so the browser never materializes the serialized model
   as a string. Export reflects the committed model, not the staged buffer.

### Settings dialog + strict-mode toggle

The **Settings** button in the TopBar opens `SettingsDialog.svelte`, which
exposes project-level configuration:

- **Strict mode** toggle — owner-gated (`role === 'owner'`). Reads the current
  value via `GET /api/v1/projects/{id}/settings` and writes changes via
  `PATCH /api/v1/projects/{id}/settings` (implemented in `lib/api/settings.ts`).
  Non-owners see the toggle but it is disabled.
- **Effect on commits** — when strict mode is on, `POST /commits/preview`
  returns `would_block: true` if the scoped dirty set has any conformance
  errors (multiplicity, facets, endpoint typing, uniqueness). The `DiffDrawer`
  reads `preview.would_block` and: (1) shows a "Strict mode is on: N validation
  issue(s) must be resolved before committing" alert, and (2) disables the
  Commit button (`commitBlocked = structuralBlockers.length > 0 || wouldBlock`).
  When strict mode is off the same batch shows "Commit anyway (N)" and the
  button is enabled — conformance issues are surfaced but do not block.
- **Scoped to the dirty set** — the gate inspects only the elements and
  relationships the commit batch touched (no whole-model re-validation), so it
  is safe to enable on an already-non-conforming project: pre-existing issues
  elsewhere do not block a commit.
- **Rebind is exempt** — `POST /commits/metamodel-swap` (rebind) never passes
  through the strict gate; swapping the metamodel always succeeds regardless of
  the setting.

### Commit history browser (History drawer)

The **History** button in the TopBar opens `HistoryDrawer.svelte`, which
browses the project's durable commit journal:

- **List view** — fetches `GET /commits` (paged, newest-first) via
  `state/history.svelte.ts` and renders one row per commit with its rev label,
  message, author, timestamp, and op count. Live-refreshes via the realtime
  feed (commit events trigger a page reload while the drawer is open).
- **Per-commit diff** — clicking a row's "Diff" button reconstructs the model
  at `rev - 1` and at `rev` using `GET /commits/{rev}/model` (results are
  cached in a rev → `ModelOut` map to avoid re-fetching on rapid navigation),
  then passes both snapshots to `computeDiff`/`CompareDiff` which render
  element-level added / modified / deleted counts and per-element property
  changes.
- **Two-commit compare** — the "Compare" toggle lets the user select any two
  revisions A and B; the same `computeDiff` path reconstructs both models and
  renders the range diff. A warning banner is shown when the range spans a
  metamodel-swap (rebind) commit.
- **Revert-to-commit** (`POST /commits/revert`) — gated on a clean staged
  buffer (`getStagedDepth() === 0 && getLockState().size === 0`). Selecting
  "Revert to here" on a row shows an inline confirm panel with an optional
  message; submitting applies the compensating inverse ops as a new durable
  commit (history stays append-only, `model_rev` advances), broadcasts the
  delta via the feed, and reloads the history list.

### Where to find things

```
src/
  app.html              SvelteKit shell
  routes/+page.svelte   Single page; grids the four panels + diff drawer
  lib/
    api/                Typed REST client (client.ts), zod schemas, errors;
                        model-ops / model-read wrap the delta endpoints;
                        feed.ts — WebSocket wrapper (auto-reconnect with
                        exponential backoff, injectable socketFactory for
                        tests; pure transport, no app state)
    api/history.ts      REST client for the commit-history endpoints:
                        getCommitHistory (GET /commits, paged) and
                        getModelAtRev (GET /commits/{rev}/model);
                        revertToCommit (POST /commits/revert)
    api/settings.ts     REST client for project settings:
                        getSettings (GET /settings) and
                        updateSettings (PATCH /settings → strict_mode bool)
    state/              model.svelte.ts (staged-edit store) / changes (server
                        change-set badge) / selection / ui / filters /
                        metamodel / workspace / validation / file (filename
                        + FS Access handle); realtime.svelte.ts — feed
                        transport store: connection status, presence
                        (string[]), lock state (SvelteMap resource_id →
                        LeaseLite), applies remote commit deltas via
                        applyDelta; checkout.svelte.ts — lock registry,
                        ensureCheckout/heartbeat, preview/commit, discard,
                        role gating; edit-gate.ts — maps an edit intent to its
                        required locks and gates the mutation; lock-badge.ts —
                        per-row lock badge derivation; lock-notice.svelte.ts —
                        transient lock-conflict notice; api/checkout.ts — the
                        locks + commits REST client; history.svelte.ts —
                        commit-list store (paged GET /commits), rev→ModelOut
                        reconstruction cache, resetHistory/loadFirstPage/
                        loadMore/modelAt
    metamodel/          Pure helpers (effective properties, multiplicity,
                        containment, subtype) mirroring the Python schema
    components/         TopBar, Sidebar, Workspace, Inspector, StatusBar,
                        DiffDrawer, HistoryDrawer, SettingsDialog,
                        CommandPalette, dialogs, and ui/ shadcn primitives
                        (button, dialog, dropdown-menu, …)
    keyboard.ts         Pure shortcut matcher
    keyboard.svelte.ts  Global window listener + dispatch to state
```

## Tests

```sh
# Unit tests (vitest + happy-dom + MSW)
pixi run -e frontend npm test

# End-to-end smoke (Playwright + chromium, headless)
pixi run -e frontend bash -c 'cd frontend && npx playwright install chromium && npm run test:e2e'
```

The Playwright config (`playwright.config.ts`) boots both the backend
(`pixi run -e api serve`) and the Vite dev server, and reuses them if already
up. The suites cover: load metamodel → load model → create element → edit →
confirm the Commit review; check-out → edit → commit with the smart-city
example; relationship picker; drag-and-drop view curation; advanced search;
History: open drawer → list commits → diff → revert with compensating commit;
and Strict mode: enable via Settings → create a conformance-violating element
→ assert the Commit button is disabled with the strict-mode alert → disable
strict mode → assert the same batch can now commit.

**Known infra note**: `rm -f /tmp/data-rover-e2e.db` before each fresh run
clears the SQLite journal so the in-memory snapshot store stays in sync. When
`reuseExistingServer: true` keeps an existing backend alive, the rm is skipped
automatically (the db and store are already in sync for the live process).

## Type-checking & lint

```sh
pixi run -e frontend npm run check    # svelte-check
pixi run -e frontend npm run lint     # prettier + eslint
pixi run -e frontend npm run format   # prettier --write
```
