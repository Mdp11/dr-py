import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('the op applier follows the oracle through a random walk of batches', () => {
	const fixture = loadFixture<StepsFixture>('ops_churn');

	it('step by step: outcomes, refusal texts, state, indexes, digest', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
