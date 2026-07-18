import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as snippetsApi from '$lib/api/snippets';
import { ensureSnippetDocs, getSnippetDocs, resetSnippetDocs } from '../snippet-docs.svelte';

const DOCS = {
	facade: [],
	limits: {
		wall_timeout_s: 10,
		memory_bytes: 1,
		stdout_bytes: 1,
		result_repr_bytes: 1,
		max_ops: 1,
		max_op_bytes: 1,
		page_limit: 1
	},
	notes: []
};

describe('snippet-docs store', () => {
	beforeEach(() => {
		resetSnippetDocs();
		vi.restoreAllMocks();
	});

	it('fetches once and caches', async () => {
		const spy = vi.spyOn(snippetsApi, 'getSnippetDocs').mockResolvedValue(DOCS);
		await ensureSnippetDocs();
		await ensureSnippetDocs();
		expect(spy).toHaveBeenCalledTimes(1);
		expect(getSnippetDocs()).toEqual(DOCS);
	});

	it('degrades silently on fetch failure and can retry after reset', async () => {
		const spy = vi.spyOn(snippetsApi, 'getSnippetDocs').mockRejectedValue(new Error('boom'));
		await ensureSnippetDocs();
		expect(getSnippetDocs()).toBeNull();
		resetSnippetDocs();
		spy.mockResolvedValue(DOCS);
		await ensureSnippetDocs();
		expect(getSnippetDocs()).toEqual(DOCS);
	});

	it('coalesces concurrent ensures into one fetch', async () => {
		let resolve!: (d: typeof DOCS) => void;
		const spy = vi
			.spyOn(snippetsApi, 'getSnippetDocs')
			.mockReturnValue(new Promise((r) => (resolve = r)));
		const a = ensureSnippetDocs();
		const b = ensureSnippetDocs();
		resolve(DOCS);
		await Promise.all([a, b]);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(getSnippetDocs()).toEqual(DOCS);
	});
});
