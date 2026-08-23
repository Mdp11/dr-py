import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/** A file path on disk, or an in-memory file payload for Playwright. */
export type FileArg = string | { name: string; mimeType: string; buffer: Buffer };

function bodyOf(file: FileArg): Buffer {
	return typeof file === 'string' ? readFileSync(file) : file.buffer;
}

// --------------------------------------------------------------------------
// View seeding — only `GET /view` reads view content directly (see CLAUDE.md's
// "View ops" section); the client reaches view content exclusively through
// the lock-verified `POST /commits` flow, so this harness drives the same
// path. Shapes below mirror the wire types in `src/data_rover/api/schemas.py`
// (`FolderOut`/`ViewOut`/`ArtifactRefOut`) closely enough for this file's own
// purposes; they are not meant to be a general client model of the view.
// --------------------------------------------------------------------------

type ArtifactRefIn = { id: string; kind: string };

/** One folder in a `*.view.json` fixture (or an inline object a spec builds
 * itself) — the nested shape `_seed_view` in
 * `tests/api/test_commits_view_ops.py` uses for the same purpose. */
type ViewFolderFixture = {
	name: string;
	folders?: ViewFolderFixture[];
	elements?: string[];
	artifacts?: ArtifactRefIn[];
};

/** A `*.view.json` fixture's top-level shape. `name` is deliberately NOT
 * carried through by `seedView` below: the ten-op `view.*` family has no
 * rename-the-view op (only `rename_folder`), so a view's name is fixed at
 * whatever it was auto-created/imported with and this harness cannot change
 * it — every fixture this suite loads happens to already agree with the
 * "Smart City" project's seeded name ("Operational"), which is what
 * `seed.setup.ts`'s wizard import gave it. */
type ViewFixture = {
	name?: string;
	folders?: ViewFolderFixture[];
	artifacts?: ArtifactRefIn[];
};

/** `GET /view`'s folder/view shapes — only the fields `seedView` needs. */
type CurrentFolder = { id: string };
type CurrentView = { folders: CurrentFolder[]; artifacts: ArtifactRefIn[] } | null;

/** One raw `view.*` op dict, keyed exactly like `src/data_rover/api/schemas.py`'s
 * `ViewOpIn` discriminated union (`kind` is the discriminator). Built as plain
 * objects rather than importing generated types: this harness talks to the
 * API the same way `page.request` does everywhere else in this file. */
type ViewOp = Record<string, unknown>;

/** `delete_folder` for every TOP-level folder currently in *view*, plus
 * `remove_artifact` for every root-level artifact ref. A `delete_folder` op
 * cascades its whole subtree server-side (`required_locks`/`expand_targets`
 * in `api/locking.py` walk it via `folder_subtree`), so only the top level
 * needs an op each — the same reason only the top level needs a lease below. */
function clearOps(view: CurrentView): ViewOp[] {
	if (view === null) return [];
	return [
		...view.folders.map((f) => ({ kind: 'delete_folder', id: f.id })),
		...view.artifacts.map((a) => ({
			kind: 'remove_artifact',
			artifact_id: a.id,
			folder_id: 'root'
		}))
	];
}

/** `create_folder` (+ `place_element`/`place_artifact` for its contents) for
 * every folder in *fixture*, recreated under fresh temp ids, plus
 * `place_artifact` for its root-level artifact refs. Elements are never
 * placed at "root" (`PlaceElementOp.folder_id` must be a real folder id —
 * unplaced elements already render at the root pool); artifacts may be,
 * since `View.artifacts` is a real root list. */
function buildOps(fixture: ViewFixture): ViewOp[] {
	const ops: ViewOp[] = [];
	let counter = 0;

	function walk(folder: ViewFolderFixture, parentId: string): void {
		counter += 1;
		const tempId = `tmp_${counter}`;
		ops.push({ kind: 'create_folder', temp_id: tempId, parent_id: parentId, name: folder.name });
		for (const elementId of folder.elements ?? []) {
			ops.push({ kind: 'place_element', element_id: elementId, folder_id: tempId });
		}
		for (const ref of folder.artifacts ?? []) {
			ops.push({
				kind: 'place_artifact',
				artifact_id: ref.id,
				artifact_kind: ref.kind,
				folder_id: tempId
			});
		}
		for (const child of folder.folders ?? []) walk(child, tempId);
	}

	for (const folder of fixture.folders ?? []) walk(folder, 'root');
	for (const ref of fixture.artifacts ?? []) {
		ops.push({
			kind: 'place_artifact',
			artifact_id: ref.id,
			artifact_kind: ref.kind,
			folder_id: 'root'
		});
	}
	return ops;
}

/**
 * Replace the OPEN project's view with *fixture* (`undefined` clears it to
 * empty) through `POST /commits`, driving the exact path the real client
 * uses (see CLAUDE.md's "View ops" section) rather than a test-only
 * shortcut.
 *
 * Reads the CURRENT view, diffs it away (`clearOps`), then — when *fixture*
 * is given — rebuilds it from scratch (`buildOps`), and posts both as ONE
 * batch. A single `folder:root` + one-lease-per-existing-top-folder
 * acquisition covers the whole thing: `delete_folder`'s lock requirement
 * subtree-expands from each top-level id server-side, so locking just the
 * top level (never the full recursive listing) already covers everything
 * nested under it, and ids created earlier in the SAME batch (the freshly
 * `create_folder`'d temp ids) need no lock to be placed into. Skips the
 * lock+commit round trip entirely when there is nothing to do — an empty
 * `POST /commits` would orphan the caller's leases until TTL expiry (see
 * `routes/commits.py`'s empty-batch early return).
 */
async function seedView(
	page: Page,
	base: string,
	headers: Record<string, string>,
	fixture: ViewFixture | undefined
): Promise<void> {
	const current = await page.request.get(`${base}/view`);
	expect(current.ok(), await current.text()).toBeTruthy();
	const currentView = ((await current.json()) as { view: CurrentView }).view;

	const ops = [...clearOps(currentView), ...(fixture !== undefined ? buildOps(fixture) : [])];
	if (ops.length === 0) return;

	const targets = [
		{ resource_id: 'root', mode: 'exclusive', type: 'folder' },
		...(currentView?.folders.map((f) => ({
			resource_id: f.id,
			mode: 'exclusive',
			type: 'folder'
		})) ?? [])
	];
	const lock = await page.request.post(`${base}/locks`, {
		headers,
		data: { targets, intent: 'delete' }
	});
	expect(lock.ok(), await lock.text()).toBeTruthy();
	const { token } = (await lock.json()) as { token: string };

	const open = await page.request.get(`${base}/open`);
	expect(open.ok(), await open.text()).toBeTruthy();
	const { model_rev: baseRev } = (await open.json()) as { model_rev: number };

	// POST /commits releases every token it is sent on success, so there is
	// no separate /locks/release call here (mirrors the client's own
	// checkout.svelte.ts flow).
	const commit = await page.request.post(`${base}/commits`, {
		headers,
		data: { base_rev: baseRev, ops, message: 'e2e fixture seed', lock_tokens: [token] },
		timeout: 60_000
	});
	expect(commit.ok(), await commit.text()).toBeTruthy();
}

/**
 * Replace the OPEN project's content: metamodel + model are required, the view
 * is optional. They are applied in order (the backend enforces metamodel ->
 * model -> view) against the project-scoped upload routes — the same calls the
 * old "Load files" dialog made before the topbar entry point was removed
 * (006f460 left `LoadFilesDialog` unreachable, so this helper drives the API
 * directly through the page's request context: same session cookie, same
 * dev-server proxy) — except for the view, which now goes through the
 * commit-flow `seedView` above rather than a raw upload (see its docstring).
 * Ends with a reload so the client re-fetches the fresh content; callers may
 * then interact with the workspace immediately.
 */
export async function loadFiles(
	page: Page,
	files: { metamodel: FileArg; model: FileArg; view?: FileArg }
): Promise<void> {
	const match = page.url().match(/\/p\/([^/?#]+)/);
	if (!match) {
		throw new Error(`loadFiles: expected a workspace URL (/p/<projectId>), got ${page.url()}`);
	}
	const base = `/api/v1/projects/${match[1]}`;
	// Unsafe methods with the session cookie present must carry the CSRF header
	// (see CSRFMiddleware); the dev server proxies /api/v1 to the backend.
	const headers = { 'x-requested-with': 'data-rover' };

	// 1. metamodel — uploading clears the active model on the backend. A
	// non-empty model makes it 409 (initial-bind-only guard); clear the existing
	// metamodel+model (DELETE resets both) and retry, exactly as the dialog did.
	// With the seeded Smart City project this retry path is the NORMAL path.
	let mm = await page.request.post(`${base}/metamodel`, {
		headers: { ...headers, 'content-type': 'application/yaml' },
		data: bodyOf(files.metamodel),
		timeout: 60_000
	});
	if (mm.status() === 409) {
		const cleared = await page.request.delete(`${base}/metamodel`, { headers });
		expect(cleared.ok(), await cleared.text()).toBeTruthy();
		mm = await page.request.post(`${base}/metamodel`, {
			headers: { ...headers, 'content-type': 'application/yaml' },
			data: bodyOf(files.metamodel),
			timeout: 60_000
		});
	}
	expect(mm.ok(), await mm.text()).toBeTruthy();

	// 2. model — streamed as the raw body, parsed against the new metamodel.
	// A large model on a cold dev environment can take well over 5 s.
	const model = await page.request.post(`${base}/model/upload`, {
		headers: { ...headers, 'content-type': 'application/json' },
		data: bodyOf(files.model),
		timeout: 60_000
	});
	expect(model.ok(), await model.text()).toBeTruthy();

	// 3. view (optional) — validated against the freshly-loaded model. Without
	// one, clear any view carried over from the previous content (the seeded
	// Smart City view would dangle against the new model), mirroring the old
	// dialog's clear-view-state behavior — but now via `seedView`'s commit
	// batch rather than a blind DELETE, since that route is gone.
	await seedView(
		page,
		base,
		headers,
		files.view !== undefined
			? (JSON.parse(bodyOf(files.view).toString('utf8')) as ViewFixture)
			: undefined
	);

	// The uploads happened behind the client's back — reload so every store
	// re-hydrates from the new content before the caller interacts with it.
	await page.reload();
	await page.waitForURL('**/p/**');
}
