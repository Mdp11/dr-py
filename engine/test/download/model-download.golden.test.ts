import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('the model file as GET /model/download streams it', () => {
	const { runs } = loadFixture<{ runs: StepsFixture[] }>('model_download');

	it('byte for byte, over committed state, with and without ops staged', () => {
		for (const run of runs) replaySteps(run);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		for (const run of runs) replaySteps(run, { hashKey: () => 0 });
	});
});
