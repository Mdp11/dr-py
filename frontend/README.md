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
  A back/forward arrow cluster (`Inspector/HistoryNav`) sits above it, replaying
  the trail of inspected elements, with a long-press/right-click dropdown of up
  to 10 entries per direction.
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
   Staged elements are also browsable: the sidebar's **"Staged elements"**
   section (`components/Sidebar/StagedSection.svelte`, rows derived by
   `state/staged-rows.ts`) lists every element the buffer touches — new /
   edited / deleted, badged — which is the ONLY way to reach a temp-id element
   (it exists nowhere in the server-paged containment tree). Its per-row revert
   is `discardElementCascade`, which reverts via `revertStagedForElement` (the
   element's own ops PLUS every staged relationship op incident to it — a
   surviving rel pointing at a reverted temp id would 422 the commit) and then
   releases the element's lock token when no remaining staged op still needs it.
6. **Artifacts ride the same loop.** Saved navigations, tables and code
   snippets are project artifacts rather than model entities, but their
   editing is the identical check-out → stage → commit shape, so the client
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
8. **Export** streams the last committed session state to a file: a picked
   file goes up as a raw `fetch` body (`POST /model/upload`, no JS-side parse)
   or by server path (`POST /model/load`); export pipes `GET /model/download`
   into a File System Access writable (or writes server-side via
   `POST /model/save`), so the browser never materializes the serialized model
   as a string. Export reflects the committed model, not the staged buffer.

### View editing state (staged `view.*` ops)

`lib/state/view.svelte.ts` holds `_view`: the LOCAL working copy — server
truth as of the last `refreshView()`, with every staged `view.*` op already
applied optimistically on top. **There is no more direct PUT path.** The
pre-artefacts-Phase-2 whole-snapshot `PUT /view/snapshot` is gone from every
gesture the app itself drives (folder create/rename/move/delete, element and
artifact placement, drag-and-drop, the sidebar's Clear-view action): every
structural change to the view goes out as a `ViewOp` and reaches the server
only via `POST /commits`, the same endpoint model and artifact edits commit
through. (`PUT /view/snapshot` and `DELETE /view` still exist server-side for
the frontend migration window — see CLAUDE.md — but nothing in this client
calls them any more except the e2e test harness's own fixture-loading helper,
which talks to the API directly to seed a project's starting content.)

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
  `window.prompt`/confirm dialog even opens ("Decision 2" in those
  components' comments) — a denial means the dialog never shows at all,
  rather than the user typing a name into a doomed rename. Cancelling the
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
- **View discard is all-or-nothing**, unlike the model/artifact buffers'
  per-row revert: the DiffDrawer's View tab renders the journal read-only (no
  per-entry button) with ONE "Discard view changes" action
  (`discardViewChanges`), which wipes the whole journal, hands back every
  `folder:` lease it named, and refetches server truth — there is no local
  undo to fall back on, since the journal's entries are not independently
  revertible (see the ordering rationale above).
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
  the root `[]`); `getDraft`/`getNavLockHolder`/`updateDefinition`/`saveDraft`
  stay per-tab. `closeDraft` and `resetNavigationEditors` clear **every** node
  key for the tab (expanded set plus any lingering keys), cancel all timers, and
  bump generations so nothing leaks.

### Script columns & steps (M2/M3)

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
  selected ref that later falls out of that filter (the artifact's snippet no
  longer defines the entry, or was deleted) surfaces as `snippet-ref-missing`
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
    server refuses** (422 unparseable, 503 no ruff) — that is the old "Fix
    indentation" behaviour this control absorbed. A 503 latches the control
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
  no Stop button: M1's cancel is a server-side no-op and the wall timeout is
  10s.
- **Error cells.** A script column's `value()` call failing server-side
  (`core/script/embed.py`'s `ScriptEvalContext` — degraded, not failed: a
  missing runner, a full concurrency slot, or a snippet exception) renders
  that one cell as `Table/Cell/ErrorCell.svelte` (`error-cell`) instead of a
  `ValueCell`, showing `cell.message` with `cell.traceback ?? cell.message` as
  the hover title. The row otherwise renders normally — one bad cell never
  blanks the row, and sorting/paging keep working around it.
- **Pending cells + the sweep poll.** Whole-table script passes no longer run
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
  **WHY on demand** (this is not a UX preference — fetching on settle was the
  original design and had to be undone): the recap route renders the whole
  table CACHE-ONLY, and for the commonest shape — an unsorted `collapse` script
  column with `keep_empty` — the page route makes **zero** `value()` calls (the
  build pass skips it, the order pass short-circuits with no sort) and computes
  only the visible window live, so the page reports `ready` **without ever
  kicking a sweep**. The recap then misses on every row outside that window and
  kicks a full background sweep. Fetching it automatically would have turned
  "open a table with a script column" into "sweep the whole table", plus up to
  120 once-a-second retries each re-paying a full build + order + render.
  `/tables/export` has the identical loop, but only behind an explicit click —
  so the recap is behind one too, and the up-front error count is deliberately
  given up.
  **Fetch-ONCE per page state**: the recap is still keyed by
  `"<status>:<model_rev>:<generation>"`, now as the signature of the page state
  on screen — background chunk fills as the user scrolls change none of the
  three, so they neither re-fetch nor drop the recap already paid for, while a
  peer's commit (new rev) **and** a sort change, a definition edit or a reload
  (all of which bump the tab's page-load **generation**) DROP it on the spot,
  without fetching anything; the next click re-fetches. All three parts are
  load-bearing: `row_index`/`column_index` address the order the grid is
  _currently_ showing, and a sort or definition edit reorders every row at a
  CONSTANT `model_rev` — keyed without the generation the tab would keep
  showing the recap built for the previous order, and jump-to-cell would scroll
  to the row that used to be there. The recap is also dropped whenever the table
  stops being settled (which also hides the badge). A **202** (sweep still
  filling the cache — the STATUS CODE is the retry signal, as for export)
  schedules exactly ONE delayed retry per tab, bounded like the sweep poll;
  exhausting that budget, like any failed fetch, reports the `error` phase and
  never anything worse, because this surface must never be what breaks a table
  view.
- **Staged definition edits (the settings dialog).** `updateTableDefinition`
  normally re-evaluates the whole table — a fresh backend cache key, and for a
  script column a fresh sweep. Inside the settings dialog the user is
  _composing_ (typing a snippet, trying a chain, undoing it), and each
  intermediate state used to pay for that, on a grid the modal was covering
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
  header input no longer debounces: per-keystroke applies now cost a draft
  object and nothing else, and the old 400ms timer silently discarded a rename
  that was typed and then Escaped inside the window (`change` never fires for
  an input unmounted while still focused).
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

The Export button is a dropdown (Excel `.xlsx` / JSON `.json`). Neither item
downloads directly: both open `components/Table/ExportDialog.svelte` with that
format preselected, and a segmented control switches format in place. Confirming
runs the same `downloadTable` retry loop as before — the backend's 202 +
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
exported the same way every week is configured once.

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
  buffer, MODEL and ARTIFACT alike: `getStagedDepth()`,
  `getStagedArtifactDepth()` and `getLockState().size` must all be 0 (the
  metamodel-swap drawer gates on the same expression). Selecting
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
    api/artifacts.ts    READ-ONLY by design: listArtifacts / getArtifact /
                        evaluateNavigation. Artifact writes travel as staged
                        ops through POST /commits (see the staged-commit flow
                        above); the legacy POST/PUT/DELETE /artifacts wrappers
                        were deleted so no regression can reintroduce an
                        unjournalled write
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
                        artifact ops + dirty table/navigation/snippet drafts),
                        input to the workspace unload guard (beforeNavigate in
                        p/[projectId]/+page);
                        snippet-editor.svelte.ts — per-tab code-snippet
                        drafts, save lifecycle, debounced lint + run/stop
                        state; snippet-stage.ts — folds a snippet run's op
                        batch into the staged-edits buffer (temp-id remap,
                        pre-state prefetch, per-intent lock groups);
                        snippet-docs.svelte.ts — fetch-once cache of the
                        facade docs payload (ensureSnippetDocs/
                        getSnippetDocs), silent-degrade on fetch failure,
                        reset at onReloadModel
    editor/completion-source.ts  dr./Element/Relationship/stereotype-name CM6 completions +
                        hover logic (vocabFromMetamodel, computeCompletions,
                        resolveDocAt); pure, CM-agnostic, unit-tested
    editor/indent.ts    Indentation policy — FOUR SPACES, never a tab, because
                        CPython rejects mixed indentation with TabError and
                        the author cannot see which is which. expandTabs()
                        is column-aware (next tab stop, not blind 4×);
                        hasTabs() now tints CodeEditor's Reformat control
                        (which absorbed the old "Fix indentation" button)
                        rather than gating a separate one.
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
disable strict mode → assert the same batch can now commit; the snippet
workspace tab (`snippet-flow.spec.ts`): lint gutter surfaces a sandbox-import
warning, run prints to the console via the real WASM sandbox, and stage +
commit a snippet run's op batch; and embedded script evaluation
(`script-embedding.spec.ts`, M2/M3): a table script column bound to a saved
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
