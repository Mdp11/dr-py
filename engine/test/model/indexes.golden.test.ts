import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('the indexes match the oracle under churn', () => {
	const fixture = loadFixture<StepsFixture>('model_indexes');

	it('root order, uniqueness, owners, references, state order', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
