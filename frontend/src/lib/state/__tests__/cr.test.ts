import { describe, expect, it } from 'vitest';
import type { Element, ModelOut, Relationship } from '$lib/api/types';
import { buildChangeRequest, composeCrFilename } from '../cr';

function el(
	id: string,
	props: Record<string, unknown> = {},
	rev = 0,
	type_name = 'Thing'
): Element {
	return { id, type_name, properties: props, rev };
}

function rel(
	id: string,
	source_id: string,
	target_id: string,
	props: Record<string, unknown> = {},
	rev = 0,
	type_name = 'Link'
): Relationship {
	return { id, type_name, source_id, target_id, properties: props, rev };
}

function model(els: Element[], rels: Relationship[]): ModelOut {
	return { elements: els, relationships: rels };
}

const FIXED_NOW = (): Date => new Date('2026-05-28T14:30:22.123Z');

describe('buildChangeRequest', () => {
	it('produces empty op buckets when baseline and saved are identical', () => {
		const m = model([el('e1', { a: 1 })], [rel('r1', 'e1', 'e1')]);
		const cr = buildChangeRequest(m, m, 'myModel.json', FIXED_NOW);
		expect(cr.format).toBe('datarover.cr/v1');
		expect(cr.createdAt).toBe('2026-05-28T14:30:22.123Z');
		expect(cr.baseline).toEqual({
			filename: 'myModel.json',
			elementCount: 1,
			relationshipCount: 1
		});
		expect(cr.ops.elements.added).toEqual([]);
		expect(cr.ops.elements.modified).toEqual([]);
		expect(cr.ops.elements.deleted).toEqual([]);
		expect(cr.ops.relationships.added).toEqual([]);
		expect(cr.ops.relationships.modified).toEqual([]);
		expect(cr.ops.relationships.deleted).toEqual([]);
	});

	it('captures an added element with the full entity', () => {
		const before = model([], []);
		const e = el('e1', { name: 'A' });
		const after = model([e], []);
		const cr = buildChangeRequest(before, after, 'm.json', FIXED_NOW);
		expect(cr.ops.elements.added).toEqual([e]);
		expect(cr.ops.elements.modified).toEqual([]);
		expect(cr.ops.elements.deleted).toEqual([]);
	});

	it('captures a modified element with full before and after', () => {
		const eBefore = el('e1', { name: 'A' }, 1);
		const eAfter = el('e1', { name: 'B' }, 2);
		const cr = buildChangeRequest(model([eBefore], []), model([eAfter], []), 'm.json', FIXED_NOW);
		expect(cr.ops.elements.modified).toEqual([{ id: 'e1', before: eBefore, after: eAfter }]);
		expect(cr.ops.elements.added).toEqual([]);
		expect(cr.ops.elements.deleted).toEqual([]);
	});

	it('captures a deleted element with the full pre-deletion entity', () => {
		const e = el('e1', { name: 'A' });
		const cr = buildChangeRequest(model([e], []), model([], []), 'm.json', FIXED_NOW);
		expect(cr.ops.elements.deleted).toEqual([e]);
		expect(cr.ops.elements.added).toEqual([]);
		expect(cr.ops.elements.modified).toEqual([]);
	});

	it('omits modified entries when before and after are deep-equal even if rev changed', () => {
		// Characterises the buildChangeRequest -> computeDiff pass-through:
		// computeDiff does not emit a 'modified' entry when only `rev` changed,
		// so the CR should not contain one either.
		const eBefore = el('e1', { name: 'A' }, 1);
		const eAfter = el('e1', { name: 'A' }, 2);
		const cr = buildChangeRequest(model([eBefore], []), model([eAfter], []), 'm.json', FIXED_NOW);
		expect(cr.ops.elements.modified).toEqual([]);
	});

	it('captures relationship add / modify / delete with full entities', () => {
		const rBefore = rel('r1', 'a', 'b', { kind: 'x' }, 1);
		const rAfter = rel('r1', 'a', 'b', { kind: 'y' }, 2);
		const rNew = rel('r2', 'a', 'c');
		const rGone = rel('r3', 'b', 'c');
		const cr = buildChangeRequest(
			model([], [rBefore, rGone]),
			model([], [rAfter, rNew]),
			'm.json',
			FIXED_NOW
		);
		expect(cr.ops.relationships.added).toEqual([rNew]);
		expect(cr.ops.relationships.modified).toEqual([{ id: 'r1', before: rBefore, after: rAfter }]);
		expect(cr.ops.relationships.deleted).toEqual([rGone]);
	});

	it('reports baseline counts (not saved counts)', () => {
		const baseline = model([el('a'), el('b'), el('c')], [rel('r1', 'a', 'b')]);
		const saved = model([el('a'), el('b')], []); // c and r1 deleted
		const cr = buildChangeRequest(baseline, saved, 'm.json', FIXED_NOW);
		expect(cr.baseline.elementCount).toBe(3);
		expect(cr.baseline.relationshipCount).toBe(1);
	});

	it('accepts a null baseline filename', () => {
		const cr = buildChangeRequest(model([], []), model([], []), null, FIXED_NOW);
		expect(cr.baseline.filename).toBeNull();
	});

	it('uses the runtime clock when none is injected', () => {
		const cr = buildChangeRequest(model([], []), model([], []), null);
		// Should be a valid ISO 8601 timestamp ending in Z.
		expect(cr.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});
});

describe('composeCrFilename', () => {
	// 2026-05-28 14:30:22 local time. Using a UTC fixed clock would make
	// the assertion timezone-dependent; instead we build a Date from local
	// components so the assertion is stable regardless of TZ.
	const localNow = (): Date => new Date(2026, 4 /* May */, 28, 14, 30, 22, 123);

	it('strips the trailing extension from the model filename', () => {
		expect(composeCrFilename('myModel.json', localNow)).toBe('20260528T143022_myModel.cr.json');
	});

	it('keeps a filename without extension as-is for the base', () => {
		expect(composeCrFilename('myModel', localNow)).toBe('20260528T143022_myModel.cr.json');
	});

	it('falls back to "model" when filename is null', () => {
		expect(composeCrFilename(null, localNow)).toBe('20260528T143022_model.cr.json');
	});

	it('falls back to "model" when filename is an empty string', () => {
		expect(composeCrFilename('', localNow)).toBe('20260528T143022_model.cr.json');
	});

	it('strips only the last extension on a multi-dot filename', () => {
		expect(composeCrFilename('my.model.json', localNow)).toBe('20260528T143022_my.model.cr.json');
	});

	it('zero-pads single-digit timestamp components', () => {
		const padNow = (): Date => new Date(2026, 0 /* Jan */, 3, 4, 5, 6, 0);
		expect(composeCrFilename('m.json', padNow)).toBe('20260103T040506_m.cr.json');
	});

	it('uses the runtime clock when none is injected', () => {
		const out = composeCrFilename('m.json');
		expect(out).toMatch(/^\d{8}T\d{6}_m\.cr\.json$/);
	});
});

import { saveWithOptionalCr } from '../cr';
import type { ChangesDoc } from '$lib/api/types';

interface FileSaveInvocation {
	value: unknown;
	suggestedName: string;
	handle: unknown;
}

function makeFileSaveStub(): {
	stub: (
		value: unknown,
		name: string,
		handle: unknown
	) => Promise<{ filename: string; handle: null }>;
	calls: FileSaveInvocation[];
} {
	const calls: FileSaveInvocation[] = [];
	return {
		stub: async (value, suggestedName, handle) => {
			calls.push({ value, suggestedName, handle });
			return { filename: suggestedName, handle: null };
		},
		calls
	};
}

interface ResponseSaveInvocation {
	response: Response;
	suggestedName: string;
	handle: unknown;
}

function makeResponseSaveStub(): {
	stub: (
		response: Response,
		name: string,
		handle: FileSystemFileHandle | null
	) => Promise<{ filename: string; handle: FileSystemFileHandle | null }>;
	calls: ResponseSaveInvocation[];
} {
	const calls: ResponseSaveInvocation[] = [];
	return {
		stub: async (response, suggestedName, handle) => {
			calls.push({ response, suggestedName, handle });
			return { filename: suggestedName, handle };
		},
		calls
	};
}

const DOWNLOAD_RESPONSE = new Response('{"elements": [], "relationships": []}');

const CHANGES_DOC: ChangesDoc = {
	format: 'datarover.cr/v1',
	createdAt: '2026-05-28T14:30:22.000Z',
	baseline: { filename: null, elementCount: 0, relationshipCount: 0 },
	ops: {
		elements: { added: [el('e1')], modified: [], deleted: [] },
		relationships: { added: [], modified: [], deleted: [] }
	},
	complete: true
};

const NOW = (): Date => new Date(2026, 4, 28, 14, 30, 22, 0);

describe('saveWithOptionalCr', () => {
	it('streams only the model download when exportCr is false', async () => {
		const files = makeFileSaveStub();
		const responses = makeResponseSaveStub();
		let changesFetched = 0;
		const result = await saveWithOptionalCr({
			filename: 'm.json',
			fileHandle: null,
			exportCr: false,
			download: async () => DOWNLOAD_RESPONSE,
			fetchChanges: async () => {
				changesFetched++;
				return CHANGES_DOC;
			},
			saveResponseFile: responses.stub,
			saveFile: files.stub,
			now: NOW
		});
		expect(result.kind).toBe('saved');
		expect(responses.calls).toHaveLength(1);
		expect(responses.calls[0].response).toBe(DOWNLOAD_RESPONSE);
		expect(responses.calls[0].suggestedName).toBe('m.json');
		expect(files.calls).toHaveLength(0);
		expect(changesFetched).toBe(0);
	});

	it('writes model then CR when exportCr is true', async () => {
		const files = makeFileSaveStub();
		const responses = makeResponseSaveStub();
		const result = await saveWithOptionalCr({
			filename: 'myModel.json',
			fileHandle: null,
			exportCr: true,
			download: async () => DOWNLOAD_RESPONSE,
			fetchChanges: async () => CHANGES_DOC,
			saveResponseFile: responses.stub,
			saveFile: files.stub,
			now: NOW
		});
		expect(result.kind).toBe('saved');
		// Model first, with original suggested name.
		expect(responses.calls).toHaveLength(1);
		expect(responses.calls[0].suggestedName).toBe('myModel.json');
		// CR second, with the .cr.json name and a null handle (forces dialog).
		expect(files.calls).toHaveLength(1);
		expect(files.calls[0].suggestedName).toBe('20260528T143022_myModel.cr.json');
		expect(files.calls[0].handle).toBeNull();
		const written = files.calls[0].value as Record<string, unknown>;
		expect(written.format).toBe('datarover.cr/v1');
		// the transport-only `complete` flag is stripped from the file
		expect('complete' in written).toBe(false);
	});

	it('falls back to model.json when no filename is known', async () => {
		const files = makeFileSaveStub();
		const responses = makeResponseSaveStub();
		const result = await saveWithOptionalCr({
			filename: null,
			fileHandle: null,
			exportCr: false,
			download: async () => DOWNLOAD_RESPONSE,
			fetchChanges: async () => CHANGES_DOC,
			saveResponseFile: responses.stub,
			saveFile: files.stub,
			now: NOW
		});
		expect(result.kind).toBe('saved');
		expect(responses.calls[0].suggestedName).toBe('model.json');
	});

	it('reuses the existing file handle when saving the model', async () => {
		const files = makeFileSaveStub();
		const responses = makeResponseSaveStub();
		const handle = { name: 'myModel.json' } as unknown as FileSystemFileHandle;
		const result = await saveWithOptionalCr({
			filename: 'myModel.json',
			fileHandle: handle,
			exportCr: false,
			download: async () => DOWNLOAD_RESPONSE,
			fetchChanges: async () => CHANGES_DOC,
			saveResponseFile: responses.stub,
			saveFile: files.stub,
			now: NOW
		});
		expect(result.kind).toBe('saved');
		expect(responses.calls[0].handle).toBe(handle);
		if (result.kind === 'saved') {
			expect(result.savedHandle).toBe(handle);
		}
	});

	it('does not attempt the CR when the download fails', async () => {
		const files = makeFileSaveStub();
		const responses = makeResponseSaveStub();
		let changesFetched = 0;
		const result = await saveWithOptionalCr({
			filename: 'm.json',
			fileHandle: null,
			exportCr: true,
			download: async () => {
				throw new Error('boom');
			},
			fetchChanges: async () => {
				changesFetched++;
				return CHANGES_DOC;
			},
			saveResponseFile: responses.stub,
			saveFile: files.stub,
			now: NOW
		});
		expect(result).toEqual({ kind: 'save-failed', message: 'boom' });
		expect(responses.calls).toHaveLength(0);
		expect(files.calls).toHaveLength(0);
		expect(changesFetched).toBe(0);
	});

	it('does not attempt the CR when the model file write throws', async () => {
		const files = makeFileSaveStub();
		const result = await saveWithOptionalCr({
			filename: 'm.json',
			fileHandle: null,
			exportCr: true,
			download: async () => DOWNLOAD_RESPONSE,
			fetchChanges: async () => CHANGES_DOC,
			saveResponseFile: async () => {
				throw new Error('disk full');
			},
			saveFile: files.stub,
			now: NOW
		});
		expect(result).toEqual({ kind: 'save-failed', message: 'disk full' });
		expect(files.calls).toHaveLength(0);
	});

	it('treats CR write AbortError as cancellation, preserves the model save', async () => {
		const responses = makeResponseSaveStub();
		const result = await saveWithOptionalCr({
			filename: 'm.json',
			fileHandle: null,
			exportCr: true,
			download: async () => DOWNLOAD_RESPONSE,
			fetchChanges: async () => CHANGES_DOC,
			saveResponseFile: responses.stub,
			saveFile: async () => {
				throw new DOMException('user cancelled', 'AbortError');
			},
			now: NOW
		});
		expect(result.kind).toBe('saved-cr-cancelled');
		if (result.kind === 'saved-cr-cancelled') {
			expect(result.savedFilename).toBe('m.json');
		}
	});

	it('treats a CR fetch failure as cr-failed, preserves the model save', async () => {
		const responses = makeResponseSaveStub();
		const files = makeFileSaveStub();
		const result = await saveWithOptionalCr({
			filename: 'm.json',
			fileHandle: null,
			exportCr: true,
			download: async () => DOWNLOAD_RESPONSE,
			fetchChanges: async () => {
				throw new Error('changes unavailable');
			},
			saveResponseFile: responses.stub,
			saveFile: files.stub,
			now: NOW
		});
		expect(result.kind).toBe('saved-cr-failed');
		if (result.kind === 'saved-cr-failed') {
			expect(result.savedFilename).toBe('m.json');
			expect(result.message).toBe('changes unavailable');
		}
		expect(files.calls).toHaveLength(0);
	});

	it('treats a non-AbortError CR write failure as cr-failed, preserves the model save', async () => {
		const responses = makeResponseSaveStub();
		const result = await saveWithOptionalCr({
			filename: 'm.json',
			fileHandle: null,
			exportCr: true,
			download: async () => DOWNLOAD_RESPONSE,
			fetchChanges: async () => CHANGES_DOC,
			saveResponseFile: responses.stub,
			saveFile: async () => {
				throw new Error('quota exceeded');
			},
			now: NOW
		});
		expect(result.kind).toBe('saved-cr-failed');
		if (result.kind === 'saved-cr-failed') {
			expect(result.savedFilename).toBe('m.json');
			expect(result.message).toBe('quota exceeded');
		}
	});
});
