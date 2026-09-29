import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { drain, modelDigest, modelFileSteps, WorkingCopy, type StageResult } from '$engine';
import { EngineGoneError } from '$lib/engine/client';
import { createEngineSeam } from '$lib/engine/seam';
import { createShadow } from '$lib/engine/shadow';
import { SURFACES } from '$lib/engine/surfaces';
import {
	fakeProject,
	syncOver,
	type FakeProject
} from '$lib/engine/__tests__/support/project-server';
import { setActiveBaseUrl, setActiveProjectId } from '../client';
import { installEngineSeam, type EngineSeam, type Side, type Surface } from '../engine-route';
import { downloadDigest, downloadModel } from '../model-read';
import { server } from './server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const made: ReturnType<typeof syncOver>[] = [];

afterEach(() => {
	installEngineSeam(null);
	setActiveBaseUrl(null);
	setActiveProjectId(null);
	for (const over of made.splice(0)) over.dispose();
});

/** The bytes `GET /model/download` gives for the fake's own model, rendered by the engine directly. */
function direct(project: FakeProject): Uint8Array {
	const wc = new WorkingCopy(project.model, {
		rev: project.rev,
		digest: modelDigest(project.model)
	});
	return bytesOf(drain(modelFileSteps(wc)).parts);
}

const bytesOf = (parts: readonly ArrayBuffer[]) =>
	new Uint8Array(parts.flatMap((part) => [...new Uint8Array(part)]));

const blobBytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/**
 * A ready replica of `project` behind a seam with `download` on `side` and
 * every other surface on the server; `GET /model/download` answers what
 * `body` gives (the direct bytes by default) and counts its requests.
 */
async function over(
	project: FakeProject,
	side: Side,
	shadow?: EngineSeam['shadow'],
	body: () => Response = () => served(direct(project))
) {
	const downloads: Request[] = [];
	server.use(
		...project.handlers(),
		http.get(`${project.baseUrl}/model/download`, ({ request }) => {
			downloads.push(request);
			return body();
		})
	);
	const replica = syncOver(project);
	made.push(replica);
	replica.sync.open(project.projectId);
	await replica.sync.settled();
	expect(replica.sync.status()).toMatchObject({ phase: 'ready', rev: project.rev });
	const call = vi.fn(
		(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> =>
			replica.sync.call(method, params, options)
	);
	const surfaces = Object.fromEntries(
		SURFACES.map((surface) => [surface, surface === 'download' ? side : 'server'])
	) as Record<Surface, Side>;
	installEngineSeam(
		createEngineSeam(
			{ status: () => replica.sync.status(), call: call as typeof replica.sync.call },
			surfaces,
			shadow
		)
	);
	setActiveBaseUrl(project.baseUrl);
	setActiveProjectId(project.projectId);
	return { replica, call, downloads };
}

/** The server's answer carrying `bytes`, with the route's headers. */
const served = (bytes: Uint8Array) =>
	new HttpResponse(bytes, {
		headers: {
			'content-type': 'application/json',
			'content-disposition': 'attachment; filename="model.json"'
		}
	});

/** A shadow that reports into `lines`, with an edit staged as far as it can tell; `done()` awaits the last probe. */
function recording(project: FakeProject) {
	const lines: string[] = [];
	let last: Promise<void> = Promise.resolve();
	const shadow: NonNullable<EngineSeam['shadow']> = (probe) => {
		last = Promise.resolve(
			createShadow({
				rev: () => project.rev,
				quiet: () => Promise.resolve(),
				staged: () => true,
				report: (line) => lines.push(line)
			})(probe)
		);
		return last;
	};
	return { lines, shadow, done: () => last };
}

/** Stages a rename in the replica: its working copy then differs from the committed model. */
async function stageRename(replica: ReturnType<typeof syncOver>) {
	await replica.link!.client.call<StageResult>('stage', {
		ops: [{ kind: 'update_element', id: 'e_000031', properties_patch: { name: 'staged' } }]
	});
}

describe('the download surface on the engine', () => {
	it('answers the engine’s committed bytes as an application/json Blob and asks the server nothing', async () => {
		const project = fakeProject();
		const { replica, call, downloads } = await over(project, 'engine');
		await stageRename(replica);

		const blob = await downloadModel();

		expect(call).toHaveBeenCalledOnce();
		expect(call.mock.calls[0]!.slice(0, 2)).toEqual(['downloadModel', {}]);
		expect(await blobBytes(blob)).toEqual(direct(project));
		expect(blob.type).toBe('application/json');
		expect(downloads).toEqual([]);
	});

	it('an engine that is gone is answered by the server', async () => {
		const project = fakeProject();
		const { call, downloads } = await over(project, 'engine', undefined, () =>
			served(new TextEncoder().encode('{"served": true}'))
		);
		call.mockRejectedValueOnce(new EngineGoneError());

		const blob = await downloadModel();

		expect(call).toHaveBeenCalledOnce();
		expect(new TextDecoder().decode(await blobBytes(blob))).toBe('{"served": true}');
		expect(downloads).toHaveLength(1);
	});

	it('the shadow compares while an edit is staged: the same bytes are not reported', async () => {
		const project = fakeProject();
		const { lines, shadow, done } = recording(project);
		const { replica, downloads } = await over(project, 'engine', shadow);
		await stageRename(replica);

		await downloadModel();
		await done();

		expect(downloads).toHaveLength(1);
		expect(lines).toEqual([]);
	});

	it('the shadow reports one line for a single byte off', async () => {
		const project = fakeProject();
		const { lines, shadow, done } = recording(project);
		const { replica } = await over(project, 'engine', shadow, () => {
			const bytes = direct(project);
			bytes[bytes.length - 1] = '!'.charCodeAt(0);
			return served(bytes);
		});
		await stageRename(replica);

		await downloadModel();
		await done();

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^\[shadow\] download downloadModel \{\}: /);
	});

	it('a 409 on the server ends the comparison silently', async () => {
		const project = fakeProject();
		const { lines, shadow, done } = recording(project);
		const { downloads } = await over(project, 'engine', shadow, () =>
			HttpResponse.json({ detail: 'stale' }, { status: 409 })
		);

		await downloadModel();
		await done();

		expect(downloads).toHaveLength(1);
		expect(lines).toEqual([]);
	});
});

describe('the download surface on the server', () => {
	it('only the server is asked, and its body is the Blob', async () => {
		const project = fakeProject();
		const { call, downloads } = await over(project, 'server');

		const blob = await downloadModel();

		expect(call).not.toHaveBeenCalled();
		expect(downloads).toHaveLength(1);
		expect(await blobBytes(blob)).toEqual(direct(project));
	});
});

describe('downloadDigest', () => {
	it('is the media type without parameters, the size and the SHA-256 in hex', async () => {
		const blob = new Blob(['abc'], { type: 'application/json; charset=utf-8' });

		expect(await downloadDigest(blob)).toEqual({
			type: 'application/json',
			size: 3,
			sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		});
	});
});
