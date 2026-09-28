import { describe, expect, it } from 'vitest';
import { inlineTransformMarker, renderManifest } from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

const fixture = loadFixture<StepsFixture>('export_bytes');

/** The fixture's model and artifact steps, and its `run_*` cases. */
const run: StepsFixture = {
	...fixture,
	steps: fixture.steps.filter((step) => step.case === undefined || step.case.startsWith('run_'))
};

describe('runExporter and runExporterDraft answer /exports/run as the route does', () => {
	it('replays every run case', () => {
		expect(run.steps.filter((step) => step.case !== undefined)).toHaveLength(41);
		replaySteps(run);
	});
});

describe('the manifest', () => {
	// `hashlib.sha256(code.encode()).hexdigest()[:12]`, as `inline_transform_marker` writes it.
	it('marks an inline transform as the oracle does', () => {
		expect(inlineTransformMarker('def transform(doc):\n    return doc\n')).toBe(
			'inline:651c2b25f971'
		);
		expect(inlineTransformMarker('x = "日本 é"\n')).toBe('inline:fab7324b3569');
	});

	// `build_manifest(...)` for the same arguments, decoded.
	it('writes build_manifest’s bytes', () => {
		const text = new TextDecoder().decode(
			renderManifest({
				projectId: 'p',
				artifactId: null,
				artifactName: '日本',
				modelRev: 7,
				entries: [
					{
						name: 'n',
						table_ref: 't',
						table_name: 'T',
						format: 'json',
						truncated: true,
						degraded: false,
						files: [],
						transform: 'inline:abc'
					},
					{
						name: 'm',
						table_ref: 't2',
						table_name: 'T2',
						format: 'csv',
						truncated: false,
						degraded: false,
						files: ['a/b.csv', 'c.csv'],
						transform: null
					}
				]
			})
		);
		expect(text).toBe(
			'{\n  "manifest_version": 1,\n  "project_id": "p",\n  "artifact_id": null,\n  "artifact_name": "日本",\n  "model_rev": 7,\n  "truncated": true,\n  "degraded": false,\n  "entries": [\n    {\n      "name": "n",\n      "table_ref": "t",\n      "table_name": "T",\n      "format": "json",\n      "truncated": true,\n      "degraded": false,\n      "files": [],\n      "transform": "inline:abc"\n    },\n    {\n      "name": "m",\n      "table_ref": "t2",\n      "table_name": "T2",\n      "format": "csv",\n      "truncated": false,\n      "degraded": false,\n      "files": [\n        "a/b.csv",\n        "c.csv"\n      ],\n      "transform": null\n    }\n  ]\n}'
		);
	});
});
