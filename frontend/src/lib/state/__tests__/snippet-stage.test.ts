import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '$lib/api/__tests__/server';
import { stageSnippetOps } from '../snippet-stage';
import * as checkout from '../checkout.svelte';
import { adoptWorkingStamp, resetReplica } from '../replica.svelte';
import { getStagedOps, resetModelStore, stagedSettled } from '../model.svelte';
import type { SnippetRunOut } from '$lib/api/snippets';
import { engineStore, type EngineStore } from './support/engine-store';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

function runOut(ops: SnippetRunOut['ops'], overrides: Partial<SnippetRunOut> = {}): SnippetRunOut {
	return {
		stdout: '',
		result_repr: null,
		ops,
		error: null,
		duration_ms: 1,
		stamp: { rev: 0, staged: 0 },
		truncated: false,
		...overrides
	};
}

const UPDATE = [
	{ kind: 'update_element', id: 'e_000001', properties_patch: { name: 'X' } }
] as SnippetRunOut['ops'];

let store: EngineStore | null = null;

beforeEach(() => {
	vi.spyOn(checkout, 'ensureCheckout').mockResolvedValue({ ok: true } as never);
});
afterEach(() => {
	store?.dispose();
	store = null;
	resetReplica();
	resetModelStore();
	vi.restoreAllMocks();
});

describe('stageSnippetOps (wrapper over stageProposedOps)', () => {
	it('refuses empty batches', async () => {
		expect(await stageSnippetOps(runOut([]))).toEqual({ ok: false, reason: 'empty' });
	});

	it("refuses a run whose stamp is not the working copy's", async () => {
		adoptWorkingStamp({ rev: 0, staged: 1 });
		expect(await stageSnippetOps(runOut(UPDATE))).toEqual({ ok: false, reason: 'stale' });
		expect(getStagedOps()).toHaveLength(0);
	});

	it('refuses while the working stamp is unknown', async () => {
		expect(await stageSnippetOps(runOut(UPDATE))).toEqual({ ok: false, reason: 'stale' });
	});

	it('stages a run that began where the working copy stands', async () => {
		store = await engineStore();
		adoptWorkingStamp({ rev: 0, staged: 0 });
		expect(await stageSnippetOps(runOut(UPDATE))).toEqual({ ok: true, count: 1 });
		await stagedSettled();
		expect(getStagedOps()).toHaveLength(1);
	});
});
