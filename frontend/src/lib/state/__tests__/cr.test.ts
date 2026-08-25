import { describe, expect, it } from 'vitest';
import type { Element, Relationship } from '$lib/api/types';
import {
	composeCrFilename,
	crPrestate,
	crToDiff,
	invertChangeRequest,
	type ChangeRequest
} from '../cr';

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

/** A `datarover.cr/v1` document with the named op buckets filled in. */
function crDoc(ops: {
	elements?: Partial<ChangeRequest['ops']['elements']>;
	relationships?: Partial<ChangeRequest['ops']['relationships']>;
}): ChangeRequest {
	return {
		format: 'datarover.cr/v1',
		createdAt: '2026-05-28T14:30:22.123Z',
		baseline: { filename: 'base.json', elementCount: 2, relationshipCount: 1 },
		ops: {
			elements: { added: [], modified: [], deleted: [], ...ops.elements },
			relationships: { added: [], modified: [], deleted: [], ...ops.relationships }
		}
	};
}

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

describe('invertChangeRequest', () => {
	it('swaps added/deleted and before/after, keeping the envelope', () => {
		const cr = crDoc({
			elements: {
				added: [el('c')],
				modified: [{ id: 'a', before: el('a', { n: 1 }), after: el('a', { n: 2 }) }],
				deleted: [el('b')]
			},
			relationships: { added: [rel('r2', 'a', 'c')], deleted: [rel('r1', 'a', 'b')] }
		});
		const inv = invertChangeRequest(cr);
		expect(inv.format).toBe('datarover.cr/v1');
		expect(inv.createdAt).toBe(cr.createdAt);
		expect(inv.baseline).toEqual(cr.baseline);
		expect(inv.ops.elements.added.map((e) => e.id)).toEqual(['b']);
		expect(inv.ops.elements.deleted.map((e) => e.id)).toEqual(['c']);
		expect(inv.ops.elements.modified).toEqual([
			{ id: 'a', before: el('a', { n: 2 }), after: el('a', { n: 1 }) }
		]);
		expect(inv.ops.relationships.added.map((r) => r.id)).toEqual(['r1']);
		expect(inv.ops.relationships.deleted.map((r) => r.id)).toEqual(['r2']);
		expect(invertChangeRequest(inv)).toEqual(cr);
	});
});

describe('crToDiff', () => {
	it('flattens the six op buckets into per-kind diff entries', () => {
		const cr = crDoc({
			elements: {
				added: [el('c')],
				modified: [{ id: 'a', before: el('a', { n: 1 }), after: el('a', { n: 2 }) }],
				deleted: [el('b')]
			},
			relationships: {
				added: [rel('r3', 'a', 'c')],
				modified: [
					{
						id: 'r2',
						before: rel('r2', 'a', 'b', { w: 1 }),
						after: rel('r2', 'b', 'a', { w: 1 })
					}
				],
				deleted: [rel('r1', 'a', 'b')]
			}
		});
		const diff = crToDiff(cr);
		expect(diff.counts).toEqual({ added: 2, modified: 2, deleted: 2 });
		expect(diff.elements.map((d) => [d.id, d.status])).toEqual([
			['c', 'added'],
			['a', 'modified'],
			['b', 'deleted']
		]);
		expect(diff.elements[1].modifiedFields).toEqual(['n']);
		const r2 = diff.relationships.find((d) => d.id === 'r2')!;
		expect(r2.status).toBe('modified');
		expect(r2.modifiedFields).toEqual(['source_id', 'target_id']);
	});
});

describe('crPrestate', () => {
	it('collects the before-state of modified and deleted entities only', () => {
		const cr = crDoc({
			elements: {
				added: [el('c')],
				modified: [{ id: 'a', before: el('a', { n: 1 }), after: el('a', { n: 2 }) }],
				deleted: [el('b')]
			},
			relationships: { deleted: [rel('r1', 'a', 'b')] }
		});
		expect(crPrestate(cr)).toEqual({
			elements: [el('a', { n: 1 }), el('b')],
			relationships: [rel('r1', 'a', 'b')]
		});
	});
});
