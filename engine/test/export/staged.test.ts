import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
	ArtifactSet,
	drain,
	EVALUATIONS,
	Model,
	TableOrderCache,
	ViewPlacements,
	type CommittedArtifact,
	type EvalContext,
	type ExportFileResult
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';
import { nodeMetamodel } from '../model/fixtures.ts';
import { joinedParts } from './xlsx-sample.ts';
import { NO_SCRIPTS } from '../../src/evaluate/fill.ts';

const fixture = loadFixture<StepsFixture>('export_bytes');

/** The fixture's model and artifact steps, and its `run_*` and `text_*` cases. */
const runAndText: StepsFixture = {
	...fixture,
	steps: fixture.steps.filter(
		(step) =>
			step.case === undefined || step.case.startsWith('run_') || step.case.startsWith('text_')
	)
};

describe('exports over staged artifacts', () => {
	it('replays every run and text case with the artifacts staged', () => {
		expect(runAndText.steps.filter((step) => step.case !== undefined)).toHaveLength(110);
		replaySteps(runAndText, {}, 'staged');
	});

	type Payload = CommittedArtifact['payload'];

	const TABLE = {
		row_source: { kind: 'scope', types: ['Node'] },
		columns: [{ kind: 'element', header: 'Node' }]
	};
	const STAGED_TABLE = {
		...TABLE,
		columns: [...TABLE.columns, { kind: 'property', name: 'name', header: 'Staged column' }]
	};
	const exporter = (format: string) => ({
		schema_version: 1,
		output: {},
		entries: [{ source: { ref: 't1' }, format }]
	});

	function staged(): EvalContext {
		const model = new Model(nodeMetamodel());
		for (const id of ['a', 'b'])
			model.setProperty(model.createElement('Node', id), 'name', `N-${id}`);
		const artifacts = new ArtifactSet();
		artifacts.setCommitted([
			{ id: 't1', kind: 'table', name: 'Table', rev: 1, payload: TABLE as unknown as Payload },
			{
				id: 'x1',
				kind: 'exporter',
				name: 'Committed name',
				rev: 1,
				payload: exporter('csv') as unknown as Payload
			}
		]);
		artifacts.setStaged([
			{ op: 'update', id: 't1', payload: STAGED_TABLE as unknown as Payload },
			{
				op: 'update',
				id: 'x1',
				name: 'Staged name',
				payload: exporter('json') as unknown as Payload
			}
		]);
		return {
			model,
			artifacts,
			placements: new ViewPlacements(),
			scripts: NO_SCRIPTS,
			working: { rev: 7, stagedVersion: 3, tableOrders: new TableOrderCache() }
		};
	}

	it('runs a staged exporter over a staged table edit, at the committed rev', () => {
		const ctx = staged();
		const result = drain(
			EVALUATIONS.runExporter!(ctx, { artifact_id: 'x1', date: '20240229', project: 'p' })
		) as ExportFileResult;
		expect(result.filename).toBe('Staged name.zip');
		const members = unzipSync(joinedParts(result));
		expect(Object.keys(members)).toEqual(['manifest.json', 'Table.json']);
		const text = (path: string) => new TextDecoder().decode(members[path]);
		expect(JSON.parse(text('Table.json'))).toEqual([
			{ Node: 'N-a', 'Staged column': 'N-a' },
			{ Node: 'N-b', 'Staged column': 'N-b' }
		]);
		const manifest = JSON.parse(text('manifest.json'));
		expect(manifest).toMatchObject({
			artifact_id: 'x1',
			artifact_name: 'Staged name',
			model_rev: 7,
			entries: [{ name: 'Table', table_ref: 't1', format: 'json', files: ['Table.json'] }]
		});

		ctx.artifacts.setStaged([]);
		const committed = drain(
			EVALUATIONS.runExporter!(ctx, { artifact_id: 'x1', date: '20240229', project: 'p' })
		) as ExportFileResult;
		expect(committed.filename).toBe('Committed name.zip');
		const csv = new TextDecoder().decode(unzipSync(joinedParts(committed))['Table.csv']);
		expect(csv).toBe('Node\r\nN-a\r\nN-b\r\n');
	});
});
