import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('the issue store keeps what the oracle keeps', () => {
	const [plain, ruled] = loadFixture<{ runs: StepsFixture[] }>('validation_steps').runs;

	it('seeded by a sweep, spliced by every batch, read as GET /model/issues', () => {
		replaySteps(plain!);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(plain!, { hashKey: () => 0 });
	});

	it('with rules: far edits reached, rule sets swapped, a strict preview blocked by a far rule', () => {
		replaySteps(ruled!);
	});
});
