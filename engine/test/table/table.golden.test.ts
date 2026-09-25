import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('evaluateTable answers as POST /tables/evaluate does', () => {
	it('every page, column kind and mode, cell cap, cut build, sort and refusal', () => {
		replaySteps(loadFixture<StepsFixture>('table_eval'));
	});
});
