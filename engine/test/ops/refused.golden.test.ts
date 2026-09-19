import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('a refused batch leaves no trace, on the oracle as in the engine', () => {
	const fixture = loadFixture<StepsFixture>('ops_refused');

	it('step by step: refusal texts, state, indexes, digest', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
