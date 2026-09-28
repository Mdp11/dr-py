import { describe, expect, it } from 'vitest';
import {
	drain,
	EVALUATIONS,
	ReadError,
	type CommittedArtifact,
	type EvalContext,
	type ExportFileResult,
	type ReadParams
} from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';
import { exportFixture, joinedParts, type SetupStep } from './xlsx-sample.ts';

const CONTEXT = { date: '20240229', project: 'p' };

const paramsOf = (step: SetupStep): ReadParams =>
	step.do === 'read' ? step.params! : { ...step.body!, date: step.date!, project: 'p' };

/** What an evaluation throws when called, before any step: its generator is never started. */
function refusedUpFront(ctx: EvalContext, method: string, params: ReadParams): unknown {
	return thrown(() => EVALUATIONS[method]!(ctx, params));
}

/** A 501 `reaches a script`, as a `ReadError`. */
function expectReaches(error: unknown, label?: string): void {
	expect(error, label).toBeInstanceOf(ReadError);
	const { status, detail } = error as ReadError;
	expect({ status, detail }, label).toEqual({ status: 501, detail: 'reaches a script' });
}

const draft = (entries: object[]): ReadParams => ({
	definition: { schema_version: 1, output: {}, entries },
	...CONTEXT
});

describe('an export that reaches a script refuses with 501 before its first step', () => {
	it('refuses every reach case of export_bytes', () => {
		const { ctx, cases } = exportFixture();
		const reach = cases.filter((step) => step.case!.startsWith('reach_'));
		expect(reach).toHaveLength(15);
		for (const step of reach) {
			expectReaches(refusedUpFront(ctx, step.method!, paramsOf(step)), step.case);
		}
	});

	it('refuses a run whose one entry of five carries an inline transform', () => {
		const { ctx } = exportFixture();
		const entry = (format: string) => ({ source: { ref: 't_blocks' }, format });
		const params = draft([
			entry('csv'),
			entry('json'),
			entry('xlsx'),
			{
				...entry('jsonl'),
				transform: { definition: { code: 'def transform(doc):\n    return doc\n' } }
			},
			entry('csv')
		]);
		expectReaches(refusedUpFront(ctx, 'runExporterDraft', params));
		// Without it the same run is the engine's.
		const plain = draft([entry('csv'), entry('json'), entry('xlsx'), entry('jsonl'), entry('csv')]);
		const result = drain(EVALUATIONS.runExporterDraft!(ctx, plain)) as ExportFileResult;
		expect(result.content_type).toBe('application/zip');
	});

	it('follows a staged navigation that gains a script step under a committed table, and its unstaging', () => {
		const { ctx } = exportFixture();
		const table: CommittedArtifact = {
			id: 't_nav',
			kind: 'table',
			name: 'Linked',
			rev: 1,
			payload: {
				row_source: { kind: 'scope', types: ['Block'] },
				columns: [{ kind: 'element' }, { kind: 'navigation', navigation: { ref: 'n_links' } }]
			} as unknown as CommittedArtifact['payload']
		};
		ctx.artifacts.put([table], []);
		const params = draft([
			{ source: { ref: 't_blocks' }, format: 'csv' },
			{ source: { ref: 't_nav' }, format: 'json' }
		]);
		const committed = drain(EVALUATIONS.runExporterDraft!(ctx, params)) as ExportFileResult;
		expect(committed.content_type).toBe('application/zip');

		const script = ctx.artifacts.resolve('n_script')!.payload as CommittedArtifact['payload'];
		ctx.artifacts.setStaged([{ op: 'update', id: 'n_links', payload: script }]);
		expectReaches(refusedUpFront(ctx, 'runExporterDraft', params));

		ctx.artifacts.setStaged([]);
		const again = drain(EVALUATIONS.runExporterDraft!(ctx, params)) as ExportFileResult;
		expect(joinedParts(again)).toEqual(joinedParts(committed));
	});
});
