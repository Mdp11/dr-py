import { describe, expect, it } from 'vitest';
import {
	drain,
	EVALUATIONS,
	readExporterDefinition,
	ReadError,
	type CommittedArtifact,
	type ReadParams
} from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';
import { exportFixture } from './xlsx-sample.ts';

const CONTEXT = { date: '20240229', project: 'p' };

const entry = (ref: string, fields: object = {}) => ({ source: { ref }, ...fields });

const draft = (...entries: object[]): ReadParams => ({
	definition: { schema_version: 1, output: {}, entries },
	...CONTEXT
});

/** What a run refuses with, its steps drained. */
function refusal(params: ReadParams): { status: number; detail: string } {
	const { ctx } = exportFixture();
	const table: CommittedArtifact = {
		id: 't_badnav',
		kind: 'table',
		name: 't_badnav',
		rev: 1,
		payload: {
			row_source: { kind: 'scope', types: ['Block'] },
			columns: [{ kind: 'element' }, { kind: 'navigation', navigation: { ref: 'gone_nav' } }]
		} as unknown as CommittedArtifact['payload']
	};
	ctx.artifacts.put([table], []);
	const error = thrown(() => drain(EVALUATIONS.runExporterDraft!(ctx, params)));
	expect(error).toBeInstanceOf(ReadError);
	const { status, detail } = error as ReadError;
	return { status, detail };
}

describe('runExporterDraft refuses as the route does', () => {
	// Both texts are the oracle's for the same runs.
	it("refuses an entry's table that does not resolve at that entry's turn", () => {
		const objectShape = entry('t_blocks', { format: 'json', json_doc: { shape: 'object' } });
		const badNav = entry('t_badnav', { format: 'csv' });
		expect(refusal(draft(objectShape, badNav))).toEqual({
			status: 422,
			detail: "t_blocks: json_doc.shape 'object' requires key_column"
		});
		expect(refusal(draft(badNav, objectShape))).toEqual({
			status: 422,
			detail: 'unknown artifact gone_nav'
		});
	});

	it('refuses both or neither of artifact_id and definition', () => {
		const one = draft(entry('t_blocks', { format: 'csv' }));
		for (const params of [{ ...one, artifact_id: 'x_full' }, CONTEXT]) {
			expect(refusal(params)).toEqual({
				status: 422,
				detail: 'exactly one of artifact_id and definition is required'
			});
		}
	});
});

describe('readExporterDefinition', () => {
	const read = (raw: unknown) => thrown(() => readExporterDefinition(raw, 'definition'));

	it('fills the defaults', () => {
		expect(readExporterDefinition({ entries: [entry('t')] }, 'definition')).toEqual({
			schema_version: 1,
			output: { mode: 'zip', filename: '', manifest: true },
			entries: [
				{
					source: { ref: 't' },
					name: '',
					folder: '',
					split_folder: true,
					format: 'xlsx',
					columns: [],
					export_order: [],
					show_row_numbers: false,
					export_row_number: null,
					json_split: null,
					json_doc: null,
					transform: null
				}
			]
		});
	});

	it('holds at most 50 entries', () => {
		expect(read({ entries: Array.from({ length: 50 }, () => entry('t')) })).toBeUndefined();
		expect(read({ entries: Array.from({ length: 51 }, () => entry('t')) })).toBeInstanceOf(
			ReadError
		);
	});

	it('refuses what pydantic refuses, with 422', () => {
		for (const raw of [
			{ entries: [{ source: {} }] },
			{ entries: [entry('t', { transform: { ref: 's', definition: { code: 'x' } } })] },
			{ entries: [entry('t', { transform: { definition: {} } })] },
			{ entries: [entry('t', { columns: [{ index: -1 }] })] },
			{ entries: [entry('t', { json_doc: { shape: 'x' } })] },
			{ output: { mode: 'x' }, entries: [] },
			{ output: null, entries: [] }
		]) {
			const error = read(raw);
			expect(error, JSON.stringify(raw)).toBeInstanceOf(ReadError);
			expect((error as ReadError).status).toBe(422);
		}
	});
});
