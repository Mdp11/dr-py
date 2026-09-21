import { expect, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';

/** The backend itself, not the dev server's proxy. */
export const API = 'http://127.0.0.1:8000/api/v1';

type Playwright = PlaywrightWorkerArgs['playwright'];

/**
 * A second client: its own cookie jar, logged in as the bootstrap admin, the
 * CSRF header on every request (the session cookie is present on all of
 * them). Paths are relative to `API`, without a leading slash. Dispose it.
 */
export async function peer(playwright: Playwright): Promise<APIRequestContext> {
	const api = await playwright.request.newContext({
		baseURL: `${API}/`,
		extraHTTPHeaders: { 'x-requested-with': 'data-rover' }
	});
	const login = await api.post('auth/login', {
		data: { email: 'admin@example.com', password: 'admin12345' }
	});
	expect(login.ok(), await login.text()).toBeTruthy();
	return api;
}

export async function projectIdByName(api: APIRequestContext, name: string): Promise<string> {
	const res = await api.get('projects');
	expect(res.ok(), await res.text()).toBeTruthy();
	const project = ((await res.json()) as { id: string; name: string }[]).find(
		(p) => p.name === name
	);
	if (project === undefined) throw new Error(`no project named ${name}`);
	return project.id;
}

async function json<T>(api: APIRequestContext, path: string): Promise<T> {
	const res = await api.get(path);
	expect(res.ok(), `${path}: ${await res.text()}`).toBeTruthy();
	return (await res.json()) as T;
}

/** The server's `model_rev`. */
export async function headRev(api: APIRequestContext, projectId: string): Promise<number> {
	return (await json<{ model_rev: number }>(api, `projects/${projectId}/open`)).model_rev;
}

/** The `rev` of the snapshot a replica would open from now. */
export async function snapshotRev(api: APIRequestContext, projectId: string): Promise<number> {
	return (await json<{ rev: number }>(api, `projects/${projectId}/replica/snapshot`)).rev;
}

/** The ids of the first `limit` elements, in model order. */
export async function elementIds(
	api: APIRequestContext,
	projectId: string,
	limit = 10
): Promise<string[]> {
	const page = await json<{ items: { id: string }[] }>(
		api,
		`projects/${projectId}/model/elements?limit=${limit}`
	);
	return page.items.map((e) => e.id);
}

export type ElementPatch = { elementId: string; patch: Record<string, unknown> };

/**
 * A commit through the locked path, as another client would make it: the
 * element's exclusive lease, then `POST /commits` with one `update_element`.
 * Resolves to the new `model_rev`; the feed broadcasts the delta.
 */
export async function peerCommit(
	api: APIRequestContext,
	projectId: string,
	{ elementId, patch }: ElementPatch
): Promise<number> {
	const base = `projects/${projectId}`;
	const baseRev = await headRev(api, projectId);
	const lock = await api.post(`${base}/locks`, {
		data: { targets: [{ resource_id: elementId, mode: 'exclusive' }], intent: 'edit' }
	});
	expect(lock.ok(), await lock.text()).toBeTruthy();
	const { token } = (await lock.json()) as { token: string };
	const commit = await api.post(`${base}/commits`, {
		data: {
			base_rev: baseRev,
			ops: [{ kind: 'update_element', id: elementId, properties_patch: patch }],
			message: 'peer edit',
			lock_tokens: [token],
			ack_errors: true
		}
	});
	expect(commit.ok(), await commit.text()).toBeTruthy();
	return ((await commit.json()) as { model_rev: number }).model_rev;
}

/**
 * A batch through the legacy unlocked path: journaled like a commit, but the
 * feed is not told. Resolves to the new `model_rev`.
 */
export async function silentBump(
	api: APIRequestContext,
	projectId: string,
	{ elementId, patch }: ElementPatch
): Promise<number> {
	const res = await api.post(`projects/${projectId}/model/ops`, {
		data: {
			base_rev: await headRev(api, projectId),
			ops: [{ kind: 'update_element', id: elementId, properties_patch: patch }]
		}
	});
	expect(res.ok(), await res.text()).toBeTruthy();
	return ((await res.json()) as { model_rev: number }).model_rev;
}
