import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('the applier collects the dirty sets the oracle collects', () => {
	const fixture = loadFixture<StepsFixture>('validation_dirty');

	it('every op kind, hints and restore mode, in the order collected', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
