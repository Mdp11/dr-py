import { describe, expect, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

const fixture = loadFixture<StepsFixture>('export_bytes');

/** The fixture's model and artifact steps, and its `xlsx_*` cases. */
const xlsx: StepsFixture = {
	...fixture,
	steps: fixture.steps.filter((step) => step.case === undefined || step.case.startsWith('xlsx_'))
};

describe('exportTable answers an xlsx export whose grid openpyxl reads as the oracle wrote it', () => {
	it('replays every xlsx case', () => {
		expect(xlsx.steps.filter((step) => step.case !== undefined)).toHaveLength(9);
		replaySteps(xlsx);
	});

	it('replays every xlsx case over staged artifacts', () => {
		replaySteps(xlsx, {}, 'staged');
	});
});
