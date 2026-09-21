import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('elements, pages, relationships and the summary read as the routes answer', () => {
	const fixture = loadFixture<StepsFixture>('read_pages');

	it('step by step, before and after churn', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
