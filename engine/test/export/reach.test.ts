import { afterAll, describe, expect, it } from 'vitest';
import {
	drain,
	EVALUATIONS,
	type CommittedArtifact,
	type EvalContext,
	type ExportFileResult,
	type ReadParams,
	type ScriptReader
} from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';
import { filled as scripted } from '../evaluate/filled.ts';
import { nodeScriptHost } from '../../node/script-host.ts';
import { exportFixture, joinedParts } from './xlsx-sample.ts';

const CONTEXT = { date: '20240229', project: 'p' };

const host = nodeScriptHost();
afterAll(() => host.dispose());

const filled = <T = unknown>(ctx: EvalContext, method: string, params: ReadParams) =>
	scripted<T>(host, ctx, method, params);

const draft = (entries: object[]): ReadParams => ({
	definition: { schema_version: 1, output: {}, entries },
	...CONTEXT
});

describe('an export that reaches a script is filled', () => {
	it('runs a transform: the identity leaves the file as it is, and a run with one entry carrying it is filled', async () => {
		const { ctx } = exportFixture();
		const transform = { definition: { code: 'def transform(doc):\n    return doc\n' } };
		const table = {
			row_source: { kind: 'scope', types: ['Block'] },
			columns: [{ kind: 'element' }]
		};
		const body = (extra: object) => ({
			definition: { ...table, ...extra },
			format: 'jsonl',
			...CONTEXT
		});
		const plain = (await filled(ctx, 'exportTable', body({}))) as ExportFileResult;
		const through = (await filled(ctx, 'exportTable', body({ transform }))) as ExportFileResult;
		expect(joinedParts(through)).toEqual(joinedParts(plain));

		const entry = (format: string) => ({ source: { ref: 't_blocks' }, format });
		const run = (await filled(
			ctx,
			'runExporterDraft',
			draft([entry('csv'), { ...entry('jsonl'), transform }, entry('csv')])
		)) as ExportFileResult;
		expect(run.content_type).toBe('application/zip');
	}, 60_000);

	it('follows a staged navigation that gains a script step under a committed table, and its unstaging', async () => {
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
		const committed = (await filled(ctx, 'runExporterDraft', params)) as ExportFileResult;
		expect(committed.content_type).toBe('application/zip');

		const script = ctx.artifacts.resolve('n_script')!.payload as CommittedArtifact['payload'];
		ctx.artifacts.setStaged([{ op: 'update', id: 'n_links', payload: script }]);
		const staged = (await filled(ctx, 'runExporterDraft', params)) as ExportFileResult;
		expect(joinedParts(staged)).not.toEqual(joinedParts(committed));

		ctx.artifacts.setStaged([]);
		const again = (await filled(ctx, 'runExporterDraft', params)) as ExportFileResult;
		expect(joinedParts(again)).toEqual(joinedParts(committed));
	}, 60_000);

	it('an internal error in an entry with a transform throws at once', () => {
		const { ctx } = exportFixture();
		const transform = { definition: { code: 'def transform(doc):\n    return doc\n' } };
		const entry = { source: { ref: 't_blocks' }, format: 'json', transform };
		let reads = 0;
		const scripts: ScriptReader = {
			read: () => {
				reads++;
				throw new Error('boom');
			}
		};
		const error = thrown(() =>
			drain(
				EVALUATIONS.runExporterDraft!(
					{ ...ctx, scripts },
					draft([entry, { ...entry, name: 'second' }])
				)
			)
		);
		expect(error).toMatchObject({ message: 'boom' });
		expect(reads).toBe(1);
	});
});
