import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/** A file path on disk, or an in-memory file payload for Playwright. */
export type FileArg = string | { name: string; mimeType: string; buffer: Buffer };

function bodyOf(file: FileArg): Buffer {
	return typeof file === 'string' ? readFileSync(file) : file.buffer;
}

/**
 * Replace the OPEN project's content: metamodel + model are required, the view
 * is optional. They are applied in order (the backend enforces metamodel ->
 * model -> view) against the project-scoped upload routes — the same calls the
 * old "Load files" dialog made before the topbar entry point was removed
 * (006f460 left `LoadFilesDialog` unreachable, so this helper drives the API
 * directly through the page's request context: same session cookie, same
 * dev-server proxy). Ends with a reload so the client re-fetches the fresh
 * content; callers may then interact with the workspace immediately.
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
	// one, delete any view carried over from the previous content (the seeded
	// Smart City view would dangle against the new model), mirroring the old
	// dialog's clear-view-state behavior.
	if (files.view !== undefined) {
		const view = await page.request.put(`${base}/view/snapshot`, {
			headers,
			data: JSON.parse(bodyOf(files.view).toString('utf8')),
			timeout: 60_000
		});
		expect(view.ok(), await view.text()).toBeTruthy();
	} else {
		const cleared = await page.request.delete(`${base}/view`, { headers });
		expect(cleared.ok() || cleared.status() === 404, await cleared.text()).toBeTruthy();
	}

	// The uploads happened behind the client's back — reload so every store
	// re-hydrates from the new content before the caller interacts with it.
	await page.reload();
	await page.waitForURL('**/p/**');
}
