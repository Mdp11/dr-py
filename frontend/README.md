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
│  Types  +  │  │ tables / nav /     │ │  Relationships    │
│  Tree      │  │ snippets / issues  │ │                   │
│            │  └────────────────────┘ │                   │
├────────────┴─────────────────────────┴───────────────────┤
│  StatusBar   n elements · n staged · errors/warn · rev   │
└──────────────────────────────────────────────────────────┘
```

- **TopBar** — a growable toolbar `<nav>` next to the logo holds **eight flat
  icon+text controls**, in this order: **Artifacts** (`ArtifactsMenu.svelte`
  — Export…/Import…, with Import hidden for viewers), **Issues** (opens the
  singleton Issues tab), **Compare** (the two-model compare screen),
  **Apply CR**, **Edit Metamodel** (opens the live metamodel editor tab),
  **Export** (downloads the current model), **History** (`HistoryDrawer`),
  and **Settings** (`SettingsDialog`, where an owner can toggle **strict
  mode**). There is no overflow/three-dots menu. The right side holds the
  validation chip, **Undo** the last staged edit, **Validate**, **Commit**
  (opens `DiffDrawer`), the strict-mode badge, and the staged-changes counter.
- **Sidebar** — fuzzy search, type filter (each concrete type has a `+` button
  to create a new element of that type), containment tree with keyboard nav and
  per-row lock badges.
- **Workspace** — a **dynamic-tabs-only** strip: opening an artifact from the
  sidebar or Issues from the top bar adds a closable tab, and the strip
  carries no fixed tabs of its own. With zero tabs open it renders a quiet
  centered placeholder ("Open an artifact from the sidebar, or Issues from
  the top bar."). Closing the active tab focuses the previous tab in strip
  order; closing the last one leaves the placeholder. Tab kinds: **table**
  (`TableView`), **snippet** (`SnippetTab`) hosting a CodeMirror editor and
  run console for server-executed Python snippets against the live model,
  **navigation** (`NavigationBuilder`), **exporter** (`ExporterTab`),
  the singleton **metamodel** tab (`MetamodelTab`) — a YAML editor for the
  live metamodel with lint, preview and staged (commit-through) edits — and
  the singleton, closable **issues** tab (`IssuesPanel`), opened from the top
  bar's Issues button and deduped by kind exactly like the metamodel tab.
- **Inspector** — property form + relationships list + new-relationship
  picker for the selected entity (gated when the resource is locked by a peer).
  A back/forward arrow cluster (`Inspector/HistoryNav`) sits above it, replaying
  the trail of inspected elements, with a long-press/right-click dropdown of up
  to 10 entries per direction.
  For elements it also carries a **lock/unlock control** (`Inspector/LockControl`)
  in the Properties header: **Lock** checks the element out without editing it
  (`editLock`); **Unlock** releases my lease (`discardElement`), confirming first
  when the element has staged edits (they are discarded); a peer's lock shows as
  a disabled "Locked by …" badge.
  Beside it sits the **Delete** action — the only element-deletion trigger in
  the app: confirm → `deleteLock` (DELETE intent) → staged `delete_element`,
  then deselect. It is disabled for viewers and while a peer holds the
  element's lock, since neither can take the lease the delete needs.
  A relationship selection instead gets a **source → target** pair of buttons
  under the stereotype header: the Relationships section is element-only, so
  without them a relationship reached from an issue row would be a
  navigational dead end.
- **StatusBar** — model size, staged-change counter, validation summary,
  live/presence indicator, current model filename.

## Keyboard shortcuts

| Shortcut           | Action                             |
| ------------------ | ---------------------------------- |
| `Cmd/Ctrl+S`       | Open the Commit review             |
| `Cmd/Ctrl+E`       | Run validation                     |
| `Arrow Up/Down`    | Move focus in the containment tree |
| `Arrow Left/Right` | Collapse / expand tree row         |
| `Enter` / `Space`  | Select focused tree row            |

There is no command palette; these are the only global shortcuts
(`keyboard.ts` / `keyboard.svelte.ts`). `Cmd+S` fires even when focus is
inside an input; `Cmd+E` is suppressed while typing.

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
follows a pessimistic **check-out → stage → commit** loop:

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
   Staged elements are also browsable: the sidebar's **"Staged elements"**
   section (`components/Sidebar/StagedSection.svelte`, rows derived by
   `state/staged-rows.ts`) lists every element the buffer touches — new /
   edited / deleted, badged — which is the ONLY way to reach a temp-id element
   (it exists nowhere in the server-paged containment tree). Its per-row revert
   is `discardElementCascade`, which reverts via `revertStagedForElement` (the
   element's own ops PLUS every staged relationship op incident to it — a
   surviving rel pointing at a reverted temp id would 422 the commit) and then
   releases the element's lock token when no remaining staged op still needs it.
6. **Artifacts ride the same loop.** Saved navigations, tables, code
   snippets and exporters are project artifacts rather than model
   entities, but their editing is the identical check-out → stage → commit
   shape, so the client
   holds **no artifact write wrapper at all**: `lib/api/artifacts.ts` is
   read-only (`listArtifacts`, `getArtifact`, `evaluateNavigation`). The
   backend's legacy `POST/PUT/DELETE /artifacts` routes still exist and still
   honor `art:` leases; the client simply never reaches for them, because an
   unlocked write lands outside the commit journal — invisible to the
   DiffDrawer, absent from the `Commit` row, unreachable by undo.
   - **Save = stage.** Each editor's Save pushes a `create_artifact` /
     `update_artifact` / `delete_artifact` op onto a SECOND staged buffer,
     `lib/state/artifact-edits.svelte.ts` (the artifact sibling of the model
     store's buffer). Its invariant is **one staged entry per artifact id**,
     and that is correctness, not tidiness: the backend's applier
     (`api/artifact_ops.py`) resolves `update`/`delete` ids **literally**,
     never through the batch's `id_map`, so a batch carrying both
     `create_artifact{temp_id: tmp_x}` and `update_artifact{id: tmp_x}` is a
     hard 422. Every `stageArtifact*` call therefore COALESCES into the
     artifact's existing entry — update-over-create merges into the create,
     update-over-update keeps whichever fields the later call omits,
     delete-over-create drops both ops (nothing exists server-side to
     delete), delete-over-update collapses to a bare delete.
   - **Exporters are workspace tabs too**, keyed like every other
     artifact editor by a kind-prefixed tab id — `nav:`/`snip:` and now
     `exp:` (`exp:draft:<n>` for an unsaved draft, `exp:<artifactId>` once
     saved). `state/exporter-editor.svelte.ts` is the `exp:` sibling of
     `snippet-editor.svelte.ts`: the same per-tab draft map, lock-denied
     banner, save-stages-not-posts flow, and commit/discard/staged-delete
     listener trio that rebinds a `exp:draft:N` tab to `exp:<id>` off the
     commit's `id_map` rather than re-keying eagerly. Its one kind-specific
     idea is **copy-at-add**: `addExporterEntry` (`Export/ExporterTab.svelte`'s
     add-table picker) builds each `ExporterEntry` via `entryForTable`, which
     COPIES the source table's current export settings rather than
     referencing them — from that instant the entry and the table are
     independent, so a later edit to either does not follow the other. An
     entry's overrides can still be re-derived against the table's _current_
     definition on demand (`applyEntryOverrides`/`overridesFromDefinition`,
     used by `Export/EntryLayoutDialog.svelte` — see "Table export settings"
     below), but nothing keeps the two in sync automatically.
   - **The output-settings bar** (`ExporterTab.svelte`, visible only
     `{#if editable}` — a viewer gets no editing surface at all here, same as
     everywhere else in the tab) edits `draft.output` directly via
     `updateExporterOutput`: a filename-template input (`${token}`s, backend
     `naming.py` vocabulary), a zip/bare mode toggle, and an
     "Include manifest" checkbox. Below it, each entry row carries its own
     **folder** input (`entry.folder`, also a `${token}` template) alongside
     its name/format controls — `updateExporterEntry(tabId, i, { folder })`.
     Neither input validates client-side: per the strict-at-export /
     never-block-Save rule, a bad token or an absolute/traversal folder saves
     fine and only 422s at `POST /exports/run`, naming the offending entry.
   - **The transform hook.** Each JSON-family entry row
     (`isJsonFamily(entry.format)`) shows `Export/TransformPicker.svelte`, a
     ref-only combobox (the reusable core of `SnippetSourceEditor`'s ref mode,
     without its inline-code half — `transform` is `TableRef`-only by schema)
     over `entry.transform`; its options are committed `code_snippet`
     artifacts whose server-derived `entry_points` include `'transform'`
     (`entryAvailable`, `referenceableArtifactHeaders` — staged temp ids never
     reach a payload). Flipping an entry to `xlsx`/`csv` while it still holds
     a `transform` does not clear it (the server 422s it at run time — a
     functional contract is never tolerate-and-ignored) — the row
     shows a `export-entry-{i}-transform-warning` hint instead of silently
     dropping state the user might restore by flipping the format back.
     `entryForTable` deliberately does NOT copy the source table's own
     `transform` at add time (`transform: null`): a transform is a functional
     contract, not cosmetic presentation, so no-bleed applies at add-time too,
     not just at render time. In `lib/snippet/entry-stubs.ts`,
     `BoundEntry = 'value' | 'step' | 'transform'` names all three and
     `ConsoleEntry = Exclude<BoundEntry, 'transform'>` carves out the subset a
     console/embedded run (`POST /snippets/run`) supports — a console
     run has no document to bind `transform` against.
   - **No already-added filter on the add-table picker — deliberate.**
     `ExporterTab.svelte`'s `availableTables` lists every table, so the same
     table can be added more than once — e.g. once as a wide `.xlsx` and
     again as split-per-element JSON. This looks like a missing filter; it is
     not. The server dedupes colliding output names/folders at export time
     (`routes/exports.py`'s `_dedupe_path`), so a duplicate entry is legal
     server-side and a `usedRefs` filter would block a case the backend
     explicitly supports. Do not add one. The picker itself is
     `Export/AddTablePicker.svelte`: a client-side searchable combobox
     (`add-table-input`/`add-table-option-{id}` testids) — same ARIA pattern
     as `Sidebar/Search.svelte`, but candidates are the in-memory
     committed-table headers so there is no debounce and it shows every table
     on focus.
   - **The empty picker explains itself.** `availableTables` goes through
     `referenceableArtifactHeaders`, which drops staged-but-uncommitted
     creates (temp ids must never reach a payload), and a project can simply
     have no tables — either way the picker input is disabled, and a disabled
     input swallows clicks with no event and no console output, which
     reads as "the button is broken". A hint beside it
     (`add-table-empty-hint`) says why, distinguishing "no tables in this
     project yet" from "your tables are staged — commit them first" (the
     latter detected via the overlay list, temp ids included).
   - **The Export button is ungated.** It does not require a clean,
     committed draft: `exportDisabled` only checks for zero
     entries (disabled with the title "Add at least one table first"). A
     clean committed draft runs by `artifact_id` (`runExporter`); any
     dirty or never-committed draft ships its `{schema_version, output, entries}`
     inline as a `definition` via `runExporterDraft`
     (`lib/api/exports.ts`), which the backend validates and runs exactly
     like a committed payload (`RunExportIn.definition`).
     Referenced tables still evaluate from their own COMMITTED definitions
     either way — only the exporter's own presentation travels as a draft.
   - **The lease is per editor tab.** Opening a saved artifact takes an
     `art:<id>` exclusive lease (`acquireArtifactLease`); a denial does not
     refuse the open, it renders that tab **unsaveable and read-only** behind
     its holder banner ("Checked out by X — you will not be able to save"):
     the name input, Save and Save as are disabled, AND the definition-editing
     surface (PathCard/CombineFrame, the table's grid + column-manager chrome,
     the snippet CodeMirror host) is wrapped `inert={locked}` so a denied tab
     cannot accumulate edits it can never commit — previews, consoles and the
     results dock stay live. The banner's escape hatch is "Save as copy",
     wired to the existing `saveAsDraft`/`saveAsTableDraft` fork for
     nav/table and to the purpose-built `forkSnippetDraftAsCopy` for snippets
     (which had no prior Save-as): it stages a CREATE under a brand-new
     artifact id, needs no lease of its own, and — for the snippet fork —
     opens a SEPARATE tab, leaving the denied source tab's draft, denial
     state and artifact binding untouched. See the `ensureDraft` docstring in
     `lib/state/navigation-editor.svelte.ts` (mirrored by
     `table-editor.svelte.ts` and `snippet-editor.svelte.ts`) for the
     canonical statement of exactly what is gated. Closing releases through
     `releaseArtifactIfUnneeded`, which
     KEEPS the lease whenever a staged op still needs a resource that token
     covers — a saved-but-uncommitted edit whose lease lapsed would 409
     "required lock not held" at commit. The sidebar's two write surfaces
     take their own: rename takes a plain exclusive it deliberately never
     releases (every path past the acquire stages an op that needs it),
     delete takes a **DELETE-intent** exclusive that conflicts with any peer
     lease, shared pins included — and hands it straight back when the row
     turns out to be stale and there is nothing to stage.
   - **Commit is ONE mixed batch.** `previewStaged`/`commitStaged`
     concatenate `getStagedOps()` and `getStagedArtifactOps()` into a single
     `POST /commits/preview` / `POST /commits`; the backend splits the union
     itself. The token partition is the subtle part: `POST /commits` releases
     every token it is SENT, so an artifact lease whose artifact is NOT in
     this batch is held back for its still-open editor, while everything the
     batch needs is sent. Afterwards the DiffDrawer fires
     `reacquireOpenArtifactLeases` (fire-and-forget, `.catch`ed — the commit
     is already durable), re-checking-out every open artifact tab and
     flipping to lock-denied (unsaveable) via `markEditorLockDenied` any a peer
     grabbed in between.
   - **The DiffDrawer reviews them.** Staged artifact entries render as
     `+`/`~`/`-` rows in their own section, same glyph vocabulary as the
     entity rows, each per-row discardable through `discardArtifact` — the
     artifact sibling of `discardElement`, which also hands the `art:` lease
     back instead of stranding it for the full TTL. They
     count towards the drawer's `total`, which is what keeps Commit reachable
     for an artifact-ONLY batch and unreachable when nothing at all is staged
     — `commitStaged` throws on an empty batch, because the backend's
     empty-batch early return skips its lock-release step and would orphan
     the tokens until TTL.
   - **The library is server truth plus a staged overlay.**
     `lib/state/artifacts.svelte.ts` holds committed headers only;
     everything rendered goes through `getArtifactHeaders()`, which overlays
     the staged buffer (a rename shows its staged name, a staged delete is
     hidden, a staged create is appended under a TEMP id) and badges rows in
     the sidebar's artifacts section. `getCommittedArtifactHeaders()` is a
     separate function rather than a flag: a caller wanting committed truth
     is making a claim about the server. Reference pickers use neither —
     they go through `referenceableArtifactHeaders(kind)`, which drops temp
     ids. Note the reason, which is ordering and lifetime rather than an
     absence of rewriting: the backend DOES resolve temp ids nested inside a
     payload (`_resolve_json`), but only against the batch's `id_map` as it
     accumulates op by op, so a ref resolves only if its create ships in the
     SAME batch AHEAD of the artifact referencing it — and an unresolved one
     passes through as a tolerant dangler, not an error. A picker can promise
     neither that ordering nor that the user will not revert the create
     before committing, so it refuses to depend on either. Distinct from the
     sibling rule that artifact-OP ids (`update_artifact.id`,
     `delete_artifact.id`) get no `id_map` pass at all — THAT literalness is
     what makes the coalescing invariant above correctness.
   - **Commit feed events carry a `scope`.** `realtime.svelte.ts` adopts a
     peer commit's rev and applies its delta UNCONDITIONALLY (preview
     compares our `base_rev` with strict equality, so declining to adopt an
     artifact-only rev would 409 the next preview); only the `onCommitEvent`
     taps are handed `scope`, which lets the table editor skip its re-page
     when the commit touched no model content. An absent `scope` defaults to
     `['model']` — the defensive direction is the one that does more work.
7. Reads are **paged/on-demand**: element pages and fuzzy search
   (`/model/elements`), containment tree roots/children
   (`/model/containment/*`), and BFS neighborhoods for the graph view
   (`/model/elements/{id}/neighborhood`).
   **Every read fill-path must honor the staged-delete guard.** A staged
   delete removes the entity from the local caches while the server still
   returns it (nothing is committed yet), so a read result that re-inserts it
   would silently resurrect it — the staged diff row vanishes from the badge
   and DiffDrawer while the queued delete op still commits, and edits staged
   against the phantom 422 the eventual batch. `isStagedDeleted` /
   `isStagedDeletedRelationship` in `model.svelte.ts` are the predicates
   (the relationship flavor also catches a `delete_element` cascade's victims,
   which have journal entries but NO queued op of their own, so
   `hasQueuedOpFor` misses them); `ensureElement`/`ensureElements`/
   `ensureTreeItems` skip such ids (and re-check after the `await` for deletes
   staged mid-flight), and `seedRelationships`/`applyDelta` skip such
   relationships. A staged-deleted id is NOT added to `_missingElementIds` —
   that set means "the server confirmed it doesn't exist", and the Inspector
   checks `isStagedDeleted` separately to render not-found instead of an
   eternal skeleton.
8. **Export** streams the last committed session state to a file: a picked
   file goes up as a raw `fetch` body (`POST /model/upload`, no JS-side parse)
   or by server path (`POST /model/load`); export pipes `GET /model/download`
   into a File System Access writable (or writes server-side via
   `POST /model/save`), so the browser never materializes the serialized model
   as a string. Export reflects the committed model, not the staged buffer.

#### Validation issues: one live map, one optional overlay

There are **two** issue stores, and every consumer reads exactly one selector.

- **Live** — `_issuesByOwner` in `model.svelte.ts`, keyed by owner
  (`issue.target_ids[0]`), mirroring the backend's maintained `ValidationState`.
  It is the DEFAULT source: it holds committed truth and is kept fresh without
  anyone clicking anything.
- **Overlay** — `validation.svelte.ts` holds the origin-tagged snapshot of the
  last EXPLICIT Validate run. That run is the only view that can show
  `uncommitted` / `resolved` issues, because it is the only one that validated
  the staged buffer. `null` means "no overlay: render live". **`[]` is still an
  overlay** — a Validate that found nothing renders its own empty state, not the
  live list. `overlayMode = getOverlay() !== null` in `IssuesPanel.svelte` is the
  one place that distinction changes rendering.
- **`issue-source.ts`** is the selector: `getEffectiveIssues() = getOverlay() ??
getLiveIssues()`. All five consumers (issues panel, containment tree,
  diff drawer, inspector relationships list, top bar) read it, so they can never
  disagree. It is **its own module** because it imports BOTH stores — folding it
  into either creates the model ↔ validation import cycle.

The live map is refilled by `adoptIssues(issues, counts, rev, truncated)`, which
drops only **strictly older** revs: an EQUAL rev must be adopted, because the
backend's background validation sweep grows the server's store _without_ bumping
`model_rev`. `refetchIssues()` is the best-effort `GET /model/issues` wrapper
around it (generation-guarded, so a response for the project we just left is
dropped). Triggers, all of them best-effort:

| trigger                       | where                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| project boot                  | `boot()` in `routes/p/[projectId]/+page.svelte`                                                    |
| in-app model reload           | `onReloadModel()`, same file                                                                       |
| peer-rebind banner reload     | `onReloadRebind()`, same file (**never** a full validate)                                          |
| background-sweep completion   | `open-progress.svelte.ts`                                                                          |
| peer commit (300 ms debounce) | `realtime.svelte.ts`                                                                               |
| feed reconnect snapshot       | `realtime.svelte.ts` — **unconditional**, deliberately NOT rev-guarded (see the sweep note above)  |
| own-commit rebind adoption    | `checkout.svelte.ts`'s `adoptReboundMetamodel()` — refetches metamodel + issues + summary in place |

Refetch, not feed deltas: commit feed events deliberately carry **no** issue
delta, because reconnect needs the refetch path anyway.

Adopting committed truth **clears the overlay** (`adoptIssues`, `applyDelta`) —
the staged state it described has been superseded. So do `resetModelStore()` and
`boot()`, which install a different model entirely. `clearOverlay()` keeps
`_lastError`: a failed Validate's error strip must survive a peer commit.

The founding constraint behind all of this: **no open/commit path may run the
full validation pipeline.** `POST /model/validate` with no ops is an O(model)
sweep over what can be an ~80 MB model, so it stays reachable only from an
explicit user click. `GET /model/issues` is the cheap read used everywhere else.

### Artifact import/export (bundle export/preview/import)

The TopBar's toolbar `<nav>` (see Layout above) hosts an **Artifacts** menu
(`ArtifactsMenu.svelte`) with two dialogs mounted once beside it. The API
client for the four bundle routes is `lib/api/artifact-bundle.ts`.

- **Export** (`ExportArtifactsDialog.svelte`) — viewer-allowed. The user
  checks navigations/tables/snippets in a filterable, sectioned list; a
  300ms-debounced `POST /artifacts/export/preview` computes the
  referenced-artifact closure live, badging pulled-in dependencies
  (`dependency`) and surfacing a dangling-ref count. The name filter hides
  non-matching rows without unchecking them (`+N selected not shown`).
  Confirming streams `POST /artifacts/export` to a saved
  `datarover.artifact-bundle/v1` JSON file. Each artifact editor's own
  toolbar carries a per-artifact export trigger (`ArtifactExportButton.svelte`,
  dropped into `Table/TableView.svelte`, `Snippet/SnippetTab.svelte`,
  `Navigation/NavigationBuilder.svelte` and `Export/ExporterTab.svelte`;
  the metamodel tab has none — it isn't artifact-backed) that opens the same
  dialog pre-seeded with the tab's artifact (`openExportArtifacts([artifactId])`);
  it renders only once the tab's artifact is committed (hidden for a draft or
  a temp-id staged create — the export dialog intersects with COMMITTED
  headers), and the seed clears when the dialog closes.
- **Import** (`ImportArtifactsDialog.svelte`) — hidden from viewers in the
  Artifacts menu. Picking or dropping a bundle file runs
  `POST /artifacts/import/plan` for a stateless per-artifact plan
  (`create`/`reuse`/`copy`); a review screen lets each row's action be
  changed (restricted to the legal actions for that entry, mirroring the
  backend's matrix) and a `copy` row's name edited, then
  `POST /artifacts/import` lands the whole plan as ONE commit. Two 409 shapes
  are recovered inline: a typed `StalePlanImportError` (carries a
  freshly-derived plan) re-renders from the server's plan with a banner, and
  a bare `ConflictError` re-fetches the plan from scratch. A `rev: null`
  response (everything already existed) renders as a successful no-op, not
  an error.
- Imported artifacts land ONLY in the project's flat artifacts list — import
  never places anything into the view.
- The New Project wizard (`NewProjectWizard.svelte`) has a fourth
  `FileSlot` accepting a bundle file alongside metamodel/model/view; when the
  backend's `ProjectOut.skipped_artifacts` comes back non-empty, the wizard
  defers navigating to the new project and shows a warning panel listing each
  skipped bundle id and reason first.

### View editing state (staged `view.*` ops)

`lib/state/view.svelte.ts` holds `_view`: the LOCAL working copy — server
truth as of the last `refreshView()`, with every staged `view.*` op already
applied optimistically on top. **There is no direct PUT path.** Every
structural change the app drives (folder create/rename/move/delete, element
and artifact placement, drag-and-drop, the sidebar's Clear-view action) goes
out as a `ViewOp` and reaches the server only via `POST /commits`, the same
endpoint model and artifact edits commit through; `GET /view` is the only
other view route the backend exposes.
(The e2e test harness's fixture-loading helper, which talks to the
API directly to seed a project's starting content, seeds the view the same
way the client does: a `view.*` op batch through `POST /commits`, under a
`folder:root` lease.)

- **Three staged buffers, three different shapes — and that difference is
  load-bearing, not incidental.** The model buffer (`lib/state/ops.ts`'s
  staged-edits store) and the artifact buffer (`artifact-edits.svelte.ts`)
  are both **maps keyed by entity id**: a second edit to the same element or
  the same artifact COALESCES into the existing entry (property updates
  merge, an update-over-create merges into the create, and so on — see the
  artifact bullet above). The view buffer (`view-edits.svelte.ts`) is
  different in kind: an **ORDERED JOURNAL** (`StagedViewEntry[]`), append-only,
  with no per-id coalescing and no per-entry revert. The reason is structural:
  view ops are ORDER-DEPENDENT in a way model/artifact ops are not — a
  `create_folder` naming a `temp_id`, followed by a `place_element` into that
  same temp folder, followed by a `rename_folder` on it, only replays
  correctly if the three ops stay in that exact sequence. Plucking or
  reordering one from the middle (the kind of thing a coalescing map would
  invite) is unsound, so the only unwind the journal offers is the
  all-or-nothing `discardStagedView()` (see below), and each entry carries a
  `label` string captured AT STAGE TIME — after the optimistic apply, a
  deleted or renamed folder's prior name is unrecoverable from the blob
  itself, so the label is the only record of what the user actually did, for
  both undo-history display and the DiffDrawer's View tab.
- **Every `stage*` mutator in `view.svelte.ts` follows the same three-phase
  shape**: GUARD (client-side precondition checks — name clash, cycle,
  no-op — mirroring `applyViewOp`'s own checks, so a doomed gesture never
  reaches the lease step) → GATE (acquire the `folder:` lease(s) the op needs
  via `folderEditLock`/`folderCreateLock`/`folderDeleteLock` — notice-based,
  returns `false` on refusal having already shown the user why) → EMIT+APPLY+
  STAGE (build the `ViewOp`, apply it to `_view` via `applyViewOp` for the
  optimistic update, then `stageViewOp` to queue it). A mutator returns
  `Promise<boolean>`: `true` for staged-or-legitimate-no-op, `false` for a
  gate refusal that changed nothing.
- **Lease timing differs by gesture, deliberately.** A drag-and-drop
  placement (`stagePlaceElementsAt`, `stageMoveFolder`) acquires its
  `folder:` lease at DROP time — inside the mutator, after the pointer
  gesture already completed, since there is no earlier moment to fail fast
  from. A sidebar dialog (create/rename/delete folder in `TreeRow.svelte` /
  `ContainmentTree.svelte`) is the opposite: it acquires the lease BEFORE the
  `window.prompt`/confirm dialog even opens — a denial means the dialog
  never shows at all, rather than the user typing a name into a doomed
  rename. Cancelling the
  prompt (or leaving it a no-op) hands the lease straight back via
  `releaseFolderLeaseIfUnneeded`.
- **`folder:` resources ride the SAME lock registry as `art:` and element
  resources** (`checkout.svelte.ts`'s `_registry`, one token per acquired
  lease-batch) — a single gesture can cover both an artifact lease and a
  folder lease under one token (the artifact-delete scrub below is exactly
  that case). At commit, the token partition that decides which locks the
  server releases has NO folder-specific branch: `isArtifactResource` is
  false for every `folder:` resource, so a folder token can never qualify for
  the "keep — a still-open editor needs it" exemption artifact tokens get
  (there is no such thing as an open folder editor) and is unconditionally
  sent for release, same as an element token.
- **A commit that carried view ops triggers exactly one post-commit
  `GET /view` refetch.** Folder ids get no client-side `id_map` remap the way
  element/artifact ids do — the refetch is what concretizes a freshly
  created folder's `tmp_` id into its server-assigned one. Two independent
  subscriptions call `refreshView()`: the committing client's own listener
  (`onViewCommitted`, fired by `checkout.svelte.ts`'s `commitStaged` when
  `getStagedViewOps().length > 0`) and a peer's commit observed over the
  realtime feed (`onCommitEvent`, gated on `scope.includes('view')`). An
  own-commit can fire both (the feed echoes back), which is harmless — just
  two small `GET /view` calls instead of one.
- **`refreshView()` rebuilds `_view` as `server truth + staged journal`, on
  EVERY refetch path.** This is what makes the peer-commit refetch above safe:
  `folder:` leases are per folder, so two users editing DIFFERENT folders
  concurrently is explicitly supported, and a bare `setState(res.view, …)`
  would snap this client's sidebar back to server truth while its journal
  still held its own ops — the tree would then disagree with what the user is
  about to commit, and the next mutator's GUARD phase would run against the
  reverted tree and emit an op the server 422s. So the journal is replayed
  through `applyViewOp` on top of the fresh blob. If a replayed op THROWS (the
  peer's change genuinely conflicts — the folder we renamed is gone, …), the
  WHOLE journal is dropped, not the offending op: the journal is ordered, so a
  partial prefix is not a state the user ever asked for. The drop hands the
  journal's `folder:` leases back and announces itself through
  `view-discard-notice.svelte.ts`, a dedicated leaf store rendered as a
  dismissable banner on the project page — it persists until the user
  dismisses it, unlike the global
  lock notice (`setLockNotice`) it deliberately does NOT reuse: that channel
  is TRANSIENT (the next successful lease gate clears it via `noticed()` in
  edit-gate), too thin for a destructive event the user may not be looking at
  the screen for. Both no-journal paths stay free: own-commit and discard each
  empty the journal BEFORE the refetch fires, so the replay is a no-op there.
- **View discard is all-or-nothing**, unlike the model/artifact buffers'
  per-row revert: the DiffDrawer's View tab renders the journal read-only (no
  per-entry button) with ONE "Discard view changes" action
  (`discardViewChanges`), which wipes the whole journal, hands back every
  `folder:` lease it named, and refetches server truth — there is no local
  undo to fall back on, since the journal's entries are not independently
  revertible (see the ordering rationale above). **The refetch is enforced in
  the STORE, not at the call site**: `discardStagedView()` is async and fires a
  discard-listener registry (`onViewDiscarded`, which `view.svelte.ts`
  subscribes to with `refreshView`), because the optimistic applies are baked
  into `_view` and a discard surface that forgot to refetch would leave the
  sidebar showing a tree that exists nowhere. There are two such surfaces —
  `discardViewChanges` and checkout's global `discardAll()` — and the registry
  is what keeps a third one from missing the refetch.
- **Two page-level resets take the journal with them.** It is a module-scope
  singleton whose ops name `folder:` ids that only mean anything for one
  project at one rev, so `boot()` calls `clearViewState()` on every project
  (re)entry (an in-SPA project switch must not offer project A's staged view
  ops for commit into project B) and the conflict-recovery "Reload model"
  handler calls `resetViewEdits()` alongside `resetCheckout()` (which drops
  every `folder:` lease from the registry — a surviving journal would commit
  with no folder tokens and take a hard 409 "required lock not held").
- **`hasUnsavedWork()` counts the journal too** (`getStagedViewDepth()`).
  Unlike tables/navigations/snippets, a view edit has no editor and therefore
  no dirty DRAFT to be caught by — it goes straight from the gesture into the
  journal — so without that term a view-only batch would slip past the
  workspace unload guard that catches equivalent model and artifact batches.
- **Deleting an artifact scrubs its view placements in the SAME commit
  batch.** `artifacts.svelte.ts`'s `removeArtifact` stages a `remove_artifact`
  view op per folder that currently places the artifact, ahead of the
  `delete_artifact` op itself, so the commit that destroys the artifact
  leaves no dangling ref behind — there is no window where the view still
  names an artifact the server has already dropped. This needs a SECOND lock
  step after the artifact's own DELETE-intent lease: the folder edits it a
  peer might also be touching, so `folderEditLock` runs over every placement
  folder, and a refusal there rolls the already-acquired artifact lease back.
- **The TopBar's combined-changes counter and the DiffDrawer both fold the
  view journal in.** `getStagedChangeCount() + getStagedArtifactDepth() +
getStagedViewDepth()` is what gates the header's Commit button and badges
  the "● N changes" count; the DiffDrawer's `total` adds the same
  `getStagedViewDepth()` so a view-only batch still reaches a live Commit —
  its own "View (N)" tab is where the journal's entries actually render, in
  order, using each entry's pre-baked `label`.

### Navigation editor state (per-node previews)

`lib/state/navigation-editor.svelte.ts` holds the per-tab navigation drafts
(one draft + one lock-denied marker per `tabId`) and drives the live chain
preview. **Saving stages, it does not POST**: opening a saved navigation takes
an `art:<id>` exclusive lease (a denial opens the tab UNSAVEABLE behind the
`getNavLockHolder` banner rather than refusing it — Save/Save-as off, editing
surface still live), `saveDraft`/`saveAsDraft`
push a `create_artifact`/`update_artifact` op onto the staged-artifact buffer,
and a create staged from a `nav:draft:N` tab is re-keyed to `nav:<id>` only when
the commit's `id_map` arrives (module-scope `onArtifactCommit` listener) — its
tab record follows the temp id immediately (`repointTabArtifact`), but its key
names no artifact so nothing can collide with it. A `saveAsDraft` fork is the
exception: that tab IS keyed to a real artifact it has stopped editing, so it
re-keys to `nav:<tempId>` at stage time, keeping the invariant that a bound
tab's key is always `nav:<its own artifactId>` (which is what makes
`openArtifactTab`'s deterministic id collision-free) and letting the original
reopen immediately. `closeDraft` releases the lease unless a staged op still
needs it. A navigation is a **tree** — a Path, or a set expression over nested
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
  whose address fails to resolve is dropped from the expanded set. Each node
  carries its own **generation counter**: any edit / newer run / collapse /
  `closeDraft` / reset bumps it, and the async preview functions capture it
  before their await and drop a stale response (or one whose draft is gone), so
  a slow round-trip can never revive a cleared node preview or clobber a fresher
  one. A **still-current** failure sets that node's `_evalError` flag, which
  `ChainPreview` surfaces. `nodeAt` returns null for a **ref** operand — refs
  get no per-node preview and are skipped.
- **Accessors are node-scoped** (`getPreview`/`getEvalError`/`isExpanded`/
  `runPreview`/`loadMorePreview` all take `(tabId, path)`, `path` defaulting to
  the root `[]`); `getDraft`/`getNavLockHolder`/`updateDefinition`/`saveDraft`
  stay per-tab. `closeDraft` and `resetNavigationEditors` clear **every** node
  key for the tab (expanded set plus any lingering keys), cancel all timers, and
  bump generations so nothing leaks.

### Script columns & steps

Table script columns (`ScriptColumnEditor.svelte`, kind `'script'`) and
navigation script steps (`Navigation/ScriptStepRow.svelte`) both embed a
snippet's `value(elements)`/`step(el)` call against a live row/frontier
element, and both share one component: `components/Snippet/
SnippetSourceEditor.svelte`, bound to a `SnippetSource` (`{ ref?, definition?
}`) plus the entry point it must satisfy (`"value"` or `"step"`).

- **Ref/inline contract.** Mode is derived, not stored: `definition != null`
  means inline, ref mode otherwise — including the freshly-added, unconfigured
  `{}`. **Ref mode** narrows the saved-snippet dropdown (`snippet-ref-select`)
  to `code_snippet` artifacts whose (server-derived) `entry_points` actually
  cover the bound entry (`entryAvailable`, `lib/snippet/entry-stubs.ts`); a
  selected ref that later falls out of that filter (the artifact's snippet
  stopped defining the entry, or was deleted) surfaces as `snippet-ref-missing`
  rather than being silently cleared — the user might be mid-edit of that
  snippet elsewhere. **Inline mode** is a plain `CodeEditor` over
  `snippet.definition.code`, seeded from the previously-selected ref's code (or
  a fresh entry stub) on first switch. It runs its own **component-local
  debounced lint** (300 ms, `POST /snippets/lint`) to drive the editor's
  diagnostics and the `snippet-entry-warning` hint — this is deliberately
  **not** the tab-level `_lint` map in `state/snippet-editor.svelte.ts`, since
  this editor only ever holds a bare code string with no per-tab draft/save
  lifecycle of its own.
- **Shared editor chrome.** Everything below lives in `CodeEditor.svelte` /
  `lib/editor/`, so the standalone snippet tab, table script columns and
  navigation script steps all inherit it from one implementation.
  - **Vertical resize.** Inline editors render at the height in
    `state/editor-size.svelte.ts` with a `ResizeHandle axis="y" side="top"`
    grip on their bottom edge (`snippet-editor-box`); the standalone tab has a
    divider (`snippet-split-divider`) between editor and console that
    reapportions the persisted ratio. Both sizes are **global per kind** and
    survive a reload; see `editor/editor-size.ts` for the clamping and why the
    editor (not the console) yields when the body is too short for two
    minimums.
  - **Ctrl+F.** `editor/search-panel.ts` replaces CodeMirror's stock panel via
    `search({ top, createPanel })`: styled field, live match counter,
    icon prev/next/close, `Aa`/`.*`/`ab|` chips, and a replace row behind a
    chevron. Presentation only — the commands and keybindings are still
    `@codemirror/search`'s.
  - **Reformat.** The corner control (`snippet-format`, `Shift+Alt+F`) expands
    tabs locally with `expandTabs` and then posts to `POST /snippets/format`
    (`ruff format`, `indent-width=4`). The document is replaced in ONE
    transaction so a reformat is a single undo step, with the cursor kept on
    the same line number. The local tab expansion is applied **even when the
    server refuses** (422 unparseable, 503 no ruff), so the control still
    fixes indentation with no backend behind it. A 503 latches the control
    disabled rather than letting the user pump a dead endpoint.
- **Test panel.** Both modes render `SnippetTestPanel.svelte` (`snippet-test-
toggle`), a collapsed disclosure that expands to the shared
  `ElementContextRow` (chips + fuzzy search + "Use current selection"), a Run
  button, and `SnippetResultView` — the same result surface the tab console
  renders, minus ops staging. Inline mode posts `{ code }` to
  `POST /snippets/run`, ref mode posts `{ artifact_id }`; both post `entry` +
  `element_ids`. Run is gated on all four of: a configured source, the entry
  point being available (`entryAvailable`, from the editor's local lint inline
  / implied by the pre-filtered dropdown in ref mode), and the element count
  the server's `SnippetRunIn` validators require (`value` ≥ 1, `step` == 1) —
  so the UI never sends a request that would 422. The gate lives in
  `requestRun()` itself, not just on the button, because the editor's
  `Mod-Enter` keymap calls it directly. Run state is **component-local**
  (`$state` + a `runSeq` generation guard bumped in `onDestroy`), NOT the
  tab-keyed `_runs` map: several script columns/steps can be open at once and
  a nav script step is identified only by an array index that shifts on
  reorder. Recorded ops are listed but **never stageable** — embedded
  `value()`/`step()` evaluation is read-only, so the panel says so
  (`snippet-test-ops-readonly`) instead of offering a Stage button. There is
  no Stop button: cancel is a server-side no-op and the wall timeout is 10s.
- **Error cells.** A script column's `value()` call failing server-side
  (`core/script/embed.py`'s `ScriptEvalContext` — degraded, not failed: a
  missing runner, a full concurrency slot, or a snippet exception) renders
  that one cell as `Table/Cell/ErrorCell.svelte` (`error-cell`) instead of a
  `ValueCell`, showing `cell.message` with `cell.traceback ?? cell.message` as
  the hover title. The row otherwise renders normally — one bad cell never
  blanks the row, and sorting/paging keep working around it.
- **Pending cells + the sweep poll.** Whole-table script passes do not run
  inline: `/tables/evaluate` reads a per-session value cache a **background
  sweep** fills, so uncomputed cells come back as `{kind:'pending'}` (rendered
  by `Table/Cell/PendingCell.svelte`, the same pulsing bar as an un-fetched
  row) and the response carries a `script_status`
  (`ready`/`computing`/`failed` + `done`/`total`/`message`). While `computing`,
  `state/table-editor.svelte.ts` keeps **exactly one** pending timer per tab
  (`_pollTimers`, cancelled on every landing page, on close/reload/reset, and
  guarded by the tab's generation counter) and re-requests the **visible
  window** (`visibleRequest`, shared with the commit refresh) every second
  until the status turns terminal. Rows arrive in build order while computing —
  a response that saw pending values never reports `ready`, so the last poll
  always lands a clean, correctly-sorted page. `TableView` shows
  `Computing script columns {done}/{total}` (or the failure message) via
  `getTableScriptStatus(tabId)`, as **fixed chrome** beside the lock-denied
  and warnings strips — deliberately _not_ inside `TableGrid`, whose scroll
  container would both scroll the readout out of view on a long table and, as
  an in-flow element ahead of the `padTop` spacer, offset every row relative to
  what the virtualizer's window math assumes. `failed` is terminal — stop
  polling; the work
  is dead and only the next commit revives it (a commit re-keys the server's
  sweep registry, and `script_status` starts over from the new rev).
  **Export** mirrors this: `/tables/export` answers **202 + Retry-After: 1**
  while values are still computing, and `downloadTable` retries (bounded,
  `onProgress` on the Export button, abortable on unmount) until the xlsx
  arrives. Retry off the **HTTP status code, never the body's `state`**: a 202
  body routinely says `computing` for a sweep that already finished (the server
  decides ship-vs-retry by re-probing its cache, not by the job's state), and a
  200 always carries a real workbook — possibly with `#ERROR` cells and
  `X-Table-Script-Errors` set, which is the server saying "retrying will not
  help", not an invitation to poll again.
- **Script-error recap (badge → panel → jump), fetched ON DEMAND.** A failing
  script cell can be anywhere in a table the grid only ever holds a WINDOW of,
  so scrolling is not a way to find one. Whenever asking would actually do
  something — `canRequestScriptErrors(tabId)`, i.e. the store holds a settled
  page-state signature for the tab — `TableView` shows a **neutral** "Check for
  script errors" affordance (`script-errors-badge`) beside the status readout.
  That gate is the STORE's, deliberately not a re-derivation from
  `script_status`: a sort/reload drops the signature the instant its request
  goes out while the previous page's status survives until the new page lands
  (or forever, if the load fails), and a badge lit in that window invited a
  click that did nothing at all. Clicking it calls `requestScriptErrors(tabId)`
  — the only thing that ever fetches the backend's whole-table recap
  (`POST /tables/script-errors` → `getScriptErrors(tabId)`) — and opens
  `Table/ScriptErrorsPanel.svelte`, which reports whichever of the
  four `getScriptErrorsPhase(tabId)` outcomes applies: `loading` ("checking…"),
  `done` with failures (the list: row label, column, message — and the badge
  switches to the destructive `N script errors` count), `done` with none ("no
  script errors in this table" — a user who asked deserves an answer), or
  `error` ("could not check", retryable by clicking again). Clicking an entry
  calls `requestScrollToCell(tabId, row, col)`; `TableGrid` picks it up with
  `consumeScrollRequest` in an effect, scrolls to the row and outlines the cell
  for 2s — best effort, since row heights are estimated for rows the sparse
  cache hasn't fetched.
  **An empty recap is not always a clean bill of health.** With no script runner
  the route answers **zero** errors — the honest count, since nothing ran and so
  nothing is KNOWN to have failed (reporting one "not computed" error per cell
  instead badged a 50 000-row table "50000 script errors" for a sandbox that was
  simply switched off). `ScriptErrorsOut` has no room to say which zero it is
  (its `state` is a one-valued literal and the wire shape is frozen), so the
  client earns the distinction from the page it is already showing:
  `getUncomputedScriptCellReason(tabId)` returns the message of the first
  SCRIPT-column cell in the loaded rows that came back `error` or `pending`, and
  an empty recap over such a page is rendered as a warning-toned "Script errors
  unknown" badge and a panel saying the cells were never computed, with the
  reason. The CELLS are the reliable signal here: for the commonest shape (an
  unsorted `collapse` column) a runner-less page reports `script_status: ready`
  — no strip, no message — while the window pass, which is live, renders every
  cell an error saying exactly why; only the sorted/`expand` shape reports
  `failed`. And `failed` alone would over-suppress, because the client's own
  poll give-up writes a `failed` status while the backend is healthy. Narrow on
  purpose: script columns only (a broken navigation column is not something a
  script-error recap covered), only when the recap came back EMPTY (a real count
  is a stronger statement and is never downgraded), and `&&`-short-circuited so
  no other table pays for the scan.
  **WHY on demand** (this is not a UX preference): the recap route renders the whole
  table CACHE-ONLY, and for the commonest shape — an unsorted `collapse` script
  column with `keep_empty` — the page route makes **zero** `value()` calls (the
  build pass skips it, the order pass short-circuits with no sort) and computes
  only the visible window live, so the page reports `ready` **without ever
  kicking a sweep**. The recap then misses on every row outside that window and
  kicks a full background sweep. Fetching it automatically would turn
  "open a table with a script column" into "sweep the whole table", plus up to
  120 once-a-second retries each re-paying a full build + order + render.
  `/tables/export` has the identical loop, but only behind an explicit click —
  so the recap is behind one too, and the up-front error count is deliberately
  given up.
  **Fetch-ONCE per page state**: the recap is keyed by
  `"<status>:<model_rev>:<generation>"`, the signature of the page state on
  screen — background chunk fills as the user scrolls change none of the
  three, so they neither re-fetch nor drop the recap already paid for, while a
  peer's commit (new rev) **and** a sort change, a definition edit or a reload
  (all of which bump the tab's page-load **generation**) DROP it on the spot,
  without fetching anything; the next click re-fetches. All three parts are
  load-bearing: `row_index`/`column_index` address the order the grid is
  _currently_ showing, and a sort or definition edit reorders every row at a
  CONSTANT `model_rev` — keyed without the generation the tab would keep
  showing the recap built for the previous order, and jump-to-cell would scroll
  to whatever row now sits at that index. The recap is also dropped whenever the table
  stops being settled (which also hides the badge). A **202** (sweep still
  filling the cache — the STATUS CODE is the retry signal, as for export)
  schedules exactly ONE delayed retry per tab, bounded like the sweep poll;
  exhausting that budget, like any failed fetch, reports the `error` phase and
  never anything worse, because this surface must never be what breaks a table
  view.
- **Staged definition edits (the settings dialog).** `updateTableDefinition`
  normally re-evaluates the whole table — a fresh backend cache key, and for a
  script column a fresh sweep. Inside the settings dialog the user is
  _composing_ (typing a snippet, trying a chain, undoing it), and every
  intermediate state would pay for that, on a grid the modal is covering
  anyway. So `TableView.openSettings` calls `suspendTableEvaluation(tabId)`
  **before the first edit** (the header "+" menu appends the new column _then_
  opens the dialog — that append is itself an edit), which snapshots the
  definition; while suspended, `updateTableDefinition` still updates the draft
  immediately (editors, dirty flag and Save are unaffected — only the
  _evaluation_ is deferred) but issues no request, and `ensureTableRange`
  declines chunk fills (the draft's definition has drifted from the loaded
  page's, so a chunk would splice rows of a different shape into it).
  `resumeTableEvaluation`, called from the dialog's `onOpenChange` close, does
  **one** reload — and only if the definition actually differs from the
  snapshot, or a peer's commit landed meanwhile
  (`handleTableModelRevChanged` records that on `_suspendedStale` rather than
  re-evaluating a half-composed definition). Unchanged ⇒ no request, just a
  re-drive of the visible range to fill chunks skipped while suspended.
  `abandonTableEvaluationSuspension` (TableView unmount, close/reload/reset)
  drops a suspension _without_ evaluating, so a suspension can never outlive
  its dialog and silently freeze a tab. This is also why `ColumnManager`'s
  header input does not debounce: per-keystroke applies cost a draft object
  and nothing else, while a debounce timer would silently discard a rename
  typed and then Escaped inside its window (`change` never fires for an input
  unmounted while still focused).
- **`warnings` threading.** Both evaluation paths share one
  `ScriptEvalContext` per request and report through its `.warnings` list, but
  the warnings themselves are **structured**, not message strings: each one is
  `{code, occurrences, total, detail}`, aggregated backend-side by `(code, detail)`
  (see `core/script/warnings.py` — a kind firing 17 times is one
  entry with `occurrences: 17`, not 17 near-identical strings). All copy is
  rendered client-side by `formatScriptWarning` in `$lib/script/warnings.ts`,
  the single place that turns a code into a sentence — components never write
  warning prose inline, so the table and the nav dock stay in sync by
  construction. `TableData.warnings` (`state/table-editor.svelte.ts`) is read
  via `getTableWarnings(tabId)` and rendered in `Table/TableView.svelte` as a
  `table-warnings-badge` summary (count of distinct kinds) that toggles open
  `ScriptWarningsPanel` for the full formatted list; `NavPreview.warnings`
  carries the equivalent list for a navigation node's chain preview, rendered
  by `Navigation/ResultsDock.svelte` as a `nav-warnings` chip
  (`⚠ N script warning(s)`, each entry formatted by `formatScriptWarning` and
  joined by `\n` into the `title` tooltip) beside the chain-count status.
  `loadMorePreview`
  deliberately keeps the **first page's** warnings on subsequent pages rather
  than replacing/merging them — see the comment on `NavPreview.warnings` in
  `state/navigation-editor.svelte.ts` — so paging in more rows never churns
  the badge.

### Table export settings

The Export button is a dropdown of the four `EXPORT_FORMATS` (Excel `.xlsx` /
JSON `.json` / CSV `.csv` / JSON Lines `.jsonl`). No item
downloads directly: all four open `components/Table/ExportDialog.svelte` with that
format preselected, and a segmented control switches format in place. Confirming
runs the `downloadTable` retry loop — the backend's 202 +
`Retry-After` protocol is format-agnostic — and the dialog **closes first and
does not await it**, because that loop can run for minutes while a script sweep
fills the cell cache and the progress belongs on the chrome's Export button, not
behind a modal overlay.

Everything the dialog edits is an **export override**: it changes the file and
never the grid. Include/exclude, output order and the row-number entry are
shared across formats; only the rename differs (xlsx writes `export.header`,
JSON writes `json_export.key`, so one row never shows two rename boxes). JSON
keeps its per-column extras (`json_export: {key, item_key, value, group}`) and
its live sample pane. The overrides are part of the saved definition, so a table
exported the same way every week is configured once. When the selected format is
JSON-family, the format-toggle row also shows a `TransformPicker` bound to the
table's OWN `TableDefinition.transform` — a SEPARATE field
from any exporter entry's `transform`: an exporter entry built from this table
never inherits it (`entryForTable` sets `transform: null`, not a copy), and this
picker never reflects an entry's choice either — the no-bleed rule holds in both
directions, same as every other `overridden_table` field. `ExportSettingsPanel`
gates every JSON-only control on a derived `jsonFamily` (`format === 'json' ||
format === 'jsonl'`) rather than `format === 'json'` alone, since JSONL renders
through the same per-column extras and live sample pane as JSON while CSV
follows xlsx's plain-header path — the panel itself has no format-specific
controls beyond that split.

**The settings markup is split from its hosts.** `ExportDialog`
itself owns only open/snapshot/cancel semantics, the format toggle and
confirm — every editing surface (the entry list, JSON options, the split
section, the preview pane) lives in `Export/ExportSettingsPanel.svelte`, a
host-agnostic panel the dialog drives over the table draft via `onChange`.
`Export/EntryLayoutDialog.svelte` is the **second host**: it edits ONE
exporter entry's overrides over the exact same panel markup, but writes
to a local working copy instead of the table draft. Its `effective` value is
the entry's overrides re-applied onto the table's CURRENT definition
(`applyEntryOverrides`) — what the entry would render today, not a frozen
snapshot from when it was added — and saving diffs the edited result back
against the table's definition (`overridesFromDefinition`) to produce the
entry's patch: the entry stores DRIFT from the table, never the table's
settings themselves. It passes no `sort` to the panel — an exporter entry
has no live grid to inherit a sort from, and its download is sort-less too.
Its own addition beyond the panel is a `json_doc` control group — `shape` +
`key_column` + `pretty` shown only for `json` (mirroring the backend's
tolerant-ignore of shape/pretty on `jsonl`), `on_error` shown for the whole
json family — read/written directly against the entry's `json_doc` rather
than through the panel; the live sample below them still renders the array
shape regardless of `shape`, since `POST /tables/json-preview` predates
document shaping. Per the strict-at-export / never-block-Save rule, Save is
never gated on a missing `key_column` under the object shape, nor on an
invalid `json_split` filename template — that check only drives an inline
`entry-split-template-warning` hint beside Save; the inline hint plus the
export-time 422 is the entire contract.

- **`lib/table/export-layout.ts`** mirrors `core/table/export_layout.py`'s
  normalizer — `ROW_NUMBER_SLOT` (`-1`), `columnIncluded` (tri-state `include`:
  `null` follows `hidden`) and `exportEntries`. DISPLAY ONLY, like
  `defaultJsonKeys`: the authoritative layout is the backend's. It exists
  because the dialog must list the EXCLUDED entries too — so the user can opt
  one back in — and the backend's `ExportLayout` has already dropped them.
- **`updateTableExportSettings` / `restoreTableExportSettings`**
  (`state/table-editor.svelte.ts`) are the dialog's only writes. They set the
  draft and deliberately **skip the reload** `updateTableDefinition` fires:
  `/tables/evaluate` reads none of these fields, so a reload could only repaint
  the identical page — while bumping the generation, dropping the script-error
  recap and pulsing the activity bar, once per keystroke. `restore…` is Cancel's
  half and puts `dirty` back with the definition; discarding an edit has to
  discard the unsaved-ness the edit created.
- **`export_order` bookkeeping** lives with the column mutators in
  `lib/table/columns.ts` (the backend normalizes defensively on read, but the
  client remaps precisely on move/insert/remove/clone, like
  `remapTableSortFor*`).
- **`defaultJsonKeys`** mirrors the backend's key derivation, but ONLY to fill
  input placeholders — the sample pane fetches `POST /tables/json-preview`, with
  the active grid sort, so the grouping algorithm is never reimplemented in
  TypeScript and the pane cannot disagree with the download.

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
- **Rebind is exempt** — a `POST /commits` batch carrying a `metamodel.rebind`
  op never passes through the strict gate (the backend runs a full-model sweep
  for a rebind batch and is deliberately exempt from the conformance
  hard-reject there); swapping the metamodel always succeeds regardless of the
  setting. Structural blockers still hard-reject as usual.

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
  rebind-carrying commit.
- **Revert-to-commit** (`POST /commits/revert`) — gated on a quiet project:
  `state/quiet.ts`'s `isProjectQuiet()`, a five-term predicate (no staged
  MODEL ops, no staged ARTIFACT ops, no staged VIEW ops, no staged METAMODEL
  ops — the YAML draft and the diagram's staged node moves — and no
  model-scope lease anywhere; the `mm` lease is deliberately not one, since a
  peer's metamodel editor tab is orthogonal to a model rewrite). The predicate
  lives in its own module so the one lease-term expression it spells out
  cannot drift across consumers. Metamodel commits are gated separately, by
  the server's quiet-peers guard + hard-verified `mm` lease at commit (see
  "Live metamodel editing" below). `POST /commits/revert` also answers a flat
  409 for any range containing a `metamodel.*` op, regardless of quiescence —
  see that section's undo/revert paragraph. Selecting "Revert to here" on a
  row shows an inline confirm panel with an optional message; submitting
  applies the compensating inverse ops as a new durable commit (history stays
  append-only, `model_rev` advances),
  broadcasts the delta via the feed, and reloads the history list.

### Live metamodel editing (metamodel tab)

Editing the metamodel is a **workspace tab**, not a dialog: the TopBar's "Edit
Metamodel" item calls `openMetamodelTab()`, which focuses the existing tab or
opens the singleton `{ kind: 'metamodel', id: METAMODEL_TAB_ID, artifactId: null }`
one — `METAMODEL_TAB_ID` is `'mm:editor'`, distinct from both the `'mm'` tab-id
prefix in the same file's `PREFIX` map and the `mm` lease resource id below.
It is the only persisted tab kind with no artifact behind it: `persistable()`
requires a real `artifactId` for every other kind, while this one is a stable
singleton whose draft persists independently in
`ui.metamodel.draft.<projectId>`.

`state/metamodel-editor.svelte.ts` owns everything the tab renders, exposed as
one `MetamodelEditorView` snapshot from `getMetamodelEditor()`. There is no
Rebind button — the buffer is staged commit CONTENT and lands through the same
**Commit** button as model/artifact/view edits:

- **Load** — `GET /metamodel/raw` on mount. `source: 'stored'` is the author's
  own YAML (comments and formatting intact); `'serialized'` is the degraded
  fallback for a session whose metamodel never landed in a durable row, and
  the tab flags it with a "re-serialized source" chip so nobody is surprised
  when their comments are gone. A failed load is its own `error` phase with a
  Retry button — never an empty buffer, which would look like an empty
  metamodel one keystroke away from being staged.
- **Baseline vs buffer** — `dirty` is `buffer !== baseline`, and the baseline
  only ever moves on a load or a commit that carried this buffer's
  `metamodel.rebind` op. The dirty buffer mirrors to `localStorage` under
  `ui.metamodel.draft.<projectId>` (debounced 500 ms, flushed on close), so a
  refresh or an accidental tab close cannot lose work; it is cleared only by
  an explicit Discard or by a commit **that adopted it**.
- **Lint** — a debounced `POST /metamodel/lint` (500 ms) per edit. It is
  advisory in both directions: positioned errors become CodeMirror gutter
  diagnostics, message-only errors become the strip under the editor, and a
  failed lint call clears the gutter rather than blocking anything.
- **Preview** — on demand, never on a timer: `POST /metamodel/diff` sandboxes
  the candidate and returns which model issues would start/stop failing plus a
  structural diff (`MetamodelPreviewPanel`). The result is recorded **against
  the exact buffer it was computed for** (`previewCurrent`), so a preview goes
  stale the moment the next character is typed and the panel says so. Preview
  is advisory — nothing gates commit on having run one.
- **Staging** — a dirty draft registers with `metamodel-stage.svelte.ts` as the
  fourth staged family's draft half (`registerMetamodelDraftProvider`), and
  `getStagedMetamodelDepth()` counts it as one row in the commit drawer's
  total, `hasUnsavedWork()`'s guard, and `isProjectQuiet()`'s five-term
  predicate. `getStagedMetamodelOps()` turns it into one `metamodel.rebind`
  op, hoisted first in the batch by the server regardless of client order.
- **Commit** — `commitStaged` (`checkout.svelte.ts`) captures the buffer's text
  at batch-build time and sends it as the `metamodel.rebind` op; on success the
  `onMetamodelCommitted` listener adopts **that captured text** as the new
  baseline — a buffer that moved mid-flight (a straggler keystroke) stays
  dirty, keeps its draft, and drops its now-spent preview, so the user lands on
  "unreviewed local changes on top of the newly committed metamodel" rather
  than a screen that claims to be saved. A rebind-carrying commit requires the
  **owner** role (403 otherwise, checked both client-side before staging and
  server-side at commit) and hard-verifies the `mm` lease server-side.
- **Lease** — composed, never re-implemented: `state/metamodel-lease.svelte.ts`
  (the surface-agnostic `mm` lease module) acquires
  the EXCLUSIVE `mm` lease on the **first divergent keystroke _or_ first node
  drag** and drops it on
  close, discard, or **the commit that surrendered it** — unconditionally,
  because an acquire still in flight is exactly the leak this guards. Both
  surfaces acquire because the backend hard-verifies the lease for the WHOLE
  `metamodel.*` family: a staged `metamodel.move_node` with no lease behind it
  409s the entire mixed batch, and the editor's own acquire cannot stand in for
  it (that one is owner-gated, while an EDITOR may stage layout moves).
  `metamodel-diagram.svelte.ts` funnels all four of its staging gestures
  (drag, auto-arrange, rename/delete key migration, undo) through one private
  `stageMove` choke point that fires the acquire — fire-and-forget, deduped by
  an in-flight flag, so a drag burst costs one `/locks` call and never blocks on
  it — and reads "already held" from the checkout registry rather than a local
  flag, so a lease surrendered by a commit/discard/close re-arms it.
  `acquireMetamodelLease` itself COALESCES concurrent flights, because one
  gesture reaches both surfaces (a diagram rename migrates a layout key AND
  writes the buffer): two in-flight acquires would bump the module generation
  past each other and mint two server-side leases on the singleton resource,
  one of which never reaches the registry and so could never be released. A peer
  conflict turns the editor read-only with the holder's email and a Retry,
  keeping every character already typed; a restored draft therefore opens
  editable and only discovers a peer's lease on the first keystroke. On the
  layout half the same conflict keeps the drag LOCAL and **un-stages** the moves
  the optimistic window recorded (an op that can never hold its lease would
  poison every later batch); the holder is reported through the editor module,
  so there is one `lockedBy`, one strip, and one Retry for both surfaces. `mm` is
  excluded from `isProjectQuiet()`'s lock term (mirroring the backend's
  `is_model_resource`), or the editor's own lease would disable Revert-to-commit
  the moment someone opened the tab. `checkout.svelte.ts`'s
  `releaseMetamodelLease` refuses to release while
  `getStagedMetamodelDepth() > 0` — closing the tab over a dirty draft must not
  hand the lease back while a staged rebind still needs it; closing over a
  CLEAN draft does release it (see the known limitation below).

The module's `_gen` guard covers only its OWN async (load / lint / preview)
against a closed tab; the lease module keeps its own generation for lease
calls, and neither wraps the other — one generation guard per concern.

**Known limitation: a CLOSED tab contributes 0 to the staged depth for the
DRAFT half.** `registerMetamodelDraftProvider`'s callback reads
`isMetamodelEditorDirty()`, which is `_phase === 'ready' && buffer !== baseline`
— and `closeMetamodelEditor` resets `_phase` to `'idle'`. So a dirty draft in a
closed metamodel tab vanishes from the DiffDrawer's Metamodel section and does
**not** ride the next `POST /commits` batch, even though the same user's staged
model/artifact/view edits do. The draft itself is never lost — it survives in
`localStorage` and reopening the tab restores it dirty — but this is a real
inconsistency with how the other three staged families behave (their staged
ops live independent of any open tab). Staged diagram node MOVES do **not**
share this gap: they live in `metamodel-stage.svelte.ts` itself, not behind the
editor's phase gate, so they keep counting — and keep riding the next commit —
after the tab closes.

#### The diagram surface

The same tab has a second surface: an editable UML class diagram over the same
draft, picked by a YAML/Diagram toggle in the tab's toolbar (persisted per
project — the choice is personal, like collapse state). The whole lifecycle
above is untouched by it. `state/metamodel-diagram.svelte.ts` **owns no draft
state**: every canvas gesture becomes `parseDraft → applyEdit → serializeDraft`
over the CURRENT `getMetamodelEditor().buffer`, and the resulting text goes back
in through `editMetamodelBuffer` — the same seam a keystroke uses, so lease
acquisition, debounced lint, the localStorage draft, `dirty` and preview all
keep working with no diagram-specific branch anywhere in the editor module. It
is composed through that module's public exports only.

- **`metamodel/yaml-edit.ts`** — the comment-preserving edit core, built on the
  `yaml` package's Document API rather than round-tripping a plain object
  (which would drop every comment the `GET /metamodel/raw` `stored` source
  exists to preserve). A 22-member `YamlEditCommand` union covers every gesture;
  `applyEdit` mutates surgically or throws without touching the doc, so a
  rejected command leaves the draft as it was. Its `STRINGIFY_OPTS` pair —
  `lineWidth: 0` and `flowCollectionPadding: false` — is **load-bearing**:
  without the padding flag the emitter rewrites `{name: x}` as `{ name: x }` on
  serialize, and a no-op round-trip of `examples/smart-city.metamodel.yaml`
  rewrites 126 of its 455 lines. A test round-trips that real file
  byte-for-byte; keep it.
  Booleans are dropped at their schema default and `mappings[0]` is mirrored back
  into the `source`/`target` shorthand (`syncShorthand`), so an edited file still
  reads the way it was authored.
- **`metamodel/diagram-build.ts`** — pure metamodel → `DiagramNodeSpec[]` /
  `DiagramEdgeSpec[]`. Endpoints come from `rel.mappings` **only**, never the
  `source`/`target` shorthand, which is a serialization mirror that can go stale.
  A relationship that carries properties, is abstract, extends, or is extended
  gets its own `rel:` box with two half-edges through it (UML's association
  class); a plain one is a single boxless edge. `nodeSize` is the ONE place a
  box's footprint is decided — the canvas styles from it and elk lays out
  against it, so drawn width can never disagree with reserved space.
- **`metamodel/arrange.ts`** — `autoArrange` (elkjs `layered`, bundled build so
  there is no worker file to serve) for the Auto-arrange button and first open,
  and `placeUnpositioned`, an incremental heuristic that places a node next to
  its nearest positioned neighbour and **never moves an already-positioned
  one** — a peer's new type must not re-layout the canvas under you.
- **Layout is presentation, but staged commit CONTENT.** A drag does not PUT
  a shared blob live; it stages a `metamodel.move_node` op through `metamodel-stage.svelte.ts`
  (`stageNodeMove`, coalescing per node: the last position staged for a node
  is the only one that matters) and lands on the next `POST /commits` with
  everything else in the batch. `GET /metamodel/layout` is the read of the
  materialized baseline (table `metamodel_layouts`), and the
  canvas overlays this session's still-uncommitted staged moves on top of it
  (`withStagedMoves`) so a pending drag never snaps back on a baseline
  refetch. The canvas has **two independent gates**: draft edits follow
  the editor module's owner-only `readOnly`, while dragging (and staging a
  move) is gated on `getRole() !== 'viewer'` — an editor may rearrange the
  picture without being able to edit the metamodel; a viewer's drags stay
  purely local, with nothing staged. Staged moves persist to `localStorage`
  under `ui.metamodel.layoutdraft.<projectId>` (`metamodel-stage.svelte.ts`),
  beside the YAML draft's own key next door — a refresh loses neither half of
  an uncommitted metamodel edit.
- **There is no rename key deferral**, and the staged-commit shape above is
  what makes it unnecessary: node ids (`el:`/`rel:`/`enum:` + type name)
  double as the layout blob's position keys, and a staged position rides the
  **same** commit batch as the staged `metamodel.rebind` that renamed its
  node, so the keys ever published are
  atomically the ones the draft's own (new) names produce — there is no wire
  moment where the blob and the draft's names can disagree. `_positions` is
  plain draft-key space end to end; `applyKeyMove` moves the position locally
  on a rename/delete and stages the corresponding `metamodel.move_node` pair
  (old key `→ null`, new key `→` the position) in the same gesture.
- **Undo** is a bounded (50) stack of buffer snapshots paired with a position
  snapshot, because a rename moves both and undoing one without the other
  would leave the staged batch describing a rename the buffer does not
  contain — `undoDiagramEdit` restores the position half by re-staging the
  minimal before/after delta (`stagePositionDelta`), so the pending commit
  moves back in step with the canvas. Ctrl/Cmd-Z on the canvas pops it; the
  restored text goes through `editMetamodelBuffer` like any other edit. A
  commit carrying a `metamodel.rebind` op drops the whole stack (its
  snapshots describe pre-commit text, which is meaningless to "undo" against
  the newly committed buffer); a layout-only commit leaves it intact.
- **Error surface.** `MetamodelDiagramView.errorNodeIds` is **empty in every
  reachable state** — the server attaches a `line` only to a YAML _syntax_
  error, which also fails the local parse, which means nothing is drawn to badge
  — so the toolbar renders `unattributedErrorCount` as a clickable "N issues"
  badge that jumps to the YAML view, and a non-parsing buffer replaces the whole
  canvas with a placeholder plus a jump button (never a stale last-good diagram).
  The set is still summed into the count so that if attribution ever starts
  producing hits, a badged node cannot also vanish from the total.
- **Forms and connections.** `components/Metamodel/forms/MetamodelFormPanel.svelte`
  docks right of the canvas and owns everything a box cannot show (properties,
  keys, multiplicities, mappings, enum literals), falling back to an overview
  that surfaces the two things the canvas cannot draw: enums, and relationship
  types with no mappings — which have no endpoints to anchor an edge and would
  otherwise be unreachable. A dragged connection is refused by `onbeforeconnect`
  (every edge here is DERIVED from the YAML, so a flow-added edge would be a lie
  the user cannot undo) and answered by `ConnectionPopover` instead.
- **Name guards.** The forms cannot create a duplicate type or property name.
  There are exactly **two** namespaces, not three (`metamodel/helpers.ts`,
  mirroring `core/metamodel/check.py`): element types, enums and the five
  primitives share one — all are things a `datatype` can name — and relationship
  types have their own. The guard matters because a duplicate does not error
  anywhere: `typeMap` and the backend's caches both resolve first-wins, so a
  second `Zone` would silently absorb every later edit to the first.

#### Diagram navigation (LOD / hover / search / TOC)

At ~20 types the canvas is a picture; at ~300 it is a map, and four read
affordances make it navigable. None of them consults
`readOnly` or the role: a viewer zooms, hovers, searches and jumps exactly
like an owner — reading the metamodel is not an editing privilege, and the
gates above stay confined to what CHANGES the draft.

- **Hover must never rebuild `flowNodes`/`flowEdges`.** This is the premise
  the whole set is built on, not a micro-optimization: a pointer crossing a
  canvas fires continuously, and rebuilding two arrays of ~300 flow objects
  per frame is fine at twenty boxes and unusable at three hundred. So hover
  goes into `$state` in `state/metamodel-canvas.svelte.ts`, and each node and
  edge component `$derived`s its OWN class from it (`visualState`); the two
  `$effect`s in `MetamodelDiagram.svelte` that produce the flow arrays never
  read that store. `metamodel/diagram-adjacency.ts` is the other half —
  `buildAdjacency` runs once per `buildDiagram` result and `highlightFor`
  answers a hover in O(neighbourhood), so nothing on the hover path walks the
  metamodel. `built` itself hangs off a hoisted `parsedMm` derived rather than
  off the view snapshot (which is a fresh object literal on every recompute),
  so a selection, a collapse or a drag does not re-run `buildDiagram` either.
  Installing a new adjacency CLEARS the hover: a rebuild (undo, a peer's
  rebind, any draft edit) can retire the hovered id, and a hover left pointing
  at an id the new index never saw resolves to an EMPTY highlight — which
  `visualState` reads as "dim everything but the selection", greying the whole
  canvas until the pointer happens to move again.
- **LOD hides content with `visibility: hidden`, never `display: none` or a
  DOM removal.** Below zoom 0.4 (back out at 0.5 — the hysteresis gap is what
  stops the boundary flickering while the user sits on it) a box renders as
  its name alone and edge labels are suppressed. The compartments stay in the
  DOM and keep their space, so a box's height is byte-identical in both modes
  — which is what keeps the edge anchors from jumping the moment the mode
  flips. `nodeSize` and elk never learn LOD exists. What DOES branch on the
  mode is everything serving the cursor tooltip, which at that zoom is the
  only way to read what a box or an edge is: an edge's `interactionWidth`
  widens to `EDGE_HIT_WIDTH_LOD`, because that prop is in FLOW units and the
  xyflow default of 20 comes out around three screen pixels down there; the
  cursor is recorded only while the tooltip could actually be showing
  (`noteHoverCursor` — simplified mode on AND something hovered, else the last
  position is cleared rather than left to outlive the mode that produced it);
  and the tooltip places through `metamodel/diagram-tooltip.ts`, a pure anchor
  function that flips to the far side of the cursor near a window edge. The
  flip anchors `right`/`bottom` instead of subtracting an assumed width, so
  the gap to the cursor stays exact whatever the label measures, and the
  `LOD_TOOLTIP_MAX_*` constants are only the decision threshold.
- **The memo caches in these `.svelte.ts` modules are plain `let`, never
  `$state`.** `getDiagramHighlight()` is called from every node and edge
  render, so it memoizes on the `(hover, adjacency)` pair — but writing
  `$state` from a getter that runs mid-render trips `state_unsafe_mutation`.
  The same pattern, for the same reason, as the parse/build memos in
  `metamodel-diagram.svelte.ts`.
- **`revealSelection` takes the flow helpers as a parameter.**
  `components/Metamodel/reveal-action.ts` is the ONE navigate path — the
  toolbar's type search (`MetamodelSearch.svelte`, a client-side ranked
  substring match over the parsed draft: no API call, no debounce, no
  staleness protocol) and the form panel's TOC rows both go through it, so
  select → reopen the panel → pan/fit can never drift between them. It stays
  a plain function because `useSvelteFlow()` binds context at ITS call site:
  the caller under `<SvelteFlowProvider>` owns the hook, and a test hands the
  function a fake flow. The geometry is `metamodel/diagram-reveal.ts`'s pure
  `revealTarget` (center a box, fit the union rect of a relationship's boxes,
  or `none` for a mapless one, which selects without panning).
- **The form panel doubles as the table of contents**, and its collapse state
  is PERSONAL, not shared: `state/metamodel-panel.svelte.ts` keeps the whole
  column's collapse and each section's fold per project in `localStorage`,
  next to the diagram's own view/collapse keys and with the same try/catch
  stance (a denied storage just means the preference doesn't survive a
  reload). `revealSelection` reopens a collapsed panel because navigating BY
  NAME implies wanting the form; a plain canvas click deliberately does not.
- **The two typeaheads implement ONE combobox pattern.** The metamodel type
  search and the pre-existing `Sidebar/Search.svelte` element search are the
  same widget over different data (one client-side over the parsed draft, one
  server-backed and debounced), so they share the wiring down to the attribute
  set: `role="combobox"` + `aria-expanded`/`aria-controls`/`aria-autocomplete`
  on the input, `role="listbox"` on the list, non-interactive
  `<li role="option">` rows, and `aria-activedescendant` naming the active one.
  Focus never leaves the input — which is why the rows are `<li>` and not
  `<button>` (the listbox pattern forbids interactive descendants in an
  option), why each carries a `$props.id()`-derived id rather than a hardcoded
  one, and why an `$effect` scrolls the active row into view: nothing else
  will. Keyboard on both: ↑/↓, Enter, Escape, and Tab — which closes on the
  way out so a list is never left floating with nothing focused pointing at
  it. Outside-click closes through the dropdown's BOUND reference, never a
  `document.getElementById`, so two mounted at once cannot answer for each
  other. `searchTypes` returns `{hits, total}` rather than a bare array
  precisely so a capped list can say `+N more` instead of looking like a
  complete one.
- **The floor is `minZoom` 0.05**, not xyflow's default 0.5 — a big metamodel
  cannot otherwise be zoomed out far enough to see at all, and everything
  above is what makes the resulting picture readable once it is.

#### Manual smoke checklist — the diagram surface

The four gestures where the client and the commit flow have to agree (drag →
stage → commit → persisted; connection → popover → YAML; rename → cascade with
comments intact; commit → positions survive under the new names) have **no
e2e coverage**; this manual pass stands in for it. Run it before shipping a
change to
`state/metamodel-diagram.svelte.ts`, `state/metamodel-stage.svelte.ts`,
`metamodel/yaml-edit.ts`, `routes/metamodel_layout.py`, or `api/metamodel_ops.py`.
Steps 2, 6, 7 and 13 are the load-bearing ones.

**Setup**

```sh
# terminal 1 — needs a dev DB; DATA_ROVER_DEV_SEED with a sqlite DSN works
pixi run backend-start
# terminal 2
pixi run frontend-start
```

Open http://localhost:5173, log in, and open a project — import `smart-city` via
the New Project wizard if you have none. Then **TopBar → Edit Metamodel**, and
click the **Diagram** toggle in the tab's toolbar.

1. **Rendering.** Boxes appear for every element type and enum, laid out (not
   stacked at the origin). Generalization edges end in a hollow triangle at the
   supertype; `Contains` draws a filled diamond at the owner end, and both
   halves of that relationship are the same colour. Multiplicities read at the
   ends. Association-class relationships (ones with properties, or abstract, or
   in an `extends` chain) get their own box with two half-edges through it.
2. **Drag stages, commits, and is shared.** Drag two boxes somewhere memorable
   → the commit drawer's Metamodel section shows the staged move count. Open
   the drawer and **Commit** → reload the page, reopen the tab → they are
   where you left them. In a second browser profile signed in as another
   member of the same project, the same positions appear once that commit has
   landed (before committing, only your own session sees the drag).
3. **Auto-arrange.** Click **Auto-arrange** → the graph re-lays out top-down.
   Press **Ctrl/Cmd-Z** with the canvas focused → the previous positions come
   back.
4. **Collapse / find / fit.** **Collapse all** shrinks every box to its header;
   **Expand all** restores. Type a type name into **Find type…** and press Enter
   → the canvas pans to it and selects it. **Fit view** frames everything.
5. **Create a type.** Click **+ Element type** → a `NewType` box appears and the
   right-hand form panel opens on it. Rename it in the form to something free →
   the box and the YAML both follow. Try renaming it to `Zone` (or to `string`)
   → the form refuses with a message naming the collision.
6. **Draw a connection.** Drag from one element box's handle to another → a
   popover asks what you meant. Pick **new relationship type**, name it, choose
   containment or not → a new edge appears and the YAML gains the relationship
   with its `mappings`. Cancel the popover on a second drag → **no edge is left
   behind**.
7. **Rename cascades with comments intact.** Select `Zone`, rename it to
   `District` in the form. Switch to the **YAML** view: every `extends`,
   `mapping`, `datatype` and key reference to `Zone` has moved to `District`,
   and **the file's comments and formatting are untouched** — only the changed
   lines differ. Switch back to Diagram: the box kept its position.
8. **Property editing.** On any element type, add a property (name, datatype,
   multiplicity), edit one, remove one → the box's row list and the YAML both
   track. Adding a property whose name already exists on that type is refused.
   Build a key with the key builder → it appears in the YAML.
9. **Delete consequences.** Delete a type that others reference → the
   confirmation dialog lists what will be updated and what will dangle. Confirm,
   then check the YAML matches what it promised.
10. **Broken YAML fallback.** Switch to YAML, break the syntax by hand (delete a
    colon). Switch to Diagram → you get the "draft has syntax errors" placeholder
    with an **Open the YAML view** button, **not** a stale diagram, and the
    toolbar is gone. Fix the YAML → the diagram returns.
11. **Issue badge.** With a _semantically_ invalid but parseable draft (e.g. a
    `datatype` naming nothing), the toolbar shows an **"N issues"** badge on the
    right. Click it → it jumps to the YAML view.
12. **Preview + Commit still work end-to-end.** With a real change staged,
    click **Preview changes** → the structural diff and now-failing/now-passing
    lists render. Then open the commit drawer and **Commit** → it succeeds, the
    app refreshes (`rebind_event`, not a normal commit delta), and the
    metamodel tab's baseline adopts the committed YAML.
13. **Positions survive a rebind under new names.** Rename a type in the
    diagram, drag its box
    somewhere distinctive, **Preview**, then **Commit** the batch (rebind +
    move land in ONE commit), then reload → the box is still where you put it,
    now keyed by the new name. Check a peer's session too: once they've
    reloaded past the `rebind_event` banner, they see the same position, not a
    box jumped to the origin.
14. **Roles.** As an **editor** (not owner): the canvas is browsable, dragging
    still works and persists, but the create buttons and form inputs are gone
    and a note says metamodel edits are owner-only. As a **viewer**: dragging is
    disabled too, and the note says layout changes are not saved. With a peer
    holding the `mm` lease: the surface goes read-only and names the holder.

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
    api/artifacts.ts    READ-ONLY by design: listArtifacts / getArtifact /
                        evaluateNavigation. Artifact writes travel as staged
                        ops through POST /commits (see the staged-commit flow
                        above); there are deliberately no POST/PUT/DELETE
                        /artifacts wrappers, so no unjournalled write can
                        slip in
    api/artifact-bundle.ts  Bundle export/preview/import client (zod schemas
                        for ExportPreview / ImportPlan / ImportConfirmResponse)
                        with typed stale-plan 409 discrimination
                        (StalePlanImportError carries the server's
                        freshly-derived plan; a planless 409 stays a bare
                        ConflictError)
    state/              model.svelte.ts (staged-edit store) / changes (server
                        change-set badge) / selection / ui / filters /
                        metamodel / workspace / validation / file (filename
                        + FS Access handle); auth.svelte.ts — current user +
                        signIn/signOut; active-project.svelte.ts — active id +
                        base-URL wiring; access-notice.svelte.ts — denied-access
                        message for the picker; confirm.svelte.ts — the app-wide
                        `confirm({...}): Promise<boolean>` prompt, a FIFO queue
                        of requests drained by the single ConfirmHost mounted in
                        the root layout (requests queue rather than replace, so
                        nothing is auto-answered); the browser's own confirm
                        survives only in the beforeNavigate unload guard, which
                        must decide synchronously; session-recovery.ts — global
                        401 → clear + bounce to /login; realtime.svelte.ts —
                        feed transport store: connection status, presence
                        (string[]), lock state (SvelteMap resource_id →
                        LeaseLite), feed-termination state, applies remote
                        commit deltas via applyDelta (UNCONDITIONALLY — rev
                        adoption is mandatory) and fans commits out to
                        onCommitEvent taps with the event's {scope} (absent =
                        ['model']), so an artifact-only commit skips model-only
                        work like the table re-page; checkout.svelte.ts — lock
                        registry, ensureCheckout/heartbeat, preview/commit of
                        the model + artifact buffers as one batch (keeping back
                        the leases the batch does not need),
                        releaseArtifactIfUnneeded /
                        reacquireOpenArtifactLeases, discard (discardElement /
                        discardElementCascade), role gating;
                        artifact-edits.svelte.ts — the staged-artifact-ops
                        buffer: one coalesced entry per artifact id, commit /
                        discard / staged-delete listener registries, and the
                        overlayArtifactHeaders projection the library renders
                        through; staged-rows.ts — pure derivation of the
                        sidebar "Staged elements" rows from getStagedDiff() +
                        the display caches (new/edited/deleted badges; the
                        edited rule fires only for endpoints of staged
                        relationship OPS, never cascade-journal entries);
                        edit-gate.ts — maps an edit intent
                        to its required locks and gates the mutation;
                        lock-badge.ts — per-row lock badge derivation;
                        lock-notice.svelte.ts — transient lock-conflict notice;
                        view-discard-notice.svelte.ts — durable "staged view
                        edits were discarded" banner notice (survives a
                        successful lease acquisition, unlike lock-notice.svelte.ts);
                        api/checkout.ts — the locks + commits REST client;
                        history.svelte.ts — commit-list store (paged
                        GET /commits), rev→ModelOut reconstruction cache,
                        resetHistory/loadFirstPage/loadMore/modelAt;
                        inspection-history.svelte.ts — the Inspector's
                        back/forward visit trail: in-memory stack + cursor (cap
                        50), pushed from select(), replayed with a re-entrancy
                        guard; per-direction dropdown slices resolve labels
                        lazily;
                        unsaved.ts — hasUnsavedWork() (staged model ops + staged
                        artifact ops + dirty table/navigation/snippet/
                        exporter drafts), input to the workspace unload
                        guard (beforeNavigate in p/[projectId]/+page);
                        snippet-editor.svelte.ts — per-tab code-snippet
                        drafts, save lifecycle, debounced lint + run/stop
                        state; snippet-stage.ts — folds a snippet run's op
                        batch into the staged-edits buffer (temp-id remap,
                        pre-state prefetch, per-intent lock groups);
                        snippet-docs.svelte.ts — fetch-once cache of the
                        facade docs payload (ensureSnippetDocs/
                        getSnippetDocs), silent-degrade on fetch failure,
                        reset at onReloadModel;
                        exporter-editor.svelte.ts — per-tab
                        (`exp:draft:<n>` / `exp:<id>`) exporter drafts:
                        the same draft/lease/save-stages-not-posts shape as
                        snippet-editor.svelte.ts, plus copy-at-add
                        (addExporterEntry -> entryForTable copies a table's
                        export settings into the entry once, then the two
                        drift independently);
                        metamodel-editor.svelte.ts — the metamodel tab's
                        buffer/baseline, localStorage draft, debounced lint,
                        on-demand preview, and its draft-provider registration
                        with metamodel-stage (see "Live metamodel editing"
                        above); metamodel-lease.svelte.ts — the `mm`
                        lease lifecycle it composes, surface-agnostic and
                        generation-guarded on its own;
                        metamodel-diagram.svelte.ts — the diagram surface's
                        state (view toggle, selection, collapse, shared
                        positions + staged moves, bounded undo); owns no draft
                        state, edits through editMetamodelBuffer;
                        metamodel-stage.svelte.ts — the fourth staged commit
                        family: the draft provider registration + coalesced
                        staged node moves, localStorage-mirrored, read by
                        checkout.svelte.ts to build the batch;
                        metamodel-canvas.svelte.ts — per-frame canvas
                        ephemera the node/edge components read directly
                        (hover, the built adjacency, the LOD flag with its
                        zoom hysteresis, the LOD tooltip's cursor); nothing
                        persists and MetamodelDiagram resets it on unmount;
                        metamodel-panel.svelte.ts — the form panel's PERSONAL
                        preferences (whole-column collapse + per-TOC-section
                        folds), per project in localStorage, same try/catch
                        stance as the diagram's own view/collapse keys
    editor/completion-source.ts  dr./Element/Relationship/stereotype-name CM6 completions +
                        hover logic (vocabFromMetamodel, computeCompletions,
                        resolveDocAt); pure, CM-agnostic, unit-tested
    editor/indent.ts    Indentation policy — FOUR SPACES, never a tab, because
                        CPython rejects mixed indentation with TabError and
                        the author cannot see which is which. expandTabs()
                        is column-aware (next tab stop, not blind 4×);
                        hasTabs() tints CodeEditor's Reformat control rather
                        than gating a separate one.
                        indent-extension.ts is the CM6 half: indentUnit +
                        tabSize of 4, Tab/Shift-Tab bound to one full level
                        (CM's DEFAULT unit is TWO spaces — with it Shift-Tab
                        dedented half a level and read as broken), and a
                        paste handler that expands tabs on the way in. Both
                        unit-tested without a mounted view.
    editor/editor-size.ts  Inline-editor height + snippet-tab split geometry and
                        their localStorage keys (ui.snippet.inlineEditorH /
                        ui.snippet.tabSplitRatio). Pure; the reactive wrapper
                        is state/editor-size.svelte.ts, GLOBAL per kind — see
                        its docstring for why per-instance memory cannot work
                        for navigation script steps. Storage is try/catch'd
                        rather than `browser`-gated (the vitest alias stubs
                        browser to false, which would defeat every test).
    editor/search-panel.ts  Custom Ctrl+F panel (search({top,createPanel})) with
                        a live match counter capped at 1000 so a one-char
                        query cannot rescan the doc on every keystroke.
                        Presentation only — every action delegates to
                        @codemirror/search's commands; plain DOM (no nested
                        Svelte root inside a CM panel), styled by the
                        cm-dr-search* rules in editor/theme.ts.
    editor/format.ts    lineStartOffset() — cursor-line preservation for the
                        one-transaction reformat replacement.
    snippet/docs-view.ts   View-model helpers for the facade docs panel
                        (groupFacade, formatSeconds/formatBytes, type +
                        relationship summaries); mirrors console-view.ts
    metamodel/          Pure helpers (effective properties, multiplicity,
                        containment, subtype) mirroring the Python schema;
                        connection-rules.ts (creatable relationship types from
                        a source); the diagram editor's three pure modules —
                        yaml-edit.ts (comment-preserving YamlEditCommand core),
                        diagram-build.ts (metamodel → UML nodes/edges),
                        arrange.ts (elkjs layout + incremental placement)
    components/         TopBar, Sidebar, Workspace, Inspector, StatusBar,
                        DiffDrawer, HistoryDrawer, SettingsDialog,
                        AppHeader, dialogs, and ui/ shadcn
                        primitives (button, dialog, dropdown-menu, …);
                        ArtifactsMenu.svelte — the TopBar toolbar's
                        Export…/Import… dropdown, mounting
                        Export/ImportArtifactsDialog.svelte once beside it;
                        Metamodel/{MetamodelTab,MetamodelYamlEditor,
                        MetamodelPreviewPanel}.svelte — the metamodel tab,
                        its CodeMirror YAML host (readOnly compartment +
                        externalReplace annotation so a programmatic doc
                        swap never echoes back as a keystroke) and the
                        issue + structural preview panel;
                        Metamodel/MetamodelDiagram.svelte — the canvas
                        (xyflow) plus Metamodel/diagram/ (UML node + edge
                        components, ConnectionPopover) and Metamodel/forms/
                        (element/relationship/enum forms, PropertyListEditor,
                        KeyBuilder, DeleteTypeDialog, shared field-classes);
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
disable strict mode → assert the same batch can now commit; the snippet
workspace tab (`snippet-flow.spec.ts`): lint gutter surfaces a sandbox-import
warning, run prints to the console via the real WASM sandbox, and stage +
commit a snippet run's op batch; and embedded script evaluation
(`script-embedding.spec.ts`): a table script column bound to a saved
snippet renders computed values alongside an `error-cell` for a row that
raises and survives sorting, an inline script column computes a constant, and
a navigation script step follows real `el.outgoing()` neighbors into non-empty
chains before a raising step surfaces the `nav-warnings` chip — all three
self-skip if the WASM guest binary isn't fetched (same runner-availability
guard as `snippet-flow.spec.ts`).

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
