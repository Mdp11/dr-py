import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stageSnippetOps } from '../snippet-stage';
import * as checkout from '../checkout.svelte';
import { getStagedOps, resetModelStore, seedElements } from '../model.svelte';
import type { SnippetRunOut } from '$lib/api/snippets';
import { EL } from './fixtures';

function runOut(ops: SnippetRunOut['ops'], overrides: Partial<SnippetRunOut> = {}): SnippetRunOut {
	return {
		run_id: 'r-1',
		stdout: '',
		result_repr: null,
		ops,
		error: null,
		duration_ms: 1,
		model_rev: 0,
		stale: false,
		truncated: false,
		...overrides
	};
}

const UPDATE = [
	{ kind: 'update_element', id: 'e1', properties_patch: { name: 'X' } }
] as SnippetRunOut['ops'];

beforeEach(() => {
	seedElements([EL]);
	vi.spyOn(checkout, 'ensureCheckout').mockResolvedValue({ ok: true } as never);
});
afterEach(() => {
	resetModelStore();
	vi.restoreAllMocks();
});

describe('stageSnippetOps (wrapper over stageProposedOps)', () => {
	it('refuses empty batches', async () => {
		expect(await stageSnippetOps(runOut([]))).toEqual({ ok: false, reason: 'empty' });
	});

	it('refuses a run the server flagged stale, or whose rev moved', async () => {
		expect(await stageSnippetOps(runOut(UPDATE, { stale: true }))).toEqual({
			ok: false,
			reason: 'stale'
		});
		expect(await stageSnippetOps(runOut(UPDATE, { model_rev: 99 }))).toEqual({
			ok: false,
			reason: 'stale'
		});
		expect(getStagedOps()).toHaveLength(0);
	});

	it('stages a fresh run', async () => {
		expect(await stageSnippetOps(runOut(UPDATE))).toEqual({ ok: true, count: 1 });
		expect(getStagedOps()).toHaveLength(1);
	});
});
