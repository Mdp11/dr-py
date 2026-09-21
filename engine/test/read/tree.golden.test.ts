import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('the containment tree reads as the routes answer', () => {
	const fixture = loadFixture<StepsFixture>('read_tree');

	it('roots, children, tree items and the excluded pool, before and after churn', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
