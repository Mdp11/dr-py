import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/** A file path on disk, or an in-memory file payload for Playwright. */
export type FileArg = string | { name: string; mimeType: string; buffer: Buffer };

function bodyOf(file: FileArg): Buffer {
	return typeof file === 'string' ? readFileSync(file) : file.buffer;
}

// --------------------------------------------------------------------------
// View seeding — views are named, project-level objects managed through the
// direct `GET/POST/DELETE /views` routes (a whole-view add/remove is not a
// commit; folder edits INSIDE a view are, via `view.*` ops in POST /commits).
// The harness replaces the project's whole view set through those routes.
// --------------------------------------------------------------------------

/** A `*.view.json` fixture's top-level shape — posted verbatim as the
 * document of `POST /views`; `name` doubles as the view's project-unique
 * name (`Operational` when absent, matching the seeded Smart City view). */
type ViewFixture = {
	name?: string;
	folders?: unknown[];
	artifacts?: unknown[];
};

type ViewSummary = { id: string; name: string };

/**
 * Replace the OPEN project's views with *fixture* (`undefined` leaves the
 * project with no view at all): every existing view is deleted, then the
 * fixture — when given — is added under its own `name`. Deleting 409s while
 * a peer holds a lease inside a view; the e2e fixtures start lease-free.
 * The client's remembered choice (localStorage) can only name a view that
 * no longer exists after this, and `loadViews` then falls back to the first
 * view by name — the freshly added one.
 */
async function seedView(
	page: Page,
	base: string,
	headers: Record<string, string>,
	fixture: ViewFixture | undefined
): Promise<void> {
	const current = await page.request.get(`${base}/views`);
	expect(current.ok(), await current.text()).toBeTruthy();
	for (const v of (await current.json()) as ViewSummary[]) {
		const del = await page.request.delete(`${base}/views/${encodeURIComponent(v.id)}`, {
			headers
		});
		expect(del.ok(), await del.text()).toBeTruthy();
	}
	if (fixture === undefined) return;
	const created = await page.request.post(`${base}/views`, {
		headers,
		data: { name: fixture.name ?? 'Operational', view: fixture },
		timeout: 60_000
	});
	expect(created.ok(), await created.text()).toBeTruthy();
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
	// one, drop every view carried over from the previous content (the seeded
	// Smart City view would dangle against the new model).
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
