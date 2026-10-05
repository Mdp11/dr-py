import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { drain, modelDigest, modelFileSteps, WorkingCopy, type StageResult } from '$engine';
import { createEngineSeam } from '$lib/engine/seam';
import {
	fakeProject,
	ready,
	syncOver,
	type FakeProject
} from '$lib/engine/__tests__/support/project-server';
import { setActiveProjectId } from '../client';
import { EngineUnavailableError, installEngineSeam } from '../engine-route';
import { downloadModel } from '../model-read';
import { server } from './server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const made: ReturnType<typeof syncOver>[] = [];

afterEach(() => {
	installEngineSeam(null);
	setActiveProjectId(null);
	for (const over of made.splice(0)) over.dispose();
});

/** The bytes the download gives for the fake's own model, rendered by the engine directly. */
function direct(project: FakeProject): Uint8Array {
	const wc = new WorkingCopy(project.model, {
		rev: project.rev,
		digest: modelDigest(project.model)
	});
	return bytesOf(drain(modelFileSteps(wc)).parts);
}

function bytesOf(parts: readonly ArrayBuffer[]): Uint8Array {
	const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let at = 0;
	for (const part of parts) {
		bytes.set(new Uint8Array(part), at);
		at += part.byteLength;
	}
	return bytes;
}

const blobBytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/**
 * A ready replica of `project` behind an installed seam; `call` is the seam's
 * view of `sync.call`, spied on. MSW holds the replica's own routes and no
 * download route: a download that strays to the server fails the test.
 */
async function over(project: FakeProject) {
	server.use(...project.handlers());
	const replica = syncOver(project);
	made.push(replica);
	replica.sync.open(project.projectId);
	await replica.sync.settled();
	expect(replica.sync.status()).toMatchObject({ phase: 'ready', rev: project.rev });
	const call = vi.fn(
		(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> =>
			replica.sync.call(method, params, options)
	);
	installEngineSeam(createEngineSeam({ call: call as typeof replica.sync.call }, ready));
	setActiveProjectId(project.projectId);
	return { replica, call };
}

/** Stages a rename in the replica: its working copy then differs from the committed model. */
async function stageRename(replica: ReturnType<typeof syncOver>) {
	await replica.link!.client.call<StageResult>('stage', {
		ops: [{ kind: 'update_element', id: 'e_000031', properties_patch: { name: 'staged' } }]
	});
}

describe('the model download on the engine', () => {
	it('answers the engine’s committed bytes as an application/json Blob, staged edits left out', async () => {
		const project = fakeProject();
		const { replica, call } = await over(project);
		await stageRename(replica);

		const blob = await downloadModel();

		expect(call).toHaveBeenCalledOnce();
		expect(call.mock.calls[0]!.slice(0, 2)).toEqual(['downloadModel', {}]);
		// Compared as buffers: an element-wise diff of a whole model file is slow.
		expect(Buffer.from(await blobBytes(blob)).equals(Buffer.from(direct(project)))).toBe(true);
		expect(blob.type).toBe('application/json');
	});

	it('an engine that is gone is unavailable, and the server is not asked', async () => {
		const project = fakeProject();
		const { replica } = await over(project);
		replica.link!.dispose();

		await expect(downloadModel()).rejects.toBeInstanceOf(EngineUnavailableError);
		await replica.sync.settled();
	});
});
