# data-rover-py — frontend

A SvelteKit single-page UI for the `data-rover-py` MBSE engine. Browse a model,
edit elements and relationships against a live metamodel, validate, and save
snapshots back to the FastAPI backend.

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
│  TopBar   metamodel ▾  model ▾   Validate    Save (n)    │
├────────────┬─────────────────────────┬───────────────────┤
│  Sidebar   │  Workspace              │  Inspector        │
│  Search    │  ┌────────────────────┐ │  Properties       │
│  Types  +  │  │ Detail / Graph /   │ │  Relationships    │
│  Tree      │  │ Issues             │ │                   │
│            │  └────────────────────┘ │                   │
├────────────┴─────────────────────────┴───────────────────┤
│  StatusBar   n elements · n unsaved · errors/warn · rev  │
└──────────────────────────────────────────────────────────┘
```

- **TopBar** — load a metamodel from file, load a model from file, trigger
  validation, open the diff drawer to save to a file.
- **Sidebar** — fuzzy search, type filter (each concrete type has a `+` button
  to create a new element of that type), containment tree with keyboard nav.
- **Workspace** — tabbed Detail / Graph / Issues view of the current
  selection.
- **Inspector** — property form + relationships list + new-relationship
  picker for the selected entity.
- **StatusBar** — model size, unsaved-change counter, validation summary,
  current model filename.

## Keyboard shortcuts

| Shortcut         | Action                              |
| ---------------- | ----------------------------------- |
| `Cmd/Ctrl+K`     | Open the command palette            |
| `Cmd/Ctrl+S`     | Open the diff drawer (Save)         |
| `Cmd/Ctrl+E`     | Run validation                      |
| `Cmd/Ctrl+1`     | Switch to Detail tab                |
| `Cmd/Ctrl+2`     | Switch to Graph tab                 |
| `Cmd/Ctrl+3`     | Switch to Issues tab                |
| `Arrow Up/Down`  | Move focus in the containment tree  |
| `Arrow Left/Right` | Collapse / expand tree row        |
| `Enter` / `Space`  | Select focused tree row           |

`Cmd+K` and `Cmd+S` fire even when focus is inside an input; the others are
suppressed while typing.

## Architecture

### State model

The client never mutates the baseline model. Instead:

1. A baseline `ModelOut` comes from uploading a model file to `POST /api/v1/model`
   and is stored client-side.
2. The user's edits are emitted as **ops** (`create_element`,
   `update_element`, `delete_element`, and the matching three for
   relationships) into a `pendingOps` array. Each op references either the
   baseline id or a `tmp_*` temp id.
3. A pure `apply(baseline, ops)` derives the **working model** — what the
   user sees in the tree / detail / graph views.
4. A pure `computeDiff(baseline, working)` produces the **diff** rendered in
   the drawer and the status bar.
5. On Save, temp ids are resolved, the snapshot is PUT to
   `/api/v1/model/snapshot`, and the returned model is written to a file via
   the File System Access API (or a browser download fallback).

This keeps undo, diffing, and conflict detection trivial: at any moment the
truth is `(baseline, ops)`.

### Where to find things

```
src/
  app.html              SvelteKit shell
  routes/+page.svelte   Single page; grids the four panels + diff drawer
  lib/
    api/                Typed REST client, zod schemas, ApiError, MSW tests
    state/              baseline / pendingOps / working / diff / selection
                        ui / filters / metamodel / workspace / validation
    metamodel/          Pure helpers (effective properties, multiplicity,
                        containment, subtype) mirroring the Python schema
    components/         TopBar, Sidebar, Workspace, Inspector, StatusBar,
                        DiffDrawer, CommandPalette, dialogs, and ui/ shadcn
                        primitives (button, dialog, dropdown-menu, …)
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
up. The smoke covers load metamodel from file → load an empty model → add
element → edit → confirm the change appears in the diff drawer.

## Type-checking & lint

```sh
pixi run -e frontend npm run check    # svelte-check
pixi run -e frontend npm run lint     # prettier + eslint
pixi run -e frontend npm run format   # prettier --write
```
