import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('rules reach what the oracle reaches', () => {
	const fixture = loadFixture<StepsFixture>('rules_reach');

	it('paths in both directions, from any id, and dirty sets widened by it', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
