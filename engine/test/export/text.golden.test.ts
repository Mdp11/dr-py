import { describe, expect, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

const fixture = loadFixture<StepsFixture>('export_bytes');

/** The fixture's model and artifact steps, and its `text_*` cases. */
const text: StepsFixture = {
	...fixture,
	steps: fixture.steps.filter((step) => step.case === undefined || step.case.startsWith('text_'))
};

describe('exportTable and previewTableJson answer CSV, JSON and JSONL as the routes do', () => {
	it('replays every text case', () => {
		expect(text.steps.filter((step) => step.case !== undefined)).toHaveLength(69);
		replaySteps(text);
	});

	it('replays every text case over staged artifacts', () => {
		replaySteps(text, {}, 'staged');
	});
});
