# data-rover-py — frontend

A SvelteKit single-page app (client-side routed; login, project picker, admin
console, and the workspace) for the `data-rover-py` MBSE engine. Users **log in**
(cookie-based email + password), pick a **project**, then browse a model, edit
elements and relationships against a live metamodel, validate, and commit — all
against a FastAPI backend session that holds the model and streams deltas, pages,
and files to the browser. Edits are staged locally and committed under a lock;
see the staged-commit flow below. Admins get an **Admin console** to manage users
and project membership.

The app is rendered statically (adapter-static) and proxies `/api/v1/*` to the
backend in dev. It does not require Node at runtime — only at build time.

## Running

All tasks are wired through `pixi` so you don't need a global `node`.

```sh
# install the npm deps (creates frontend/node_modules)
pixi run frontend-install

# dev server on http://127.0.0.1:5173 (proxies /api/v1 -> :8000)
pixi run frontend-start

# production build into frontend/build (static, hashed assets)
pixi run frontend-build
```

In a separate terminal, start the backend (`pixi run backend-start`) before
opening the dev server so the API calls succeed. See the **root `README.md`** for
the full local stack (Postgres + GCS emulator), dev-seed, and how to log in — on
first boot the backend ensures the bootstrap admin (`admin@example.com` /
`admin12345`) exists — no project is autoloaded; the app opens the **login**
page and projects are created via the New Project wizard.

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
  selection, plus **snippet** tabs (`SnippetTab`) hosting a CodeMirror editor
  and run console for server-executed Python snippets against the live model.
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

### Auth, projects & routing

Access is **cookie-based** and project-scoped. The shape:

- **Routing & guard** — `routes/+layout.ts` (`ssr=false`) runs on every
  navigation: it calls `fetchMe()` (`GET /api/v1/auth/me`) and feeds the result
  to the pure `routes/guard.ts` `guardDecision(pathname, me)` — unauthenticated →
  `/login`; authed on `/login` → `/projects`; non-admin on `/admin*` → `/projects`.
  `routes/+page.ts` redirects `/` → `/projects`. The routes are: `/login`,
  `/projects` (picker), `/admin` (console, admin-only), and
  `/p/[projectId]` (the workspace) + `/p/[projectId]/compare`.
- **App chrome** — `routes/+layout.svelte` renders `AppHeader` (email, Sign out,
  Projects, Admin-if-admin) on the picker/admin routes, but **not** inside the
  workspace (`/p/…`) or on `/login`.
- **Active project** — `routes/p/[projectId]/+layout.ts` calls
  `setActiveProject(params.projectId)` before the page boots, which points the
  project-scoped API base URL at `/api/v1/projects/{id}` (see
  `lib/state/active-project.svelte.ts` → `lib/api/client.ts`). Non-project-scoped
  calls (auth/admin/projects-list) pass an explicit `{ baseUrl: '/api/v1' }`.
- **Cookie + CSRF client** — every REST call funnels through
  `lib/api/client.ts` (`apiFetchRaw`): `credentials:'include'` always, and an
  `X-Requested-With: data-rover` header on unsafe methods (the CSRF token the
  backend `CSRFMiddleware` checks). The authenticated user id comes from
  `lib/state/auth.svelte.ts` (`fetchMe`/`signIn` adopt the `Me`, set it on the
  `lib/api/identity.ts` seam, and clear it on `signOut`).
- **Graceful denied-access** — the UI handles loss of access instead of blanking:
  a **403** on workspace boot (an admin opened a project they're visible-but-not-a-
  member of) sets an access notice and bounces to `/projects`
  (`routes/p/[projectId]/+page.svelte` + `lib/state/access-notice.svelte.ts`); the
  realtime feed treats close codes **4401/4403/4404** as terminal (no reconnect
  storm) and surfaces a banner; and a global **401** from any REST call triggers
  `lib/state/session-recovery.ts`, which clears auth + active project, stops the
  feed, and redirects to `/login` (a no-op when already logged out, so login's own
  401 still shows "invalid credentials" rather than looping).

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

### Navigation editor state (per-node previews)

`lib/state/navigation-editor.svelte.ts` holds the per-tab navigation drafts
(one draft + one save-conflict marker per `tabId`) and drives the live chain
preview. A navigation is a **tree** — a Path, or a set expression over nested
definitions addressed by positional `NodePath` (`lib/navigation/tree.ts`:
`pathKey`, `nodeAt`, `isRunnable`) — so preview state is keyed **per node**, not
per tab:

- **`previewKey(tabId, path) = ${tabId}::${pathKey(path)}`** keys `_previews`,
  `_evalErrors`, `_generations`, and `_debounceTimers`; `path === []` is the
  **root** node. `_expanded` maps a `tabId` to the set of expanded node
  pathKeys. A node is previewed **only while expanded** — the root is expanded
  by default (so a bare navigation still shows results), and `toggleExpanded`
  runs a node's preview immediately on expand and **drops it on collapse**
  (cancel timer, delete preview/eval-error, bump generation).
- **Auto-run + staleness are per node.** There is no Run button:
  `updateDefinition` reschedules a **debounced** run for **every expanded node**
  (`AUTO_RUN_DEBOUNCE_MS`), re-reading `nodeAt(currentDraft, path)` at fire time
  (a later edit resets that node's timer _and_ supplies the node sent); a node
  whose address no longer resolves is dropped from the expanded set. Each node
  carries its own **generation counter**: any edit / newer run / collapse /
  `closeDraft` / reset bumps it, and the async preview functions capture it
  before their await and drop a stale response (or one whose draft is gone), so
  a slow round-trip can never revive a cleared node preview or clobber a fresher
  one. A **still-current** failure sets that node's `_evalError` flag, which
  `ChainPreview` surfaces. `nodeAt` returns null for a **ref** operand — refs
  get no per-node preview this iteration and are skipped.
- **Accessors are node-scoped** (`getPreview`/`getEvalError`/`isExpanded`/
  `runPreview`/`loadMorePreview` all take `(tabId, path)`, `path` defaulting to
  the root `[]`); `getDraft`/`getSaveConflict`/`updateDefinition`/`saveDraft`
  stay per-tab. `closeDraft` and `resetNavigationEditors` clear **every** node
  key for the tab (expanded set plus any lingering keys), cancel all timers, and
  bump generations so nothing leaks.

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
  routes/
    +layout.ts          Client-side load: fetchMe() + guardDecision (auth guard)
    +layout.svelte      App chrome (AppHeader) on picker/admin routes
    +page.ts            Redirect / → /projects
    guard.ts            Pure guardDecision(pathname, me) — no redirect loops
    login/+page.svelte  Login page (LoginForm)
    projects/+page.svelte           Project picker (list + search + New Project)
    admin/+page.svelte              Admin console (Users + Members tabs)
    p/[projectId]/+layout.ts        setActiveProject → project-scoped base URL
    p/[projectId]/+page.svelte      The workspace; grids the four panels + drawers
    p/[projectId]/compare/+page.svelte  Two-model compare screen
  lib/
    api/                Typed REST client (client.ts: cookie creds + CSRF
                        header, dynamic project base URL), zod schemas, errors;
                        model-ops / model-read wrap the delta endpoints;
                        auth.ts (login/logout/me/changePassword), projects.ts
                        (list/create), admin.ts (user + member CRUD),
                        identity.ts (current-user-id seam);
                        feed.ts — WebSocket wrapper (auto-reconnect with
                        exponential backoff, TERMINAL on close 4401/4403/4404,
                        injectable socketFactory for tests; pure transport)
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
                        + FS Access handle); auth.svelte.ts — current user +
                        signIn/signOut; active-project.svelte.ts — active id +
                        base-URL wiring; access-notice.svelte.ts — denied-access
                        message for the picker; session-recovery.ts — global
                        401 → clear + bounce to /login; realtime.svelte.ts —
                        feed transport store: connection status, presence
                        (string[]), lock state (SvelteMap resource_id →
                        LeaseLite), feed-termination state, applies remote
                        commit deltas via applyDelta; checkout.svelte.ts — lock
                        registry, ensureCheckout/heartbeat, preview/commit,
                        discard, role gating; edit-gate.ts — maps an edit intent
                        to its required locks and gates the mutation;
                        lock-badge.ts — per-row lock badge derivation;
                        lock-notice.svelte.ts — transient lock-conflict notice;
                        api/checkout.ts — the locks + commits REST client;
                        history.svelte.ts — commit-list store (paged
                        GET /commits), rev→ModelOut reconstruction cache,
                        resetHistory/loadFirstPage/loadMore/modelAt;
                        unsaved.ts — hasUnsavedWork() (staged ops + dirty
                        table/navigation drafts), input to the workspace
                        unload guard (beforeNavigate in p/[projectId]/+page);
                        snippet-editor.svelte.ts — per-tab code-snippet
                        drafts, save lifecycle, debounced lint + run/stop
                        state; snippet-stage.ts — folds a snippet run's op
                        batch into the staged-edits buffer (temp-id remap,
                        pre-state prefetch, per-intent lock groups);
                        snippet-docs.svelte.ts — fetch-once cache of the
                        facade docs payload (ensureSnippetDocs/
                        getSnippetDocs), silent-degrade on fetch failure,
                        reset at onReloadModel
    editor/completion-source.ts  dr./Element/type-name CM6 completions +
                        hover logic (vocabFromMetamodel, computeCompletions,
                        resolveDocAt); pure, CM-agnostic, unit-tested
    snippet/docs-view.ts   View-model helpers for the facade docs panel
                        (groupFacade, formatSeconds/formatBytes, type +
                        relationship summaries); mirrors console-view.ts
    metamodel/          Pure helpers (effective properties, multiplicity,
                        containment, subtype) mirroring the Python schema
    components/         TopBar, Sidebar, Workspace, Inspector, StatusBar,
                        DiffDrawer, HistoryDrawer, SettingsDialog,
                        CommandPalette, AppHeader, dialogs, and ui/ shadcn
                        primitives (button, dialog, dropdown-menu, …);
                        auth/LoginForm, projects/{ProjectCard,NewProjectWizard},
                        admin/{UsersTab,ProjectMembersTab}
    keyboard.ts         Pure shortcut matcher
    keyboard.svelte.ts  Global window listener + dispatch to state
```

## Tests

npm scripts have no pixi wrappers, so they must run **inside `frontend/`** — the
bare `pixi run -e frontend npm test` fails ("Missing script") because pixi runs
it from the repo root. Use the `cd frontend` form:

```sh
# Unit tests (vitest + happy-dom + MSW)
pixi run -e frontend bash -c 'cd frontend && npm test'

# End-to-end smoke (Playwright + chromium, headless)
pixi run -e frontend bash -c 'cd frontend && npx playwright install chromium && npm run test:e2e'
```

The Playwright config (`playwright.config.ts`) boots both the backend
(`pixi run -e api backend-start` against an ephemeral SQLite DB +
`DATA_ROVER_IDENTITY_PROVIDER=cookie`) and the Vite dev server, and reuses them
if already up. Because auth is cookie-based, the specs **log in first** (see
`e2e/helpers/auth.ts`, which signs in as the seeded admin and opens the `default`
project). The suites cover: login + project picker + admin console
(`auth.spec.ts`); then, in the workspace — load metamodel → load model → create
element → edit → confirm the Commit review; check-out → edit → commit with the
smart-city example; relationship picker; drag-and-drop view curation; advanced
search; History: open drawer → list commits → diff → revert with compensating
commit; Strict mode: enable via Settings → create a conformance-violating
element → assert the Commit button is disabled with the strict-mode alert →
disable strict mode → assert the same batch can now commit; and the snippet
workspace tab (`snippet-flow.spec.ts`): lint gutter surfaces a sandbox-import
warning, run prints to the console via the real WASM sandbox, and stage +
commit a snippet run's op batch.

**Known infra note**: `rm -f /tmp/data-rover-e2e.db` before each fresh run
clears the SQLite journal so the in-memory snapshot store stays in sync. When
`reuseExistingServer: true` keeps an existing backend alive, the rm is skipped
automatically (the db and store are already in sync for the live process).

## Type-checking & lint

Same rule — run these inside `frontend/`:

```sh
pixi run -e frontend bash -c 'cd frontend && npm run check'    # svelte-check
pixi run -e frontend bash -c 'cd frontend && npm run lint'     # prettier + eslint
pixi run -e frontend bash -c 'cd frontend && npm run format'   # prettier --write
```
