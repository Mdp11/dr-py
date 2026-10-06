import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** A file path on disk, or an in-memory file payload for Playwright. */
export type FileArg = string | { name: string; mimeType: string; buffer: Buffer };

function bodyOf(file: FileArg): Buffer {
	return typeof file === 'string' ? readFileSync(file) : file.buffer;
}

/**
 * Replace the OPEN project's content: metamodel + model are required, the view
 * is optional. The server rebinds a metamodel over a non-empty model only
 * through a journaled commit, and reads or uploads no model, so the content is
 * replaced as the project wizard would create it: the open project is deleted
 * and a project of the same name is imported from the files through
 * `POST /projects` (same session cookie, same dev-server proxy). Specs find
 * the project by name afterwards. Without a view the new project has none.
 * Ends on the new project's workspace, so callers may interact with it
 * immediately.
 */
export async function loadFiles(
	page: Page,
	files: { metamodel: FileArg; model: FileArg; view?: FileArg }
): Promise<void> {
	const match = page.url().match(/\/p\/([^/?#]+)/);
	if (!match) {
		throw new Error(`loadFiles: expected a workspace URL (/p/<projectId>), got ${page.url()}`);
	}
	const api = '/api/v1';
	// Unsafe methods with the session cookie present must carry the CSRF header
	// (see CSRFMiddleware); the dev server proxies /api/v1 to the backend.
	const headers = { 'x-requested-with': 'data-rover' };

	const open = await page.request.get(`${api}/projects/${match[1]}`);
	expect(open.ok(), await open.text()).toBeTruthy();
	const { name } = (await open.json()) as { name: string };

	const part = (file: FileArg, mimeType: string) => ({
		name: typeof file === 'string' ? basename(file) : file.name,
		mimeType: typeof file === 'string' ? mimeType : file.mimeType,
		buffer: bodyOf(file)
	});
	const multipart: Record<string, string | ReturnType<typeof part>> = {
		name,
		metamodel: part(files.metamodel, 'application/yaml'),
		model: part(files.model, 'application/json')
	};
	if (files.view !== undefined) multipart.view = part(files.view, 'application/json');

	const removed = await page.request.delete(`${api}/projects/${match[1]}`, { headers });
	expect(removed.ok(), await removed.text()).toBeTruthy();
	// A large model on a cold dev environment can take well over 5 s.
	const created = await page.request.post(`${api}/projects`, {
		headers,
		multipart,
		timeout: 60_000
	});
	expect(created.status(), await created.text()).toBe(201);
	const { id } = (await created.json()) as { id: string };

	await page.goto(`/p/${id}`);
	await page.waitForURL('**/p/**');
}
