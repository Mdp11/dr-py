import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('the op applier matches the oracle', () => {
	const fixture = loadFixture<StepsFixture>('ops_batches');

	it('step by step: outcomes, refusal texts, state, indexes, digest', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
