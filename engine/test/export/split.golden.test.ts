import { describe, expect, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

const fixture = loadFixture<StepsFixture>('export_bytes');

/** The fixture's model and artifact steps, and its `split_*` cases. */
const split: StepsFixture = {
	...fixture,
	steps: fixture.steps.filter((step) => step.case === undefined || step.case.startsWith('split_'))
};

describe('exportTable answers a json_split export as a zip, entry for entry', () => {
	it('replays every split case', () => {
		expect(split.steps.filter((step) => step.case !== undefined)).toHaveLength(24);
		replaySteps(split);
	});

	it('replays every split case over staged artifacts', () => {
		replaySteps(split, {}, 'staged');
	});
});
